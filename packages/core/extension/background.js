import { redactHeaders, redactNetworkBody } from "./lib/network-redact.mjs"

const NATIVE_HOST_NAME = "com.iris.host"
const KEEPALIVE_ALARM = "keepalive"
const PERMISSION_HINT = "Click the Iris extension icon and approve requested permissions."
const OPTIONAL_RUNTIME_PERMISSIONS = ["nativeMessaging", "downloads", "debugger"]
const OPTIONAL_RUNTIME_ORIGINS = ["<all_urls>"]

const runtimeManifest = chrome.runtime.getManifest()
const declaredOptionalPermissions = new Set(runtimeManifest.optional_permissions || [])
const declaredOptionalOrigins = new Set(runtimeManifest.optional_host_permissions || [])

const ALLOWLIST_STORAGE_KEY = "iris_profile_allowlist"
const PROFILE_STORAGE_KEY = "profile_id"
let profileVerified = false
let cachedProfileId = null

let port = null
let isConnected = false
let connectionAttempts = 0
let nativePermissionHintLogged = false
let reconnectTimer = null
let connectPromise = null
let lastInboundAt = 0
let sawPingOnPort = false

// Debugger state management for console/error capture
const debuggerState = new Map()
const MAX_LOG_ENTRIES = 1000
const MAX_NETWORK_ENTRIES = 1000

function normalizeAllowlist(value) {
  if (!Array.isArray(value)) return []
  return [...new Set(value.map((entry) => String(entry || "").trim().toLowerCase()).filter(Boolean))]
}

// Profile identification and verification
async function getProfileInfo() {
  if (cachedProfileId) return cachedProfileId
  
  try {
    if (chrome.identity?.getProfileUserInfo) {
      const info = await chrome.identity.getProfileUserInfo({ accountStatus: "ANY" })
      if (info?.email) {
        cachedProfileId = info.email
        return info.email
      }
    }
  } catch {}
  
  // Fallback: use stored UUID
  const stored = await chrome.storage.local.get(PROFILE_STORAGE_KEY)
  if (stored[PROFILE_STORAGE_KEY]) {
    cachedProfileId = stored[PROFILE_STORAGE_KEY]
    return stored[PROFILE_STORAGE_KEY]
  }
  
  // Generate and store new UUID
  const uuid = crypto.randomUUID()
  await chrome.storage.local.set({ [PROFILE_STORAGE_KEY]: uuid })
  cachedProfileId = uuid
  return uuid
}

async function verifyProfile() {
  if (profileVerified) return true
  const stored = await chrome.storage.local.get(ALLOWLIST_STORAGE_KEY)
  const allowlist = normalizeAllowlist(stored[ALLOWLIST_STORAGE_KEY])
  if (allowlist.length === 0) {
    profileVerified = true
    return true
  }
  const profileId = await getProfileInfo()
  const normalizedProfileId = String(profileId || "").trim().toLowerCase()
  const isAllowed = allowlist.includes(normalizedProfileId)
  if (!isAllowed) {
    console.warn(`[Iris] Profile not in allowlist: ${profileId}`)
  }
  profileVerified = isAllowed
  return isAllowed
}

async function toolGetProfileStatus() {
  const profileId = await getProfileInfo()
  const stored = await chrome.storage.local.get(ALLOWLIST_STORAGE_KEY)
  const allowlist = normalizeAllowlist(stored[ALLOWLIST_STORAGE_KEY])
  const allowed = allowlist.length === 0 || allowlist.includes(String(profileId || "").trim().toLowerCase())
  return {
    profileId,
    allowed,
    allowlist,
    restricted: allowlist.length > 0,
  }
}

// WebMCP detection and integration
const WEBMCP_STORAGE_KEY = "webmcp_tokens"

function detectWebMCP() {
  // Check for legacy WebMCP
  const hasLegacyWidget = document?.querySelector?.("[data-webmcp-widget]") !== null
  const hasLegacyGlobal = typeof window?.webMCP !== "undefined"
  
  // Check for native/W3C WebMCP
  const hasNativeWebMCP = typeof navigator?.modelContext !== "undefined"
  
  return {
    legacy: hasLegacyWidget || hasLegacyGlobal,
    native: hasNativeWebMCP,
    connected: window?.webMCP?.isConnected || false,
  }
}

async function injectWebMCPToken(origin, token) {
  if (!token) return false
  
  try {
    // Store token in extension storage
    const stored = await chrome.storage.local.get(WEBMCP_STORAGE_KEY)
    const tokens = stored[WEBMCP_STORAGE_KEY] || {}
    tokens[origin] = token
    await chrome.storage.local.set({ [WEBMCP_STORAGE_KEY]: tokens })
    
    // Inject into page via content script
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
    if (!tab?.id) return false
    
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: (origin, token) => {
        try {
          const connectionInfo = {
            token: token,
            server: "ws://localhost:8080",
            host: origin.replace(/[.:]/g, "_"),
          }
          sessionStorage.setItem("webmcp_token", JSON.stringify(connectionInfo))
          
          if (window.webMCP && !window.webMCP.isConnected) {
            window.webMCP.connect(token)
          }
          return true
        } catch (e) {
          return false
        }
      },
      args: [origin, token],
    })
    
    return true
  } catch {
    return false
  }
}

async function toolGetWebMCPStatus({ tabId } = {}) {
  const tab = await getTabById(tabId)
  
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => {
        const hasLegacyWidget = document.querySelector("[data-webmcp-widget]") !== null
        const hasLegacyGlobal = typeof window.webMCP !== "undefined"
        const hasNativeWebMCP = typeof navigator.modelContext !== "undefined"
        
        let capabilities = null
        if (window.webMCP?.isConnected) {
          capabilities = {
            tools: Array.from(window.webMCP.availableTools?.keys() || []),
            prompts: Array.from(window.webMCP.availablePrompts?.keys() || []),
            resources: Array.from(window.webMCP.availableResources?.keys() || []),
          }
        }
        
        return {
          legacy: hasLegacyWidget || hasLegacyGlobal,
          native: hasNativeWebMCP,
          connected: window.webMCP?.isConnected || false,
          capabilities,
        }
      },
    })
    
    return results[0]?.result || { detected: false }
  } catch (err) {
    return { detected: false, error: err?.message || String(err) }
  }
}

async function hasPermissions(query) {
  if (!chrome.permissions?.contains) return true
  try {
    return await chrome.permissions.contains(query)
  } catch {
    return false
  }
}

async function hasNativeMessagingPermission() {
  return await hasPermissions({ permissions: ["nativeMessaging"] })
}

async function hasDebuggerPermission() {
  return await hasPermissions({ permissions: ["debugger"] })
}

async function hasDownloadsPermission() {
  return await hasPermissions({ permissions: ["downloads"] })
}

async function hasHostAccessPermission() {
  return await hasPermissions({ origins: ["<all_urls>"] })
}

async function requestOptionalPermissionsFromClick() {
  if (!chrome.permissions?.contains || !chrome.permissions?.request) {
    return { granted: true, requested: false, permissions: [], origins: [] }
  }

  const permissions = []
  for (const permission of OPTIONAL_RUNTIME_PERMISSIONS) {
    if (!declaredOptionalPermissions.has(permission)) continue
    const granted = await hasPermissions({ permissions: [permission] })
    if (!granted) permissions.push(permission)
  }

  const origins = []
  for (const origin of OPTIONAL_RUNTIME_ORIGINS) {
    if (!declaredOptionalOrigins.has(origin)) continue
    const granted = await hasPermissions({ origins: [origin] })
    if (!granted) origins.push(origin)
  }

  if (!permissions.length && !origins.length) {
    return { granted: true, requested: false, permissions, origins }
  }

  try {
    const granted = await chrome.permissions.request({ permissions, origins })
    return { granted, requested: true, permissions, origins }
  } catch (error) {
    return {
      granted: false,
      requested: true,
      permissions,
      origins,
      error: error?.message || String(error),
    }
  }
}

async function ensureDebuggerAvailable() {
  if (!chrome.debugger?.attach) {
    return {
      ok: false,
      reason: "Debugger API unavailable in this build.",
    }
  }

  const granted = await hasDebuggerPermission()
  if (!granted) {
    return {
      ok: false,
      reason: `Debugger permission not granted. ${PERMISSION_HINT}`,
    }
  }

  return { ok: true }
}

async function ensureDownloadsAvailable() {
  if (!chrome.downloads) {
    throw new Error(`Downloads API unavailable in this build. ${PERMISSION_HINT}`)
  }

  const granted = await hasDownloadsPermission()
  if (!granted) {
    throw new Error(`Downloads permission not granted. ${PERMISSION_HINT}`)
  }
}

async function ensureDebuggerAttached(tabId) {
  const availability = await ensureDebuggerAvailable()
  if (!availability.ok) {
    return {
      attached: false,
      unavailableReason: availability.reason,
      consoleMessages: [],
      pageErrors: [],
    }
  }

  let state = debuggerState.get(tabId)
  if (!state) {
    state = {
      attached: false,
      consoleMessages: [],
      pageErrors: [],
      enabledDomains: new Set(),
      network: null,
    }
    debuggerState.set(tabId, state)
  }

  if (state.attached) {
    await ensureDebuggerDomain(tabId, state, "Runtime")
    return state
  }

  state.enabledDomains = new Set()
  if (state.network) state.network.enabled = false

  try {
    await chrome.debugger.attach({ tabId }, "1.3")
    state.attached = true
    await ensureDebuggerDomain(tabId, state, "Runtime")
  } catch (e) {
    state.unavailableReason = e?.message || String(e)
    console.warn("[Iris] Failed to attach debugger:", e.message || e)
  }

  return state
}

async function ensureDebuggerDomain(tabId, state, domain) {
  if (!state.enabledDomains) state.enabledDomains = new Set()
  if (state.enabledDomains.has(domain)) return
  await chrome.debugger.sendCommand({ tabId }, `${domain}.enable`)
  state.enabledDomains.add(domain)
}

async function sendDebuggerCommand(tabId, method, params = {}) {
  const state = await ensureDebuggerAttached(tabId)
  if (!state.attached) {
    throw new Error(state.unavailableReason || "Debugger not attached. DevTools may be open or another debugger is active.")
  }
  return await chrome.debugger.sendCommand({ tabId }, method, params)
}

function makeNetworkState(maxEntries = MAX_NETWORK_ENTRIES) {
  return {
    enabled: false,
    maxEntries: clampNumber(maxEntries, 1, 5000, MAX_NETWORK_ENTRIES),
    requests: new Map(),
    order: [],
    startedAt: Date.now(),
    lastEventAt: Date.now(),
  }
}

function getNetworkState(state, options = {}) {
  if (!state.network) state.network = makeNetworkState(options.maxEntries)
  if (Number.isFinite(options.maxEntries)) {
    state.network.maxEntries = clampNumber(options.maxEntries, 1, 5000, MAX_NETWORK_ENTRIES)
  }
  return state.network
}


function getOrCreateNetworkRecord(network, requestId) {
  let record = network.requests.get(requestId)
  if (!record) {
    record = {
      requestId,
      startedAt: Date.now(),
      updatedAt: Date.now(),
      finished: false,
      failed: false,
    }
    network.requests.set(requestId, record)
    network.order.push(requestId)
  }

  while (network.order.length > network.maxEntries) {
    const oldest = network.order.shift()
    if (oldest) network.requests.delete(oldest)
  }

  network.lastEventAt = Date.now()
  record.updatedAt = network.lastEventAt
  return record
}

function handleNetworkEvent(state, method, params = {}) {
  const network = state.network
  if (!network?.enabled) return
  const requestId = params.requestId
  if (!requestId) return

  const record = getOrCreateNetworkRecord(network, requestId)

  if (method === "Network.requestWillBeSent") {
    record.url = params.request?.url || record.url
    record.method = params.request?.method || record.method
    record.type = params.type || record.type
    record.documentURL = params.documentURL || record.documentURL
    record.frameId = params.frameId || record.frameId
    record.loaderId = params.loaderId || record.loaderId
    record.initiator = params.initiator || record.initiator
    record.timestamp = params.timestamp
    record.wallTime = params.wallTime
    record.requestHeaders = redactHeaders(params.request?.headers)
    record.finished = false
    record.failed = false
  }

  if (method === "Network.responseReceived") {
    record.url = params.response?.url || record.url
    record.type = params.type || record.type
    record.status = params.response?.status
    record.statusText = params.response?.statusText
    record.mimeType = params.response?.mimeType
    record.protocol = params.response?.protocol
    record.remoteIPAddress = params.response?.remoteIPAddress
    record.remotePort = params.response?.remotePort
    record.fromDiskCache = !!params.response?.fromDiskCache
    record.fromServiceWorker = !!params.response?.fromServiceWorker
    record.encodedDataLength = params.response?.encodedDataLength
    record.responseHeaders = redactHeaders(params.response?.headers)
    record.responseTimestamp = params.timestamp
  }

  if (method === "Network.loadingFinished") {
    record.finished = true
    record.failed = false
    record.finishedAt = Date.now()
    record.encodedDataLength = params.encodedDataLength ?? record.encodedDataLength
  }

  if (method === "Network.loadingFailed") {
    record.finished = true
    record.failed = true
    record.finishedAt = Date.now()
    record.errorText = params.errorText
    record.canceled = !!params.canceled
    record.blockedReason = params.blockedReason
    record.corsErrorStatus = params.corsErrorStatus
  }
}

async function ensureNetworkEnabled(tabId, options = {}) {
  const state = await ensureDebuggerAttached(tabId)
  if (!state.attached) {
    throw new Error(state.unavailableReason || "Debugger not attached. DevTools may be open or another debugger is active.")
  }

  const network = getNetworkState(state, options)
  if (options.clear) {
    network.requests.clear()
    network.order = []
    network.startedAt = Date.now()
    network.lastEventAt = Date.now()
  }

  if (!network.enabled) {
    await ensureDebuggerDomain(tabId, state, "Network")
    network.enabled = true
  }

  return { state, network }
}

function serializeNetworkRecord(record, includeHeaders = false) {
  const out = {
    requestId: record.requestId,
    url: record.url,
    method: record.method,
    type: record.type,
    status: record.status,
    statusText: record.statusText,
    mimeType: record.mimeType,
    finished: !!record.finished,
    failed: !!record.failed,
    errorText: record.errorText,
    encodedDataLength: record.encodedDataLength,
    fromDiskCache: !!record.fromDiskCache,
    fromServiceWorker: !!record.fromServiceWorker,
    startedAt: record.startedAt,
    updatedAt: record.updatedAt,
  }
  if (includeHeaders) {
    out.requestHeaders = record.requestHeaders || {}
    out.responseHeaders = record.responseHeaders || {}
  }
  return out
}

if (chrome.debugger?.onEvent) {
  chrome.debugger.onEvent.addListener((source, method, params) => {
    const state = debuggerState.get(source.tabId)
    if (!state) return

    if (method === "Runtime.consoleAPICalled") {
      if (state.consoleMessages.length >= MAX_LOG_ENTRIES) {
        state.consoleMessages.shift()
      }
      state.consoleMessages.push({
        type: params.type,
        text: params.args.map((a) => a.value ?? a.description ?? "").join(" "),
        timestamp: Date.now(),
        source: params.stackTrace?.callFrames?.[0]?.url,
        line: params.stackTrace?.callFrames?.[0]?.lineNumber,
      })
    }

    if (method === "Runtime.exceptionThrown") {
      if (state.pageErrors.length >= MAX_LOG_ENTRIES) {
        state.pageErrors.shift()
      }
      state.pageErrors.push({
        message: params.exceptionDetails.text,
        source: params.exceptionDetails.url,
        line: params.exceptionDetails.lineNumber,
        column: params.exceptionDetails.columnNumber,
        stack: params.exceptionDetails.exception?.description,
        timestamp: Date.now(),
      })
    }

    if (method.startsWith("Network.")) {
      handleNetworkEvent(state, method, params)
    }
  })
}

if (chrome.debugger?.onDetach) {
  chrome.debugger.onDetach.addListener((source) => {
    if (debuggerState.has(source.tabId)) {
      const state = debuggerState.get(source.tabId)
      state.attached = false
      state.enabledDomains = new Set()
      if (state.network) state.network.enabled = false
    }
  })
}

chrome.tabs.onRemoved.addListener((tabId) => {
  if (debuggerState.has(tabId)) {
    if (chrome.debugger?.detach) chrome.debugger.detach({ tabId }).catch(() => {})
    debuggerState.delete(tabId)
  }
})

chrome.alarms.create(KEEPALIVE_ALARM, { periodInMinutes: 0.25 })

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== KEEPALIVE_ALARM) return
  if (!isConnected) {
    connect().catch(() => {})
    return
  }
  const silentMs = Date.now() - lastInboundAt
  // Broker pings keep the service worker warm; old brokers fall back to config probes without reconnect loops.
  if (sawPingOnPort && silentMs > 50000) {
    console.warn("[Iris] No broker traffic for", silentMs, "ms; reconnecting")
    connect().catch(() => {})
  } else if (!sawPingOnPort && silentMs > 60000) {
    syncConfigFromNativeHost()
  }
})

function clearReconnectTimer() {
  if (!reconnectTimer) return
  clearTimeout(reconnectTimer)
  reconnectTimer = null
}

function scheduleReconnect(delayMs = 1000) {
  if (reconnectTimer) return
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null
    if (!isConnected) connect().catch(() => {})
  }, delayMs)
}

async function connect() {
  if (connectPromise) return connectPromise
  connectPromise = connectOnce().finally(() => {
    connectPromise = null
  })
  return connectPromise
}

async function connectOnce() {
  clearReconnectTimer()

  if (port) {
    try {
      port.disconnect()
    } catch {}
    port = null
  }

  const nativeMessagingAllowed = await hasNativeMessagingPermission()
  if (!nativeMessagingAllowed) {
    isConnected = false
    updateBadge(false)
    if (!nativePermissionHintLogged) {
      nativePermissionHintLogged = true
      console.log(`[Iris] Native messaging permission not granted. ${PERMISSION_HINT}`)
    }
    return
  }

  nativePermissionHintLogged = false

  try {
    port = chrome.runtime.connectNative(NATIVE_HOST_NAME)

    port.onMessage.addListener((message) => {
      handleMessage(message).catch((e) => {
        console.error("[Iris] Message handler error:", e)
      })
    })

    port.onDisconnect.addListener(() => {
      isConnected = false
      port = null
      updateBadge(false)

      const err = chrome.runtime.lastError
      if (err?.message) {
        connectionAttempts++
        if (connectionAttempts === 1) {
          console.log("[Iris] Native host not available. Run: iris install")
        } else if (connectionAttempts % 20 === 0) {
          console.log("[Iris] Still waiting for native host...")
        }
      }
      scheduleReconnect(Math.min(15000, 1000 + connectionAttempts * 500))
    })

    isConnected = false
    lastInboundAt = Date.now()
    sawPingOnPort = false
    updateBadge(false)
    syncConfigFromNativeHost().catch(() => {})
  } catch (e) {
    isConnected = false
    updateBadge(false)
    console.error("[Iris] connectNative failed:", e)
    scheduleReconnect(5000)
  }
}

function updateBadge(connected) {
  chrome.action.setBadgeText({ text: connected ? "ON" : "" })
  chrome.action.setBadgeBackgroundColor({ color: connected ? "#22c55e" : "#ef4444" })
}

function send(message) {
  if (!port) return false
  try {
    port.postMessage(message)
    return true
  } catch {
    return false
  }
}

function isBrokerSourcedMessage(message) {
  const t = message?.type
  return t === "ping" || t === "tool_request" || t === "reload"
}

async function handleMessage(message) {
  if (!message || typeof message !== "object") return
  lastInboundAt = Date.now()
  if (message.type === "ping") {
    sawPingOnPort = true
  }
  if (!isConnected && isBrokerSourcedMessage(message)) {
    isConnected = true
    connectionAttempts = 0
    updateBadge(true)
  }

  if (message.type === "tool_request") {
    await handleToolRequest(message)
  } else if (message.type === "ping") {
    send({ type: "pong" })
  } else if (message.type === "config_response") {
    const cfg = message.config || {}
    const allowlist = normalizeAllowlist(cfg.profileEmails)
    await chrome.storage.local.set({ [ALLOWLIST_STORAGE_KEY]: allowlist })
    profileVerified = false // re-verify on next tool call with fresh allowlist
  } else if (message.type === "reload") {
    try {
      chrome.runtime.reload()
    } catch {}
  }
}

async function syncConfigFromNativeHost() {
  if (!port) return
  try {
    port.postMessage({ type: "get_config", id: crypto.randomUUID() })
  } catch {}
}
async function handleToolRequest(request) {
  const { id, tool, args } = request

  try {
    const result = await executeTool(tool, args || {})
    send({ type: "tool_response", id, result })
  } catch (error) {
    send({
      type: "tool_response",
      id,
      error: { content: error?.message || String(error) },
    })
  }
}

async function executeTool(toolName, args) {
  const isAllowed = await verifyProfile()
  if (!isAllowed) {
    throw new Error("Profile not authorized.")
  }

  const tools = {
    get_active_tab: toolGetActiveTab,
    get_tabs: toolGetTabs,
    open_tab: toolOpenTab,
    close_tab: toolCloseTab,
    navigate: toolNavigate,
    click: toolClick,
    type: toolType,
    press: toolPress,
    select: toolSelect,
    screenshot: toolScreenshot,
    snapshot: toolSnapshot,
    query: toolQuery,
    scroll: toolScroll,
    wait: toolWait,
    wait_for: toolWaitFor,
    download: toolDownload,
    list_downloads: toolListDownloads,
    set_file_input: toolSetFileInput,
    highlight: toolHighlight,
    console: toolConsole,
    errors: toolErrors,
    network_start: toolNetworkStart,
    network_stop: toolNetworkStop,
    network_list: toolNetworkList,
    network_get: toolNetworkGet,
    get_profile_status: toolGetProfileStatus,
    get_webmcp_status: toolGetWebMCPStatus,
  }

  const fn = tools[toolName]
  if (!fn) throw new Error(`Unknown tool: ${toolName}`)
  return await fn(args)
}

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
  if (!tab?.id) throw new Error("No active tab found")
  return tab
}

async function getTabById(tabId) {
  return tabId ? await chrome.tabs.get(tabId) : await getActiveTab()
}

async function runInPage(tabId, command, args) {
  const hasHostAccess = await hasHostAccessPermission()
  if (!hasHostAccess) {
    throw new Error(`Site access permission not granted. ${PERMISSION_HINT}`)
  }

  try {
    const result = await chrome.scripting.executeScript({
      target: { tabId },
      func: pageOps,
      args: [command, args || {}],
      world: "ISOLATED",
    })
    return result[0]?.result
  } catch (error) {
    const message = error?.message || String(error)
    if (message.includes("Cannot access contents of the page")) {
      throw new Error(`Site access permission not granted for this page. ${PERMISSION_HINT}`)
    }
    throw error
  }
}

async function pageOps(command, args) {
  const options = args || {}
  const MAX_DEPTH = 6
  const DEFAULT_TIMEOUT_MS = 2000

  function safeString(value) {
    return typeof value === "string" ? value : ""
  }

  function normalizeSelectorList(selector) {
    if (Array.isArray(selector)) {
      return selector.map((s) => safeString(s).trim()).filter(Boolean)
    }
    if (typeof selector !== "string") return []
    const parts = selector
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
    return parts.length ? parts : [selector.trim()].filter(Boolean)
  }

  function stripQuotes(value) {
    return safeString(value).replace(/^['"]|['"]$/g, "")
  }

  function normalizeText(value) {
    return safeString(value).replace(/\s+/g, " ").trim().toLowerCase()
  }

  function matchesText(value, target) {
    if (!target) return false
    const normTarget = normalizeText(target)
    if (!normTarget) return false
    const normValue = normalizeText(value)
    return normValue === normTarget || normValue.includes(normTarget)
  }

  function normalizeLocatorKey(key) {
    if (key === "css") return "css"
    if (key === "label" || key === "field") return "label"
    if (key === "aria" || key === "aria-label") return "aria"
    if (key === "placeholder") return "placeholder"
    if (key === "name") return "name"
    if (key === "role") return "role"
    if (key === "text") return "text"
    if (key === "id") return "id"
    if (key === "uid" || key === "ref") return "uid"
    return null

  }

  function parseLocator(raw) {
    const trimmed = safeString(raw).trim()
    if (!trimmed) return { kind: "css", value: "", raw: "" }
    const match = trimmed.match(/^([a-zA-Z_-]+)\s*(=|:)\s*(.+)$/)
    if (match) {
      const key = match[1].toLowerCase()
      const kind = normalizeLocatorKey(key)
      if (kind) {
        return { kind, value: stripQuotes(match[3]), raw: trimmed }
      }
    }
    return { kind: "css", value: trimmed, raw: trimmed }
  }

  function isVisible(el) {
    if (!el) return false
    const rect = el.getBoundingClientRect()
    if (rect.width <= 0 || rect.height <= 0) return false
    const style = window.getComputedStyle(el)
    if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0") return false
    return true
  }

  function deepQuerySelectorAll(sel, rootDoc) {
    const out = []
    const seen = new Set()

    function addAll(nodeList) {
      for (const el of nodeList) {
        if (!el || seen.has(el)) continue
        seen.add(el)
        out.push(el)
      }
    }

    function walkRoot(root, depth) {
      if (!root || depth > MAX_DEPTH) return
      try {
        addAll(root.querySelectorAll(sel))
      } catch {
        return
      }

      const tree = root.querySelectorAll ? root.querySelectorAll("*") : []
      for (const el of tree) {
        if (el.shadowRoot) {
          walkRoot(el.shadowRoot, depth + 1)
        }
      }

      const frames = root.querySelectorAll ? root.querySelectorAll("iframe") : []
      for (const frame of frames) {
        try {
          const doc = frame.contentDocument
          if (doc) walkRoot(doc, depth + 1)
        } catch {}
      }
    }

    walkRoot(rootDoc || document, 0)
    return out
  }

  function getAriaLabelledByText(el) {
    const ids = safeString(el?.getAttribute?.("aria-labelledby")).split(/\s+/).filter(Boolean)
    if (!ids.length) return ""
    const parts = []
    for (const id of ids) {
      const ref = document.getElementById(id)
      if (ref) parts.push(ref.innerText || ref.textContent || "")
    }
    return parts.join(" ")
  }

  function findByAttribute(attr, target, allowedTags) {
    if (!target) return []
    const nodes = deepQuerySelectorAll(`[${attr}]`, document)
    return nodes.filter((el) => {
      if (Array.isArray(allowedTags) && allowedTags.length && !allowedTags.includes(el.tagName)) return false
      return matchesText(el.getAttribute(attr), target)
    })
  }

  function findByLabelText(target) {
    if (!target) return []
    const results = []
    const seen = new Set()
    const labels = deepQuerySelectorAll("label", document)
    for (const label of labels) {
      if (!matchesText(label.innerText || label.textContent || "", target)) continue
      const control = label.control || label.querySelector("input, textarea, select")
      if (control && !seen.has(control)) {
        seen.add(control)
        results.push(control)
      }
    }
    const labelled = deepQuerySelectorAll("[aria-labelledby]", document)
    for (const el of labelled) {
      if (!matchesText(getAriaLabelledByText(el), target)) continue
      if (!seen.has(el)) {
        seen.add(el)
        results.push(el)
      }
    }
    return results
  }

  function findByRole(target) {
    if (!target) return []
    const nodes = deepQuerySelectorAll("[role]", document)
    return nodes.filter((el) => matchesText(el.getAttribute("role"), target))
  }

  function findByName(target) {
    return findByAttribute("name", target)
  }

  function findByText(target) {
    if (!target) return []
    const results = []
    const seen = new Set()
    const candidates = deepQuerySelectorAll(
      "button, a, label, option, summary, [role='button'], [role='link'], [role='tab'], [role='menuitem']",
      document
    )
    for (const el of candidates) {
      if (!matchesText(el.innerText || el.textContent || "", target)) continue
      if (!seen.has(el)) {
        seen.add(el)
        results.push(el)
      }
    }
    const inputs = deepQuerySelectorAll("input[type='button'], input[type='submit'], input[type='reset']", document)
    for (const el of inputs) {
      if (!matchesText(el.value || "", target)) continue
      if (!seen.has(el)) {
        seen.add(el)
        results.push(el)
      }
    }
    return results
  }

  function resolveLocator(locator) {
    if (locator.kind === "css") {
      const value = safeString(locator.value)
      if (!value) return []
      return deepQuerySelectorAll(value, document)
    }

    if (locator.kind === "label") return findByLabelText(locator.value)
    if (locator.kind === "aria") return findByAttribute("aria-label", locator.value)
    if (locator.kind === "placeholder") return findByAttribute("placeholder", locator.value, ["INPUT", "TEXTAREA"])
    if (locator.kind === "name") return findByName(locator.value)
    if (locator.kind === "role") return findByRole(locator.value)
    if (locator.kind === "text") return findByText(locator.value)

    if (locator.kind === "id") {
      const idValue = safeString(locator.value).trim()
      if (!idValue) return []
      const escaped = window.CSS && window.CSS.escape ? window.CSS.escape(idValue) : idValue.replace(/[^a-zA-Z0-9_-]/g, "\\$&")
      return deepQuerySelectorAll(`#${escaped}`, document)
    }

    if (locator.kind === "uid") {
      let id = safeString(locator.value).trim()
      if (!id) return []
      if (!/^e\d+$/i.test(id) && /^\d+$/.test(id)) id = `e${id}`
      const escaped = window.CSS && window.CSS.escape ? window.CSS.escape(id) : id.replace(/[^a-zA-Z0-9_-]/g, "\\$&")
      return deepQuerySelectorAll(`[data-iris-uid="${escaped}"]`, document)
    }

    return []
  }

  function resolveMatchesOnce(selectors, index) {
    for (const sel of selectors) {
      const locator = parseLocator(sel)
      if (!locator.value) continue
      const matches = resolveLocator(locator)
      if (!matches.length) continue
      const visible = matches.filter(isVisible)
      const chosen = visible[index] || matches[index] || null
      return { selectorUsed: locator.raw, matches, chosen }
    }
    return { selectorUsed: selectors[0] || "", matches: [], chosen: null }
  }

  async function resolveMatches(selectors, index, timeoutMs, pollMs) {
    let match = resolveMatchesOnce(selectors, index)
    if (timeoutMs > 0) {
      const start = Date.now()
      while (!match.matches.length && Date.now() - start < timeoutMs) {
        await new Promise((r) => setTimeout(r, pollMs))
        match = resolveMatchesOnce(selectors, index)
      }
    }
    return match
  }

  function clickElement(el) {
    try {
      el.scrollIntoView({ block: "center", inline: "center" })
    } catch {}

    const rect = el.getBoundingClientRect()
    const x = Math.min(Math.max(rect.left + rect.width / 2, 0), window.innerWidth - 1)
    const y = Math.min(Math.max(rect.top + rect.height / 2, 0), window.innerHeight - 1)
    const opts = { bubbles: true, cancelable: true, view: window, clientX: x, clientY: y }

    try {
      el.dispatchEvent(new MouseEvent("mouseover", opts))
      el.dispatchEvent(new MouseEvent("mousemove", opts))
      el.dispatchEvent(new MouseEvent("mousedown", opts))
      el.dispatchEvent(new MouseEvent("mouseup", opts))
      el.dispatchEvent(new MouseEvent("click", opts))
    } catch {}

    try {
      el.click()
    } catch {}
  }

  function setNativeValue(el, value) {
    const tag = el.tagName
    if (tag === "INPUT" || tag === "TEXTAREA") {
      const proto = tag === "INPUT" ? window.HTMLInputElement.prototype : window.HTMLTextAreaElement.prototype
      const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set
      if (setter) setter.call(el, value)
      else el.value = value
      return true
    }
    return false
  }

  function setSelectValue(el, value) {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, "value")?.set
    if (setter) setter.call(el, value)
    else el.value = value
  }

  function isSensitiveField(el) {
    const type = String(el.type || "").toLowerCase()
    if (type === "password" || type === "hidden") return true
    const ac = String(el.getAttribute("autocomplete") || "").toLowerCase()
    if (/password|one-time|otp|cc-|card|cvv|ssn|secret/.test(ac)) return true
    const name = String(el.getAttribute("name") || el.id || "").toLowerCase()
    if (/password|passwd|secret|otp|cvv|card.?number|ssn/.test(name)) return true
    return false
  }

  function getInputValues() {
    const out = []
    const nodes = document.querySelectorAll("input, textarea")
    nodes.forEach((el) => {
      try {
        const label = el.getAttribute("aria-label") || el.getAttribute("name") || el.id || el.className || el.tagName
        const value = el.value
        if (value == null || !String(value).trim()) return
        out.push(`${label}: ${isSensitiveField(el) ? "[redacted]" : value}`)
      } catch {}
    })
    return out.join("\n")
  }


  function getPseudoText() {
    const out = []
    const elements = Array.from(document.querySelectorAll("*"))
    for (let i = 0; i < elements.length && out.length < 2000; i++) {
      const el = elements[i]
      try {
        const style = window.getComputedStyle(el)
        if (style.display === "none" || style.visibility === "hidden") continue
        const before = window.getComputedStyle(el, "::before").content
        const after = window.getComputedStyle(el, "::after").content
        const pushContent = (content) => {
          if (!content) return
          const c = String(content)
          if (!c || c === "none" || c === "normal") return
          const unquoted = c.replace(/^"|"$/g, "").replace(/^'|'$/g, "")
          if (unquoted && unquoted !== "none" && unquoted !== "normal") out.push(unquoted)
        }
        pushContent(before)
        pushContent(after)
      } catch {}
    }
    return out.join("\n")
  }

  function buildMatches(text, pattern, flags) {
    if (!pattern) return []
    try {
      const re = new RegExp(pattern, flags || "")
      const found = []
      let m
      while ((m = re.exec(text)) && found.length < 50) {
        found.push(m[0])
        if (!re.global) break
      }
      return found
    } catch {
      return []
    }
  }

  function getPageText(limit, pattern, flags) {
    const parts = []
    const bodyText = safeString(document.body?.innerText || "")
    if (bodyText.trim()) parts.push(bodyText)
    const inputValues = getInputValues()
    if (inputValues) parts.push(inputValues)
    const pseudo = getPseudoText()
    if (pseudo) parts.push(pseudo)
    const text = parts.filter(Boolean).join("\n\n").slice(0, Math.max(0, limit))
    return {
      url: location.href,
      title: document.title,
      text,
      matches: buildMatches(text, pattern, flags),
    }
  }

  function matchesPattern(value, pattern, flags) {
    if (!pattern) return false
    try {
      return new RegExp(pattern, flags || "").test(value)
    } catch {
      return safeString(value).includes(pattern)
    }
  }

  function elementRect(el) {
    const rect = el.getBoundingClientRect()
    return {
      x: rect.x,
      y: rect.y,
      left: rect.left,
      top: rect.top,
      right: rect.right,
      bottom: rect.bottom,
      width: rect.width,
      height: rect.height,
      pageX: rect.left + window.scrollX,
      pageY: rect.top + window.scrollY,
      scrollX: window.scrollX,
      scrollY: window.scrollY,
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight,
    }
  }

  function waitCondition(selectors, state, text, urlPattern, pattern, flags, index) {
    const targetState = safeString(state || "").toLowerCase()
    const hasSelector = selectors.length > 0

    if (hasSelector) {
      const match = resolveMatchesOnce(selectors, index)
      const visible = match.matches.filter(isVisible)
      if (targetState === "hidden") {
        return { ok: true, matched: !match.matches.length || visible.length === 0, selectorUsed: match.selectorUsed }
      }
      if (targetState === "detached") {
        return { ok: true, matched: match.matches.length === 0, selectorUsed: match.selectorUsed }
      }
      if (targetState === "attached") {
        return { ok: true, matched: match.matches.length > 0, selectorUsed: match.selectorUsed }
      }
      return { ok: true, matched: visible.length > 0, selectorUsed: match.selectorUsed }
    }

    if (typeof text === "string" && text) {
      const pageText = safeString(document.body?.innerText || "")
      return { ok: true, matched: pageText.includes(text) }
    }

    if (typeof pattern === "string" && pattern) {
      const pageText = safeString(document.body?.innerText || "")
      return { ok: true, matched: matchesPattern(pageText, pattern, flags) }
    }

    if (typeof urlPattern === "string" && urlPattern) {
      return { ok: true, matched: matchesPattern(location.href, urlPattern, flags) || location.href.includes(urlPattern) }
    }

    return { ok: false, error: "selector, text, pattern, or urlPattern is required" }
  }

  const mode = typeof options.mode === "string" && options.mode ? options.mode : "text"
  const selectors = normalizeSelectorList(options.selector)
  const index = Number.isFinite(options.index) ? options.index : 0
  const timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : DEFAULT_TIMEOUT_MS
  const pollMs = Number.isFinite(options.pollMs) ? options.pollMs : 200
  const limit = Number.isFinite(options.limit) ? options.limit : mode === "page_text" ? 20000 : 50
  const pattern = typeof options.pattern === "string" ? options.pattern : null
  const flags = typeof options.flags === "string" ? options.flags : "i"

  if (command === "rect") {
    const match = await resolveMatches(selectors, index, timeoutMs, pollMs)
    if (!match.chosen) {
      return { ok: false, error: `Element not found for selectors: ${selectors.join(", ")}` }
    }

    try {
      match.chosen.scrollIntoView({ block: "center", inline: "center" })
    } catch {}

    const rect = elementRect(match.chosen)
    const x = Math.min(Math.max(rect.left + rect.width / 2, 0), rect.viewportWidth - 1)
    const y = Math.min(Math.max(rect.top + rect.height / 2, 0), rect.viewportHeight - 1)
    return { ok: true, selectorUsed: match.selectorUsed, x, y }
  }

  if (command === "click") {
    const match = await resolveMatches(selectors, index, timeoutMs, pollMs)
    if (!match.chosen) {
      return { ok: false, error: `Element not found for selectors: ${selectors.join(", ")}` }
    }
    clickElement(match.chosen)
    return { ok: true, selectorUsed: match.selectorUsed }
  }

  if (command === "type") {
    const text = options.text
    const shouldClear = !!options.clear
    const match = await resolveMatches(selectors, index, timeoutMs, pollMs)
    if (!match.chosen) {
      return { ok: false, error: `Element not found for selectors: ${selectors.join(", ")}` }
    }

    try {
      match.chosen.scrollIntoView({ block: "center", inline: "center" })
    } catch {}

    try {
      match.chosen.focus()
    } catch {}

    const tag = match.chosen.tagName
    const isTextInput = tag === "INPUT" || tag === "TEXTAREA"

    if (isTextInput) {
      if (shouldClear) setNativeValue(match.chosen, "")
      setNativeValue(match.chosen, (match.chosen.value || "") + text)
      for (const ch of String(text)) {
        const opts = { key: ch, bubbles: true, cancelable: true }
        match.chosen.dispatchEvent(new KeyboardEvent("keydown", opts))
        match.chosen.dispatchEvent(new KeyboardEvent("keypress", opts))
        match.chosen.dispatchEvent(new KeyboardEvent("keyup", opts))
      }
      match.chosen.dispatchEvent(new Event("input", { bubbles: true }))
      match.chosen.dispatchEvent(new Event("change", { bubbles: true }))
      return { ok: true, selectorUsed: match.selectorUsed }
    }

    if (match.chosen.isContentEditable) {
      if (shouldClear) match.chosen.textContent = ""
      try {
        document.execCommand("insertText", false, text)
      } catch {
        match.chosen.textContent = (match.chosen.textContent || "") + text
      }
      for (const ch of String(text)) {
        const opts = { key: ch, bubbles: true, cancelable: true }
        match.chosen.dispatchEvent(new KeyboardEvent("keydown", opts))
        match.chosen.dispatchEvent(new KeyboardEvent("keypress", opts))
        match.chosen.dispatchEvent(new KeyboardEvent("keyup", opts))
      }
      match.chosen.dispatchEvent(new Event("input", { bubbles: true }))
      return { ok: true, selectorUsed: match.selectorUsed }
    }

    return { ok: false, error: `Element is not typable: ${match.selectorUsed} (${tag.toLowerCase()})` }
  }

  if (command === "focus") {
    const match = await resolveMatches(selectors, index, timeoutMs, pollMs)
    if (!match.chosen) return { ok: false, error: `Element not found for selectors: ${selectors.join(", ")}` }
    try {
      match.chosen.scrollIntoView({ block: "center", inline: "center" })
      match.chosen.focus()
    } catch {}
    return { ok: true, selectorUsed: match.selectorUsed }
  }

  if (command === "press") {
    const key = safeString(options.key)
    if (!key) return { ok: false, error: "key is required" }
    const modifiers = Array.isArray(options.modifiers) ? options.modifiers.map(safeString).filter(Boolean) : []
    let selectorUsed = ""
    if (selectors.length) {
      const match = await resolveMatches(selectors, index, timeoutMs, pollMs)
      if (!match.chosen) {
        return { ok: false, error: `Element not found for selectors: ${selectors.join(", ")}` }
      }
      try {
        match.chosen.scrollIntoView({ block: "center", inline: "center" })
        match.chosen.focus()
      } catch {}
      selectorUsed = match.selectorUsed
    }
    const mod = {
      altKey: modifiers.some((m) => /^alt$/i.test(m)),
      ctrlKey: modifiers.some((m) => /^(control|ctrl)$/i.test(m)),
      metaKey: modifiers.some((m) => /^(meta|command|cmd)$/i.test(m)),
      shiftKey: modifiers.some((m) => /^shift$/i.test(m)),
    }
    const target = document.activeElement || document.body
    const opts = { key, code: key.length === 1 ? `Key${key.toUpperCase()}` : key, bubbles: true, cancelable: true, ...mod }
    try {
      target.dispatchEvent(new KeyboardEvent("keydown", opts))
      target.dispatchEvent(new KeyboardEvent("keypress", opts))
      target.dispatchEvent(new KeyboardEvent("keyup", opts))
    } catch (e) {
      return { ok: false, error: e?.message || String(e) }
    }
    return { ok: true, key, selectorUsed, method: "dom" }
  }

  if (command === "select") {
    const value = typeof options.value === "string" ? options.value : null
    const label = typeof options.label === "string" ? options.label : null
    const optionIndex = Number.isFinite(options.optionIndex) ? options.optionIndex : null
    const match = await resolveMatches(selectors, index, timeoutMs, pollMs)
    if (!match.chosen) {
      return { ok: false, error: `Element not found for selectors: ${selectors.join(", ")}` }
    }

    const tag = match.chosen.tagName
    if (tag !== "SELECT") {
      return { ok: false, error: `Element is not a select: ${match.selectorUsed} (${tag.toLowerCase()})` }
    }

    if (value === null && label === null && optionIndex === null) {
      return { ok: false, error: "value, label, or optionIndex is required" }
    }

    const selectEl = match.chosen
    const optionList = Array.from(selectEl.options || [])
    let option = null

    if (value !== null) {
      option = optionList.find((opt) => opt.value === value)
    }

    if (!option && label !== null) {
      const target = label.trim()
      option = optionList.find((opt) => (opt.label || opt.textContent || "").trim() === target)
    }

    if (!option && optionIndex !== null) {
      option = optionList[optionIndex]
    }

    if (!option) {
      return { ok: false, error: "Option not found" }
    }

    try {
      selectEl.scrollIntoView({ block: "center", inline: "center" })
    } catch {}

    try {
      selectEl.focus()
    } catch {}

    setSelectValue(selectEl, option.value)
    option.selected = true
    selectEl.dispatchEvent(new Event("input", { bubbles: true }))
    selectEl.dispatchEvent(new Event("change", { bubbles: true }))

    return {
      ok: true,
      selectorUsed: match.selectorUsed,
      value: selectEl.value,
      label: (option.label || option.textContent || "").trim(),
    }
  }

  if (command === "set_file_input") {
    const rawFiles = Array.isArray(options.files) ? options.files : options.files ? [options.files] : []
    if (!rawFiles.length) return { ok: false, error: "files is required" }

    const match = await resolveMatches(selectors, index, timeoutMs, pollMs)
    if (!match.chosen) {
      return { ok: false, error: `Element not found for selectors: ${selectors.join(", ")}` }
    }

    const tag = match.chosen.tagName
    if (tag !== "INPUT" || match.chosen.type !== "file") {
      return { ok: false, error: `Element is not a file input: ${match.selectorUsed} (${tag.toLowerCase()})` }
    }

    function decodeBase64(value) {
      const raw = safeString(value)
      const b64 = raw.includes(",") ? raw.split(",").pop() : raw
      const binary = atob(b64)
      const bytes = new Uint8Array(binary.length)
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
      return bytes
    }

    const dt = new DataTransfer()
    const names = []

    for (const fileInfo of rawFiles) {
      const name = safeString(fileInfo?.name) || "upload.bin"
      const mimeType = safeString(fileInfo?.mimeType) || "application/octet-stream"
      const base64 = safeString(fileInfo?.base64)
      if (!base64) return { ok: false, error: "file.base64 is required" }
      const bytes = decodeBase64(base64)
      const file = new File([bytes], name, { type: mimeType, lastModified: Date.now() })
      dt.items.add(file)
      names.push(name)
    }

    try {
      match.chosen.scrollIntoView({ block: "center", inline: "center" })
    } catch {}

    try {
      match.chosen.focus()
    } catch {}

    try {
      match.chosen.files = dt.files
    } catch {
      try {
        Object.defineProperty(match.chosen, "files", { value: dt.files, writable: false })
      } catch {
        return { ok: false, error: "Failed to set file input" }
      }
    }

    match.chosen.dispatchEvent(new Event("input", { bubbles: true }))
    match.chosen.dispatchEvent(new Event("change", { bubbles: true }))

    return { ok: true, selectorUsed: match.selectorUsed, count: dt.files.length, names }
  }

  if (command === "element_rect") {
    const match = await resolveMatches(selectors, index, timeoutMs, pollMs)
    if (!match.chosen) {
      return { ok: false, error: `Element not found for selectors: ${selectors.join(", ")}` }
    }
    return { ok: true, selectorUsed: match.selectorUsed, rect: elementRect(match.chosen) }
  }

  if (command === "scroll") {
    const scrollX = Number.isFinite(options.x) ? options.x : 0
    const scrollY = Number.isFinite(options.y) ? options.y : 0
    if (selectors.length) {
      const match = await resolveMatches(selectors, index, timeoutMs, pollMs)
      if (!match.chosen) {
        return { ok: false, error: `Element not found for selectors: ${selectors.join(", ")}` }
      }
      try {
        match.chosen.scrollIntoView({ behavior: "smooth", block: "center" })
      } catch {}
      return { ok: true, selectorUsed: match.selectorUsed }
    }
    window.scrollBy(scrollX, scrollY)
    return { ok: true }
  }

  if (command === "wait_for") {
    const endAt = Date.now() + timeoutMs
    const state = options.state || (selectors.length ? "visible" : "")
    const text = typeof options.text === "string" ? options.text : null
    const urlPattern = typeof options.urlPattern === "string" ? options.urlPattern : null

    while (true) {
      const result = waitCondition(selectors, state, text, urlPattern, pattern, flags, index)
      if (!result.ok) return result
      if (result.matched) {
        return { ok: true, matched: true, selectorUsed: result.selectorUsed || null }
      }
      if (Date.now() >= endAt) {
        return { ok: false, error: "Timed out waiting for condition" }
      }
      await new Promise((r) => setTimeout(r, pollMs))
    }
  }

  if (command === "highlight") {
    const duration = Number.isFinite(options.duration) ? options.duration : 3000
    const color = typeof options.color === "string" ? options.color : "#ff0000"
    const showInfo = !!options.showInfo

    const match = await resolveMatches(selectors, index, timeoutMs, pollMs)
    if (!match.chosen) {
      return { ok: false, error: `Element not found for selectors: ${selectors.join(", ")}` }
    }

    const el = match.chosen
    const rect = el.getBoundingClientRect()

    // Remove any existing highlight overlay
    const existing = document.getElementById("__iris_highlight_overlay")
    if (existing) existing.remove()

    // Create overlay
    const overlay = document.createElement("div")
    overlay.id = "__iris_highlight_overlay"
    overlay.style.cssText = `
      position: fixed;
      top: ${rect.top}px;
      left: ${rect.left}px;
      width: ${rect.width}px;
      height: ${rect.height}px;
      border: 3px solid ${color};
      box-shadow: 0 0 10px ${color};
      pointer-events: none;
      z-index: 2147483647;
      transition: opacity 0.3s;
    `

    if (showInfo) {
      const info = document.createElement("div")
      info.style.cssText = `
        position: absolute;
        top: -25px;
        left: 0;
        background: ${color};
        color: white;
        padding: 2px 8px;
        font-size: 12px;
        font-family: monospace;
        border-radius: 3px;
        white-space: nowrap;
      `
      info.textContent = `${el.tagName.toLowerCase()}${el.id ? "#" + el.id : ""}`
      overlay.appendChild(info)
    }

    document.body.appendChild(overlay)

    setTimeout(() => {
      overlay.style.opacity = "0"
      setTimeout(() => overlay.remove(), 300)
    }, duration)

    return {
      ok: true,
      selectorUsed: match.selectorUsed,
      highlighted: true,
      tag: el.tagName,
      id: el.id || null,
    }
  }

  if (command === "query") {
    if (mode === "page_text") {
      if (selectors.length && timeoutMs > 0) {
        await resolveMatches(selectors, index, timeoutMs, pollMs)
      }
      return { ok: true, value: getPageText(limit, pattern, flags) }
    }

    if (!selectors.length) {
      return { ok: false, error: "Selector is required" }
    }

    const match = await resolveMatches(selectors, index, timeoutMs, pollMs)

    if (mode === "exists") {
      return {
        ok: true,
        selectorUsed: match.selectorUsed,
        value: { exists: match.matches.length > 0, count: match.matches.length },
      }
    }

    if (!match.chosen) {
      return { ok: false, error: `No matches for selectors: ${selectors.join(", ")}` }
    }

    if (mode === "text") {
      const text = (match.chosen.innerText || match.chosen.textContent || "").trim()
      return { ok: true, selectorUsed: match.selectorUsed, value: text }
    }

    if (mode === "value") {
      const value = match.chosen.value
      return { ok: true, selectorUsed: match.selectorUsed, value: typeof value === "string" ? value : String(value ?? "") }
    }

    if (mode === "attribute") {
      const value = options.attribute ? match.chosen.getAttribute(options.attribute) : null
      return { ok: true, selectorUsed: match.selectorUsed, value }
    }

    if (mode === "property") {
      if (!options.property) return { ok: false, error: "property is required" }
      return { ok: true, selectorUsed: match.selectorUsed, value: match.chosen[options.property] }
    }

    if (mode === "html") {
      return { ok: true, selectorUsed: match.selectorUsed, value: match.chosen.outerHTML }
    }

    if (mode === "list") {
      const maxItems = Math.min(Math.max(1, limit), 200)
      const items = match.matches.slice(0, maxItems).map((el) => ({
        text: (el.innerText || el.textContent || "").trim().slice(0, 200),
        tag: (el.tagName || "").toLowerCase(),
        ariaLabel: el.getAttribute ? el.getAttribute("aria-label") : null,
      }))
      return {
        ok: true,
        selectorUsed: match.selectorUsed,
        value: { items, count: match.matches.length },
      }
    }

    return { ok: false, error: `Unknown mode: ${mode}` }
  }

  return { ok: false, error: `Unknown command: ${String(command)}` }
}

async function toolGetActiveTab() {
  const tab = await getActiveTab()
  return { tabId: tab.id, content: { tabId: tab.id, url: tab.url, title: tab.title } }
}

async function toolOpenTab({ url, active = true }) {
  const createOptions = {}
  if (typeof url === "string" && url.trim()) createOptions.url = url.trim()
  if (typeof active === "boolean") createOptions.active = active

  const tab = await chrome.tabs.create(createOptions)
  return { tabId: tab.id, content: { tabId: tab.id, url: tab.url, active: tab.active } }
}

async function toolCloseTab({ tabId }) {
  if (!Number.isFinite(tabId)) throw new Error("tabId is required")
  await chrome.tabs.remove(tabId)
  return { tabId, content: { tabId, closed: true } }
}

async function toolNavigate({ url, tabId }) {
  if (!url) throw new Error("URL is required")
  const tab = await getTabById(tabId)
  await chrome.tabs.update(tab.id, { url })

  await new Promise((resolve) => {
    const listener = (updatedTabId, info) => {
      if (updatedTabId === tab.id && info.status === "complete") {
        chrome.tabs.onUpdated.removeListener(listener)
        resolve()
      }
    }
    chrome.tabs.onUpdated.addListener(listener)
    setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener)
      resolve()
    }, 30000)
  })

  return { tabId: tab.id, content: `Navigated to ${url}` }
}

async function toolClick({ selector, tabId, index = 0, timeoutMs, pollMs }) {
  if (!selector) throw new Error("Selector is required")
  const tab = await getTabById(tabId)

  const state = await ensureDebuggerAttached(tab.id)
  if (state.attached) {
    const point = await runInPage(tab.id, "rect", { selector, index, timeoutMs, pollMs })
    if (!point?.ok) throw new Error(point?.error || "Click failed")
    const mouse = { x: point.x, y: point.y, button: "left", clickCount: 1 }
    await sendDebuggerCommand(tab.id, "Input.dispatchMouseEvent", { type: "mousePressed", ...mouse })
    await sendDebuggerCommand(tab.id, "Input.dispatchMouseEvent", { type: "mouseReleased", ...mouse })
    const used = point.selectorUsed || selector
    return { tabId: tab.id, content: `Clicked ${used}` }
  }

  const result = await runInPage(tab.id, "click", { selector, index, timeoutMs, pollMs })
  if (!result?.ok) throw new Error(result?.error || "Click failed")
  const used = result.selectorUsed || selector
  return { tabId: tab.id, content: `Clicked ${used}` }
}

async function toolType({ selector, text, tabId, clear = false, index = 0, timeoutMs, pollMs }) {
  if (!selector) throw new Error("Selector is required")
  if (text === undefined) throw new Error("Text is required")
  const tab = await getTabById(tabId)

  const result = await runInPage(tab.id, "type", { selector, text, clear, index, timeoutMs, pollMs })
  if (!result?.ok) throw new Error(result?.error || "Type failed")
  const used = result.selectorUsed || selector
  return { tabId: tab.id, content: `Typed "${text}" into ${used}` }
}

function cdpKeyModifiers(modList) {
  let bits = 0
  for (const m of modList) {
    if (/^alt$/i.test(m)) bits |= 1
    else if (/^(control|ctrl)$/i.test(m)) bits |= 2
    else if (/^(meta|command|cmd)$/i.test(m)) bits |= 4
    else if (/^shift$/i.test(m)) bits |= 8
  }
  return bits
}

function cdpKeyFields(key) {
  const k = String(key)
  const vk = { Enter: 13, Tab: 9, Escape: 27, Backspace: 8 }[k]
  let code = k
  if (k.length === 1 && /[a-zA-Z]/.test(k)) code = `Key${k.toUpperCase()}`
  else if (k.length === 1 && /[0-9]/.test(k)) code = `Digit${k}`
  const out = { key: k, code }
  if (vk != null) {
    out.windowsVirtualKeyCode = vk
    out.nativeVirtualKeyCode = vk
  }
  return out
}

async function toolPress({ key, modifiers, selector, tabId, index = 0, timeoutMs, pollMs } = {}) {
  if (!key || typeof key !== "string" || !key.trim()) throw new Error("key is required")
  const tab = await getTabById(tabId)
  const modList = Array.isArray(modifiers) ? modifiers.map(String) : []

  if (selector) {
    const focusResult = await runInPage(tab.id, "focus", { selector, index, timeoutMs, pollMs })
    if (!focusResult?.ok) throw new Error(focusResult?.error || "Focus failed")
  }

  const state = await ensureDebuggerAttached(tab.id)
  if (state.attached) {
    const fields = cdpKeyFields(key.trim())
    const mods = cdpKeyModifiers(modList)
    await sendDebuggerCommand(tab.id, "Input.dispatchKeyEvent", { type: "keyDown", modifiers: mods, ...fields })
    await sendDebuggerCommand(tab.id, "Input.dispatchKeyEvent", { type: "keyUp", modifiers: mods, ...fields })
    return { tabId: tab.id, content: `Pressed ${key.trim()}` }
  }

  const result = await runInPage(tab.id, "press", {
    key: key.trim(),
    modifiers: modList,
    selector,
    index,
    timeoutMs,
    pollMs,
  })
  if (!result?.ok) throw new Error(result?.error || "Press failed")
  return { tabId: tab.id, content: `Pressed ${key.trim()}` }
}

async function toolSelect({ selector, value, label, optionIndex, tabId, index = 0, timeoutMs, pollMs }) {
  if (!selector) throw new Error("Selector is required")
  if (value === undefined && label === undefined && optionIndex === undefined) {
    throw new Error("value, label, or optionIndex is required")
  }
  const tab = await getTabById(tabId)

  const result = await runInPage(tab.id, "select", { selector, value, label, optionIndex, index, timeoutMs, pollMs })
  if (!result?.ok) throw new Error(result?.error || "Select failed")
  const used = result.selectorUsed || selector
  const valueText = result.value ? String(result.value) : ""
  const labelText = result.label ? String(result.label) : ""
  const summary = labelText && valueText && labelText !== valueText ? `${labelText} (${valueText})` : labelText || valueText
  return { tabId: tab.id, content: `Selected ${summary || "option"} in ${used}` }
}

function normalizeScreenshotFormat(value) {
  const format = typeof value === "string" ? value.trim().toLowerCase() : "png"
  if (format === "jpeg" || format === "jpg") return "jpeg"
  if (format === "webp") return "webp"
  return "png"
}

function screenshotMime(format) {
  if (format === "jpeg") return "image/jpeg"
  if (format === "webp") return "image/webp"
  return "image/png"
}

async function getElementScreenshotClip(tabId, selector, index = 0, timeoutMs, pollMs) {
  const result = await runInPage(tabId, "element_rect", { selector, index, timeoutMs, pollMs })
  if (!result?.ok) throw new Error(result?.error || "Failed to resolve screenshot element")
  const rect = result.rect || {}
  const width = Math.max(1, Math.ceil(rect.width || 0))
  const height = Math.max(1, Math.ceil(rect.height || 0))
  return {
    x: Math.max(0, Math.floor(rect.pageX || 0)),
    y: Math.max(0, Math.floor(rect.pageY || 0)),
    width,
    height,
    scale: 1,
  }
}

async function toolScreenshot({
  tabId,
  fullPage = false,
  selector,
  index = 0,
  x,
  y,
  width,
  height,
  format,
  quality,
  timeoutMs,
  pollMs,
} = {}) {
  const tab = await getTabById(tabId)
  const screenshotFormat = normalizeScreenshotFormat(format)
  const hasManualClip = [x, y, width, height].every((value) => Number.isFinite(value))
  const hasSelectorClip = typeof selector === "string" && selector.trim()

  if (!fullPage && !hasManualClip && !hasSelectorClip && screenshotFormat === "png" && !Number.isFinite(quality)) {
    const png = await chrome.tabs.captureVisibleTab(tab.windowId, { format: "png" })
    return { tabId: tab.id, content: png }
  }

  const debuggerStateForTab = await ensureDebuggerAttached(tab.id)
  if (!debuggerStateForTab.attached) {
    throw new Error(debuggerStateForTab.unavailableReason || "Debugger not attached. DevTools may be open or another debugger is active.")
  }
  await ensureDebuggerDomain(tab.id, debuggerStateForTab, "Page")

  let clip = null
  if (hasSelectorClip) {
    clip = await getElementScreenshotClip(tab.id, selector.trim(), index, timeoutMs, pollMs)
  } else if (hasManualClip) {
    clip = {
      x: Math.max(0, Number(x)),
      y: Math.max(0, Number(y)),
      width: Math.max(1, Number(width)),
      height: Math.max(1, Number(height)),
      scale: 1,
    }
  } else if (fullPage) {
    const metrics = await sendDebuggerCommand(tab.id, "Page.getLayoutMetrics")
    const size = metrics?.contentSize || {}
    clip = {
      x: 0,
      y: 0,
      width: Math.max(1, Math.ceil(size.width || 1)),
      height: Math.max(1, Math.ceil(size.height || 1)),
      scale: 1,
    }
  }

  const params = {
    format: screenshotFormat,
    captureBeyondViewport: !!clip,
  }
  if (clip) params.clip = clip
  if (Number.isFinite(quality) && screenshotFormat !== "png") {
    params.quality = clampNumber(quality, 0, 100, 80)
  }

  const result = await sendDebuggerCommand(tab.id, "Page.captureScreenshot", params)
  return { tabId: tab.id, content: `data:${screenshotMime(screenshotFormat)};base64,${result.data}` }
}

async function toolSnapshot({ tabId }) {
  const tab = await getTabById(tabId)

  const result = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: () => {
      function safeText(s) {
        return typeof s === "string" ? s : ""
      }

      function isVisible(el) {
        if (!el) return false
        const rect = el.getBoundingClientRect()
        if (rect.width <= 0 || rect.height <= 0) return false
        const style = window.getComputedStyle(el)
        if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0") return false
        return true
      }

      function pseudoText(el) {
        try {
          const before = window.getComputedStyle(el, "::before").content
          const after = window.getComputedStyle(el, "::after").content
          const norm = (v) => {
            const s = safeText(v)
            if (!s || s === "none") return ""
            return s.replace(/^"|"$/g, "")
          }
          return { before: norm(before), after: norm(after) }
        } catch {
          return { before: "", after: "" }
        }
      }

      function getName(el) {
        const aria = el.getAttribute("aria-label")
        if (aria) return aria
        const alt = el.getAttribute("alt")
        if (alt) return alt
        const title = el.getAttribute("title")
        if (title) return title
        const placeholder = el.getAttribute("placeholder")
        if (placeholder) return placeholder
        const txt = safeText(el.innerText)
        if (txt.trim()) return txt.slice(0, 200)
        const pt = pseudoText(el)
        const combo = `${pt.before} ${pt.after}`.trim()
        if (combo) return combo.slice(0, 200)
        return ""
      }

      function build(el, depth = 0, uid = 0) {
        if (!el || depth > 12) return { nodes: [], nextUid: uid }
        const nodes = []

        if (!isVisible(el)) return { nodes: [], nextUid: uid }

        const isInteractive =
          ["A", "BUTTON", "INPUT", "TEXTAREA", "SELECT"].includes(el.tagName) ||
          el.getAttribute("onclick") ||
          el.getAttribute("role") === "button" ||
          el.isContentEditable

        const name = getName(el)
        const pt = pseudoText(el)

        const shouldInclude = isInteractive || name.trim() || pt.before || pt.after

        if (shouldInclude) {
          const uidStr = `e${uid}`
          const node = {
            uid: uidStr,
            role: el.getAttribute("role") || el.tagName.toLowerCase(),
            name: name,
            tag: el.tagName.toLowerCase(),
          }

          try {
            el.setAttribute("data-iris-uid", uidStr)
          } catch {}

          if (pt.before) node.before = pt.before
          if (pt.after) node.after = pt.after

          if (el.href) node.href = el.href

          if (el.tagName === "INPUT" || el.tagName === "TEXTAREA") {
            node.type = el.type
            const type = String(el.type || "").toLowerCase()
            const ac = String(el.getAttribute("autocomplete") || "").toLowerCase()
            const fieldName = String(el.getAttribute("name") || el.id || "").toLowerCase()
            const sensitive =
              type === "password" ||
              type === "hidden" ||
              /password|one-time|otp|cc-|card|cvv|ssn|secret/.test(ac) ||
              /password|passwd|secret|otp|cvv|card.?number|ssn/.test(fieldName)
            node.value = sensitive ? "[redacted]" : el.value
            if (el.readOnly) node.readOnly = true
            if (el.disabled) node.disabled = true
          }

          node.selector = `[data-iris-uid="${uidStr}"]`

          nodes.push(node)
          uid++
        }

        if (el.shadowRoot) {
          for (const child of el.shadowRoot.children) {
            const r = build(child, depth + 1, uid)
            nodes.push(...r.nodes)
            uid = r.nextUid
          }
        }

        for (const child of el.children) {
          const r = build(child, depth + 1, uid)
          nodes.push(...r.nodes)
          uid = r.nextUid
        }

        return { nodes, nextUid: uid }
      }

      function getAllLinks() {
        const links = []
        const seen = new Set()
        document.querySelectorAll("a[href]").forEach((a) => {
          const href = a.href
          if (href && !seen.has(href) && !href.startsWith("javascript:")) {
            seen.add(href)
            const text = a.innerText?.trim().slice(0, 100) || a.getAttribute("aria-label") || ""
            links.push({ href, text })
          }
        })
        return links.slice(0, 200)
      }

      let pageText = ""
      try {
        pageText = safeText(document.body?.innerText || "").slice(0, 20000)
      } catch {}

      // Clear prior snapshot stamps so eN renumbers cleanly each run
      try {
        document.querySelectorAll("[data-iris-uid]").forEach((el) => {
          try {
            el.removeAttribute("data-iris-uid")
          } catch {}
        })
        // shadow roots: walk open shadows shallowly
        const walk = (root) => {
          root.querySelectorAll("*").forEach((el) => {
            if (el.shadowRoot) {
              el.shadowRoot.querySelectorAll("[data-iris-uid]").forEach((n) => {
                try {
                  n.removeAttribute("data-iris-uid")
                } catch {}
              })
              walk(el.shadowRoot)
            }
          })
        }
        walk(document)
      } catch {}

      const built = build(document.body).nodes.slice(0, 800)


      return {
        url: location.href,
        title: document.title,
        text: pageText,
        nodes: built,
        links: getAllLinks(),
      }
    },
    world: "ISOLATED",
  })

  return { tabId: tab.id, content: JSON.stringify(result[0]?.result, null, 2) }
}

async function toolGetTabs() {
  const tabs = await chrome.tabs.query({})
  const out = tabs.map((t) => ({ id: t.id, url: t.url, title: t.title, active: t.active, windowId: t.windowId }))
  return { content: JSON.stringify(out, null, 2) }
}

async function toolQuery({
  tabId,
  selector,
  mode = "text",
  attribute,
  property,
  limit,
  index = 0,
  timeoutMs,
  pollMs,
  pattern,
  flags,
}) {
  if (!selector && mode !== "page_text") throw new Error("selector is required")
  const tab = await getTabById(tabId)

  const result = await runInPage(tab.id, "query", {
    selector,
    mode,
    attribute,
    property,
    limit,
    index,
    timeoutMs,
    pollMs,
    pattern,
    flags,
  })

  if (!result?.ok) throw new Error(result?.error || "Query failed")

  if (mode === "list" || mode === "property" || mode === "exists" || mode === "page_text") {
    return { tabId: tab.id, content: JSON.stringify(result, null, 2) }
  }

  return { tabId: tab.id, content: typeof result.value === "string" ? result.value : JSON.stringify(result.value) }
}

async function toolScroll({ x = 0, y = 0, selector, tabId, timeoutMs, pollMs }) {
  const tab = await getTabById(tabId)

  const result = await runInPage(tab.id, "scroll", { x, y, selector, timeoutMs, pollMs })
  if (!result?.ok) throw new Error(result?.error || "Scroll failed")
  const target = result.selectorUsed ? `to ${result.selectorUsed}` : `by (${x}, ${y})`
  return { tabId: tab.id, content: `Scrolled ${target}` }
}

async function toolWait({ ms = 1000, tabId }) {
  await new Promise((resolve) => setTimeout(resolve, ms))
  return { tabId, content: `Waited ${ms}ms` }
}

async function toolWaitFor({
  selector,
  text,
  pattern,
  urlPattern,
  state,
  networkIdleMs,
  timeoutMs,
  pollMs,
  tabId,
  index = 0,
  flags,
} = {}) {
  const tab = await getTabById(tabId)
  const timeout = clampNumber(timeoutMs, 0, 120000, 10000)
  const poll = clampNumber(pollMs, 50, 5000, 200)
  const wantsNetworkIdle =
    state === "networkidle" ||
    state === "network_idle" ||
    Number.isFinite(networkIdleMs)

  if (wantsNetworkIdle) {
    const idleMs = clampNumber(networkIdleMs, 100, 30000, 500)
    const { network } = await ensureNetworkEnabled(tab.id)
    const startAt = Date.now()
    const endAt = startAt + timeout

    while (true) {
      const now = Date.now()
      const active = [...network.requests.values()].some((record) => {
        return record.startedAt >= startAt && !record.finished && !record.failed
      })
      const quietFor = now - Math.max(network.lastEventAt || startAt, startAt)
      if (!active && quietFor >= idleMs) {
        return {
          tabId: tab.id,
          content: JSON.stringify({ ok: true, state: "networkidle", idleMs, quietFor }, null, 2),
        }
      }
      if (now >= endAt) throw new Error("Timed out waiting for network idle")
      await new Promise((resolve) => setTimeout(resolve, poll))
    }
  }

  const result = await runInPage(tab.id, "wait_for", {
    selector,
    text,
    pattern,
    urlPattern,
    state,
    timeoutMs: timeout,
    pollMs: poll,
    index,
    flags,
  })

  if (!result?.ok) throw new Error(result?.error || "Wait condition failed")
  return { tabId: tab.id, content: JSON.stringify(result, null, 2) }
}

function clampNumber(value, min, max, fallback) {
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.min(Math.max(n, min), max)
}

function normalizeDownloadTimeoutMs(value) {
  return clampNumber(value, 0, 60000, 60000)
}

function waitForNextDownloadCreated(timeoutMs) {
  const timeout = normalizeDownloadTimeoutMs(timeoutMs)
  return new Promise((resolve, reject) => {
    const listener = (item) => {
      cleanup()
      resolve(item)
    }

    const timer = timeout
      ? setTimeout(() => {
          cleanup()
          reject(new Error("Timed out waiting for download to start"))
        }, timeout)
      : null

    function cleanup() {
      chrome.downloads.onCreated.removeListener(listener)
      if (timer) clearTimeout(timer)
    }

    chrome.downloads.onCreated.addListener(listener)
  })
}

async function getDownloadById(downloadId) {
  const items = await chrome.downloads.search({ id: downloadId })
  return items && items.length ? items[0] : null
}

async function waitForDownloadCompletion(downloadId, timeoutMs) {
  const timeout = normalizeDownloadTimeoutMs(timeoutMs)
  const pollMs = 200
  const endAt = Date.now() + timeout

  while (true) {
    const item = await getDownloadById(downloadId)
    if (item && (item.state === "complete" || item.state === "interrupted")) return item
    if (!timeout || Date.now() >= endAt) return item
    await new Promise((resolve) => setTimeout(resolve, pollMs))
  }
}

async function toolDownload({
  url,
  selector,
  filename,
  conflictAction,
  saveAs = false,
  wait = false,
  downloadTimeoutMs,
  tabId,
  index = 0,
  timeoutMs,
  pollMs,
}) {
  const hasUrl = typeof url === "string" && url.trim()
  const hasSelector = typeof selector === "string" && selector.trim()

  await ensureDownloadsAvailable()

  if (!hasUrl && !hasSelector) throw new Error("url or selector is required")
  if (hasUrl && hasSelector) throw new Error("Provide either url or selector, not both")

  let downloadId = null

  if (hasUrl) {
    const options = { url: url.trim() }
    if (typeof filename === "string" && filename.trim()) options.filename = filename.trim()
    if (typeof conflictAction === "string" && conflictAction.trim()) options.conflictAction = conflictAction.trim()
    if (typeof saveAs === "boolean") options.saveAs = saveAs

    downloadId = await chrome.downloads.download(options)
  } else {
    const tab = await getTabById(tabId)
    const created = waitForNextDownloadCreated(downloadTimeoutMs)
    const clicked = await runInPage(tab.id, "click", { selector, index, timeoutMs, pollMs })
    if (!clicked?.ok) throw new Error(clicked?.error || "Click failed")
    const createdItem = await created
    downloadId = createdItem?.id
  }

  if (!Number.isFinite(downloadId)) throw new Error("Download did not start")

  if (!wait) {
    const item = await getDownloadById(downloadId)
    return { content: { downloadId, item } }
  }

  const item = await waitForDownloadCompletion(downloadId, downloadTimeoutMs)
  return { content: { downloadId, item } }
}

async function toolListDownloads({ limit = 20, state } = {}) {
  await ensureDownloadsAvailable()

  const limitValue = clampNumber(limit, 1, 200, 20)
  const query = { orderBy: ["-startTime"], limit: limitValue }
  if (typeof state === "string" && state.trim()) query.state = state.trim()

  const downloads = await chrome.downloads.search(query)
  const out = downloads.map((d) => ({
    id: d.id,
    url: d.url,
    filename: d.filename,
    state: d.state,
    bytesReceived: d.bytesReceived,
    totalBytes: d.totalBytes,
    startTime: d.startTime,
    endTime: d.endTime,
    error: d.error,
    mime: d.mime,
  }))

  return { content: JSON.stringify({ downloads: out }, null, 2) }
}

async function toolSetFileInput({ selector, tabId, index = 0, timeoutMs, pollMs, files }) {
  if (!selector) throw new Error("Selector is required")
  const tab = await getTabById(tabId)

  const result = await runInPage(tab.id, "set_file_input", { selector, index, timeoutMs, pollMs, files })
  if (!result?.ok) throw new Error(result?.error || "Failed to set file input")
  const used = result.selectorUsed || selector
  return { tabId: tab.id, content: JSON.stringify({ selector: used, ...result }, null, 2) }
}

async function toolHighlight({ selector, tabId, index = 0, duration, color, showInfo, timeoutMs, pollMs }) {
  if (!selector) throw new Error("Selector is required")
  const tab = await getTabById(tabId)

  const result = await runInPage(tab.id, "highlight", {
    selector,
    index,
    duration,
    color,
    showInfo,
    timeoutMs,
    pollMs,
  })
  if (!result?.ok) throw new Error(result?.error || "Highlight failed")
  return {
    tabId: tab.id,
    content: JSON.stringify({
      highlighted: true,
      tag: result.tag,
      id: result.id,
      selectorUsed: result.selectorUsed,
    }),
  }
}

async function toolNetworkStart({ tabId, clear = true, maxEntries } = {}) {
  const tab = await getTabById(tabId)
  const { network } = await ensureNetworkEnabled(tab.id, { clear, maxEntries })
  return {
    tabId: tab.id,
    content: JSON.stringify(
      {
        ok: true,
        enabled: network.enabled,
        startedAt: network.startedAt,
        count: network.order.length,
        maxEntries: network.maxEntries,
      },
      null,
      2
    ),
  }
}

async function toolNetworkStop({ tabId } = {}) {
  const tab = await getTabById(tabId)
  const state = await ensureDebuggerAttached(tab.id)
  const network = state.network
  if (state.attached && network?.enabled) {
    try {
      await chrome.debugger.sendCommand({ tabId: tab.id }, "Network.disable")
    } catch {}
    network.enabled = false
    state.enabledDomains?.delete?.("Network")
  }
  return {
    tabId: tab.id,
    content: JSON.stringify({ ok: true, enabled: false, count: network?.order?.length || 0 }, null, 2),
  }
}

async function toolNetworkList({ tabId, limit = 100, includeHeaders = false, filter, clear = false } = {}) {
  const tab = await getTabById(tabId)
  const { network } = await ensureNetworkEnabled(tab.id, { clear: false })
  const maxItems = clampNumber(limit, 1, 1000, 100)
  const filterText = typeof filter === "string" && filter.trim() ? filter.trim().toLowerCase() : null
  let records = network.order.map((id) => network.requests.get(id)).filter(Boolean)

  if (filterText) {
    records = records.filter((record) => {
      const haystack = `${record.url || ""} ${record.method || ""} ${record.status || ""} ${record.type || ""}`.toLowerCase()
      return haystack.includes(filterText)
    })
  }

  const items = records.slice(-maxItems).map((record) => serializeNetworkRecord(record, includeHeaders))
  const out = {
    enabled: network.enabled,
    startedAt: network.startedAt,
    count: records.length,
    items,
  }

  if (clear) {
    network.requests.clear()
    network.order = []
    network.startedAt = Date.now()
    network.lastEventAt = Date.now()
  }

  return { tabId: tab.id, content: JSON.stringify(out, null, 2) }
}

async function toolNetworkGet({ tabId, requestId, index, includeBody = false, maxBodyBytes = 200000 } = {}) {
  const tab = await getTabById(tabId)
  const { network } = await ensureNetworkEnabled(tab.id, { clear: false })
  let id = typeof requestId === "string" && requestId ? requestId : null

  if (!id && Number.isFinite(index)) {
    id = network.order[index]
  }
  if (!id) {
    id = network.order[network.order.length - 1]
  }
  if (!id) throw new Error("No network requests captured")

  const record = network.requests.get(id)
  if (!record) throw new Error(`Unknown requestId: ${id}`)

  const out = serializeNetworkRecord(record, true)
  out.initiator = record.initiator
  out.documentURL = record.documentURL
  out.frameId = record.frameId
  out.loaderId = record.loaderId
  out.protocol = record.protocol
  out.remoteIPAddress = record.remoteIPAddress
  out.remotePort = record.remotePort

  if (includeBody) {
    try {
      const body = await chrome.debugger.sendCommand({ tabId: tab.id }, "Network.getResponseBody", { requestId: id })
      const limit = clampNumber(maxBodyBytes, 0, 5_000_000, 200000)
      const rawBody = typeof body?.body === "string" ? body.body : ""
      const redactedBody = redactNetworkBody(rawBody, { base64Encoded: !!body?.base64Encoded })
      out.body = redactedBody.text.slice(0, limit)
      out.base64Encoded = !!body?.base64Encoded
      out.bodyTruncated = redactedBody.text.length > limit
      if (redactedBody.redacted) out.bodyRedacted = true
    } catch (error) {
      out.bodyError = error?.message || String(error)
    }
  }

  return { tabId: tab.id, content: JSON.stringify(out, null, 2) }
}

async function toolConsole({ tabId, clear = false, filter } = {}) {
  const tab = await getTabById(tabId)
  const state = await ensureDebuggerAttached(tab.id)

  if (!state.attached) {
    return {
      tabId: tab.id,
      content: JSON.stringify({
        error: state.unavailableReason || "Debugger not attached. DevTools may be open or another debugger is active.",
        messages: [],
      }),
    }
  }

  let messages = [...state.consoleMessages]

  if (filter && typeof filter === "string") {
    const filterType = filter.toLowerCase()
    messages = messages.filter((m) => m.type === filterType)
  }

  if (clear) {
    state.consoleMessages = []
  }

  return {
    tabId: tab.id,
    content: JSON.stringify(messages, null, 2),
  }
}

async function toolErrors({ tabId, clear = false } = {}) {
  const tab = await getTabById(tabId)
  const state = await ensureDebuggerAttached(tab.id)

  if (!state.attached) {
    return {
      tabId: tab.id,
      content: JSON.stringify({
        error: state.unavailableReason || "Debugger not attached. DevTools may be open or another debugger is active.",
        errors: [],
      }),
    }
  }

  const errors = [...state.pageErrors]

  if (clear) {
    state.pageErrors = []
  }

  return {
    tabId: tab.id,
    content: JSON.stringify(errors, null, 2),
  }
}

chrome.runtime.onInstalled.addListener(() => connect().catch(() => {}))
chrome.runtime.onStartup.addListener(() => connect().catch(() => {}))

if (chrome.permissions?.onAdded) {
  chrome.permissions.onAdded.addListener(() => connect().catch(() => {}))
}

chrome.action.onClicked.addListener(async () => {
  const permissionResult = await requestOptionalPermissionsFromClick()
  if (!permissionResult.granted) {
    updateBadge(false)
    if (permissionResult.error) {
      console.warn("[Iris] Permission request failed:", permissionResult.error)
    } else {
      console.warn("[Iris] Permission request denied.")
    }
    return
  }

  if (permissionResult.requested) {
    const requestedPermissions = permissionResult.permissions.join(", ") || "none"
    const requestedOrigins = permissionResult.origins.join(", ") || "none"
    console.log(`[Iris] Requested permissions -> permissions: ${requestedPermissions}; origins: ${requestedOrigins}`)
  }

  await connect()
})

connect().catch(() => {})
