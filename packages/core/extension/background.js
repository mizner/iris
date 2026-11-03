import { redactHeaders, redactNetworkBody } from "./lib/network-redact.mjs"
import { diffSnapshots, indexByUid } from "./lib/snapshot-diff.mjs"

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
const lastSnapshot = new Map()
const agentCursorByTab = new Map()
let lastClaims = []
const MAX_LOG_ENTRIES = 1000
const MAX_NETWORK_ENTRIES = 1000
const AGENT_CURSOR_FADE_MS = 1200

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

// Tell the broker which Chrome profile this extension instance runs in, so it can route by profile.
async function sendIdentify() {
  try {
    const status = await toolGetProfileStatus()
    send({ type: "identify", profileId: status.profileId, allowed: status.allowed, version: runtimeManifest.version })
  } catch (e) {
    console.warn("[Iris] identify failed:", e)
  }
}

function hostOfUrl(url) {
  try {
    const parsed = new URL(url)
    return parsed.protocol === "http:" || parsed.protocol === "https:" ? parsed.hostname : ""
  } catch {
    return ""
  }
}

// Inventory for profile selection: counts and site hostnames only, no titles or full URLs.
async function toolProfileSummary() {
  const status = await toolGetProfileStatus()
  const windows = await chrome.windows.getAll({ populate: true, windowTypes: ["normal"] })
  const hostCounts = new Map()
  let tabCount = 0
  let windowFocused = false
  let activeHost = null
  for (const w of windows) {
    if (w.focused) windowFocused = true
    for (const t of w.tabs || []) {
      tabCount += 1
      const host = hostOfUrl(t.url)
      if (host) hostCounts.set(host, (hostCounts.get(host) || 0) + 1)
      if (w.focused && t.active) activeHost = host || null
    }
  }
  const domains = [...hostCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 60)
    .map(([host, count]) => ({ host, count }))
  return {
    content: {
      profileId: status.profileId,
      allowed: status.allowed,
      windowCount: windows.length,
      tabCount,
      windowFocused,
      activeHost,
      domains,
    },
  }
}

// WebMCP detection and integration
const WEBMCP_STORAGE_KEY = "webmcp_tokens"

function detectWebMCP() {
  // Check for legacy WebMCP
  const hasLegacyWidget = document?.querySelector?.("[data-webmcp-widget]") !== null
  const hasLegacyGlobal = typeof window?.webMCP !== "undefined"
  
  // Check for native/W3C WebMCP (Chromium moved it from navigator to document in July 2026)
  const hasNativeWebMCP =
    typeof document?.modelContext !== "undefined" || typeof navigator?.modelContext !== "undefined"
  
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
        // Chromium moved WebMCP from navigator.modelContext to document.modelContext in July 2026.
        const hasNativeWebMCP =
          typeof document.modelContext !== "undefined" || typeof navigator.modelContext !== "undefined"
        
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
    await ensureDebuggerDomain(tabId, state, "Page")
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

function cdpMouseButton(button) {
  const value = String(button || "left").toLowerCase()
  if (value === "right" || value === "middle") return value
  return "left"
}

function injectAgentCursor(fromX, fromY, toX, toY, fadeMs) {
  const ID = "__iris_agent_cursor"
  let host = document.getElementById(ID)
  if (!host) {
    host = document.createElement("div")
    host.id = ID
    document.documentElement.appendChild(host)
  }
  host.style.cssText = [
    "position:fixed",
    "left:0",
    "top:0",
    "width:14px",
    "height:14px",
    "margin-left:-3px",
    "margin-top:-3px",
    "border-radius:50% 50% 50% 0",
    "transform:rotate(-45deg)",
    "background:#22c55e",
    "box-shadow:0 0 0 2px #fff,0 0 12px #22c55e",
    "pointer-events:none",
    "z-index:2147483647",
  ].join(";")
  const start = performance.now()
  const dur = 200
  function frame(now) {
    const t = Math.min(1, (now - start) / dur)
    const ease = 1 - (1 - t) * (1 - t)
    host.style.left = `${fromX + (toX - fromX) * ease}px`
    host.style.top = `${fromY + (toY - fromY) * ease}px`
    if (t < 1) requestAnimationFrame(frame)
  }
  requestAnimationFrame(frame)
  clearTimeout(host._irisHide)
  host._irisHide = setTimeout(() => {
    try {
      host.remove()
    } catch {}
  }, fadeMs)
}

async function showAgentCursor(tabId, { x, y, fromX, fromY }) {
  const prev = agentCursorByTab.get(tabId)
  const startX = Number.isFinite(fromX) ? fromX : Number.isFinite(prev?.x) ? prev.x : x
  const startY = Number.isFinite(fromY) ? fromY : Number.isFinite(prev?.y) ? prev.y : y - 12
  agentCursorByTab.set(tabId, { x, y })
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      world: "ISOLATED",
      func: injectAgentCursor,
      args: [startX, startY, x, y, AGENT_CURSOR_FADE_MS],
    })
  } catch {
    // chrome:// and other restricted pages
  }
}

async function dispatchMouse(tabId, { type, x, y, button = "left", clickCount = 1, modifiers = 0 }) {
  await sendDebuggerCommand(tabId, "Input.dispatchMouseEvent", {
    type,
    x,
    y,
    button: cdpMouseButton(button),
    clickCount,
    modifiers,
  })
}

async function cdpClick(tabId, { x, y, button = "left", clickCount = 1, modifiers = 0 }) {
  const count = clickCount >= 2 ? 2 : 1
  await dispatchMouse(tabId, { type: "mouseMoved", x, y, button, clickCount: 1, modifiers })
  for (let i = 1; i <= count; i++) {
    await dispatchMouse(tabId, { type: "mousePressed", x, y, button, clickCount: i, modifiers })
    await dispatchMouse(tabId, { type: "mouseReleased", x, y, button, clickCount: i, modifiers })
  }
}

async function cdpDrag(tabId, from, to, steps = 8) {
  const modifiers = 0
  await dispatchMouse(tabId, { type: "mouseMoved", x: from.x, y: from.y, button: "left", clickCount: 1, modifiers })
  await dispatchMouse(tabId, { type: "mousePressed", x: from.x, y: from.y, button: "left", clickCount: 1, modifiers })
  const n = Math.max(2, steps)
  for (let i = 1; i <= n; i++) {
    const t = i / n
    await dispatchMouse(tabId, {
      type: "mouseMoved",
      x: from.x + (to.x - from.x) * t,
      y: from.y + (to.y - from.y) * t,
      button: "left",
      clickCount: 1,
      modifiers,
    })
  }
  await dispatchMouse(tabId, { type: "mouseReleased", x: to.x, y: to.y, button: "left", clickCount: 1, modifiers })
}

function waitForTabComplete(tabId, timeoutMs = 30000) {
  return new Promise((resolve) => {
    const listener = (updatedTabId, info) => {
      if (updatedTabId === tabId && info.status === "complete") {
        chrome.tabs.onUpdated.removeListener(listener)
        clearTimeout(timer)
        resolve({ completed: true })
      }
    }
    const timer = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener)
      resolve({ completed: false })
    }, timeoutMs)
    chrome.tabs.onUpdated.addListener(listener)
  })
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

    if (method === "Page.javascriptDialogOpening") {
      state.pendingDialog = {
        type: params.type || "alert",
        message: params.message || "",
        url: params.url || "",
        defaultPrompt: params.defaultPrompt || "",
      }
    }

    if (method === "Page.javascriptDialogClosed") {
      state.pendingDialog = null
    }

    if (method === "Page.fileChooserOpened" && state.fileChooserWaiter) {
      state.fileChooserWaiter(params)
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
  lastSnapshot.delete(tabId)
  agentCursorByTab.delete(tabId)
  for (const key of lastScreenshotHash.keys()) if (key.startsWith(`${tabId}|`)) lastScreenshotHash.delete(key)
  // Let the broker drop claims and default-tab pointers for the closed tab.
  if (isConnected && lastClaims.some((claim) => claim.tabId === tabId)) send({ type: "release_tab", tabId })
})

// Popups and new tabs opened from a claimed tab (OAuth windows, target=_blank, window.open) belong to the same
// session: put them in the opener's tab group and tell the broker so it claims them.
const reportedOpenedTabs = new Set()

async function reportOpenedTab(tabId, openerTabId, knownUrl = "") {
  if (!Number.isFinite(tabId) || !Number.isFinite(openerTabId) || reportedOpenedTabs.has(tabId)) return
  if (!lastClaims.some((claim) => claim.tabId === openerTabId)) return
  reportedOpenedTabs.add(tabId)
  const [tab, opener] = await Promise.all([chrome.tabs.get(tabId).catch(() => null), chrome.tabs.get(openerTabId).catch(() => null)])
  if (!tab) return
  const win = await chrome.windows.get(tab.windowId).catch(() => null)
  if (opener && opener.groupId >= 0 && opener.windowId === tab.windowId && chrome.tabs.group) {
    await chrome.tabs.group({ groupId: opener.groupId, tabIds: [tabId] }).catch(() => {})
  }
  if (isConnected) {
    send({
      type: "tab_opened",
      tabId,
      openerTabId,
      url: knownUrl || tab.pendingUrl || tab.url || "",
      windowType: win?.type || "normal",
    })
  }
}

// onCreatedNavigationTarget carries the real source tab and the URL; onCreated is a delayed fallback for tabs
// it does not cover, by which time the URL is known.
if (chrome.webNavigation?.onCreatedNavigationTarget) {
  chrome.webNavigation.onCreatedNavigationTarget.addListener((details) => {
    reportOpenedTab(details.tabId, details.sourceTabId, details.url)
  })
}

chrome.tabs.onCreated.addListener((tab) => {
  if (Number.isFinite(tab.openerTabId)) setTimeout(() => reportOpenedTab(tab.id, tab.openerTabId), 500)
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

function applyClaims(claims) {
  lastClaims = Array.isArray(claims) ? claims : []
  if (isConnected) updateBadge(true)
}

function updateBadge(connected) {
  const n = lastClaims.length
  if (!connected) {
    chrome.action.setBadgeText({ text: "" })
    chrome.action.setBadgeBackgroundColor({ color: "#ef4444" })
    chrome.action.setTitle({ title: "Iris: disconnected — click to reconnect" })
    return
  }
  if (n > 0) {
    chrome.action.setBadgeText({ text: String(n) })
    chrome.action.setBadgeBackgroundColor({ color: "#f59e0b" })
    const noun = n === 1 ? "tab" : "tabs"
    chrome.action.setTitle({ title: `Iris: ${n} ${noun} claimed — click to take this tab back` })
    return
  }
  chrome.action.setBadgeText({ text: "ON" })
  chrome.action.setBadgeBackgroundColor({ color: "#22c55e" })
  chrome.action.setTitle({ title: "Iris: connected" })
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
  return t === "ping" || t === "tool_request" || t === "reload" || t === "claims" || t === "identify_request"
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
    if (message.type !== "identify_request") sendIdentify()
  }

  if (Array.isArray(message.claims)) applyClaims(message.claims)

  if (message.type === "tool_request") {
    await handleToolRequest(message)
  } else if (message.type === "ping") {
    send({ type: "pong" })
  } else if (message.type === "claims") {
    applyClaims(message.claims)
  } else if (message.type === "identify_request") {
    await sendIdentify()
  } else if (message.type === "config_response") {
    const cfg = message.config || {}
    const allowlist = normalizeAllowlist(cfg.profileEmails)
    await chrome.storage.local.set({ [ALLOWLIST_STORAGE_KEY]: allowlist })
    profileVerified = false // re-verify on next tool call with fresh allowlist
    if (isConnected) await sendIdentify()
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
    hover: toolHover,
    drag: toolDrag,
    type: toolType,
    press: toolPress,
    select: toolSelect,
    screenshot: toolScreenshot,
    snapshot: toolSnapshot,
    query: toolQuery,
    scroll: toolScroll,
    wait: toolWait,
    wait_for: toolWaitFor,
    history: toolHistory,
    handle_dialog: toolHandleDialog,
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
    profile_summary: toolProfileSummary,
    get_webmcp_status: toolGetWebMCPStatus,
    request_user: toolRequestUser,
    evaluate: toolEvaluate,
    read: toolRead,
    search_history: toolSearchHistory,
    bookmarks: toolBookmarks,
    recently_closed: toolRecentlyClosed,
    upload: toolUpload,
    name_group: toolNameGroup,
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
  if (!tabId) return await getActiveTab()
  try {
    return await chrome.tabs.get(tabId)
  } catch (error) {
    if (/No tab with id/i.test(error?.message || "")) {
      throw new Error(
        `TAB_NOT_FOUND: Tab ${tabId} no longer exists in this Chrome profile (closed, or it belongs to another profile). ` +
          "Call browser_get_tabs for current tab ids, or omit tabId to use this session's own tab."
      )
    }
    throw error
  }
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

  function clickElement(el, options = {}) {
    try {
      el.scrollIntoView({ block: "center", inline: "center" })
    } catch {}

    const rect = el.getBoundingClientRect()
    const x = Math.min(Math.max(rect.left + rect.width / 2, 0), window.innerWidth - 1)
    const y = Math.min(Math.max(rect.top + rect.height / 2, 0), window.innerHeight - 1)
    const buttonName = String(options.button || "left").toLowerCase()
    const button = buttonName === "right" ? 2 : buttonName === "middle" ? 1 : 0
    const clickCount = Number(options.clickCount) >= 2 ? 2 : 1
    const buttons = button === 2 ? 2 : button === 1 ? 4 : 1
    const opts = { bubbles: true, cancelable: true, view: window, clientX: x, clientY: y, button, buttons }

    try {
      el.dispatchEvent(new MouseEvent("mouseover", opts))
      el.dispatchEvent(new MouseEvent("mousemove", opts))
      el.dispatchEvent(new MouseEvent("mousedown", opts))
      el.dispatchEvent(new MouseEvent("mouseup", opts))
      if (button === 2) {
        el.dispatchEvent(new MouseEvent("contextmenu", opts))
      } else {
        el.dispatchEvent(new MouseEvent("click", opts))
        if (clickCount >= 2) {
          el.dispatchEvent(new MouseEvent("mousedown", opts))
          el.dispatchEvent(new MouseEvent("mouseup", opts))
          el.dispatchEvent(new MouseEvent("dblclick", opts))
        }
      }
    } catch {}

    if (button === 0 && clickCount === 1) {
      try {
        el.click()
      } catch {}
    }
  }

  function hoverElement(el) {
    try {
      el.scrollIntoView({ block: "center", inline: "center" })
    } catch {}
    const rect = el.getBoundingClientRect()
    const x = Math.min(Math.max(rect.left + rect.width / 2, 0), window.innerWidth - 1)
    const y = Math.min(Math.max(rect.top + rect.height / 2, 0), window.innerHeight - 1)
    const opts = { bubbles: true, cancelable: true, view: window, clientX: x, clientY: y }
    try {
      el.dispatchEvent(new MouseEvent("mouseover", opts))
      el.dispatchEvent(new MouseEvent("mouseenter", opts))
      el.dispatchEvent(new MouseEvent("mousemove", opts))
    } catch {}
  }

  function dragElements(fromEl, toEl) {
    const fromRect = fromEl.getBoundingClientRect()
    const toRect = toEl.getBoundingClientRect()
    const fx = fromRect.left + fromRect.width / 2
    const fy = fromRect.top + fromRect.height / 2
    const tx = toRect.left + toRect.width / 2
    const ty = toRect.top + toRect.height / 2
    const dt = new DataTransfer()
    const startOpts = { bubbles: true, cancelable: true, view: window, clientX: fx, clientY: fy, dataTransfer: dt, buttons: 1 }
    const endOpts = { bubbles: true, cancelable: true, view: window, clientX: tx, clientY: ty, dataTransfer: dt, buttons: 1 }
    fromEl.dispatchEvent(new MouseEvent("mousedown", startOpts))
    fromEl.dispatchEvent(new DragEvent("dragstart", startOpts))
    toEl.dispatchEvent(new DragEvent("dragenter", endOpts))
    toEl.dispatchEvent(new DragEvent("dragover", endOpts))
    toEl.dispatchEvent(new DragEvent("drop", endOpts))
    fromEl.dispatchEvent(new DragEvent("dragend", endOpts))
    toEl.dispatchEvent(new MouseEvent("mouseup", endOpts))
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

  const MODE_ALIASES = { count: "exists", all: "list", page: "page_text" }
  const rawMode = typeof options.mode === "string" && options.mode ? options.mode : "text"
  const mode = MODE_ALIASES[rawMode] || rawMode
  const QUERY_MODES = ["text", "value", "attribute", "property", "html", "list", "exists", "page_text"]
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
    clickElement(match.chosen, { button: options.button, clickCount: options.clickCount })
    return { ok: true, selectorUsed: match.selectorUsed }
  }

  if (command === "hover") {
    const match = await resolveMatches(selectors, index, timeoutMs, pollMs)
    if (!match.chosen) {
      return { ok: false, error: `Element not found for selectors: ${selectors.join(", ")}` }
    }
    hoverElement(match.chosen)
    return { ok: true, selectorUsed: match.selectorUsed }
  }

  if (command === "drag") {
    const fromSelectors = normalizeSelectorList(options.fromSelector || options.selector)
    const toSelectors = normalizeSelectorList(options.toSelector)
    const fromIndex = Number.isFinite(options.fromIndex) ? options.fromIndex : index
    const toIndex = Number.isFinite(options.toIndex) ? options.toIndex : 0
    if (!fromSelectors.length || !toSelectors.length) {
      return { ok: false, error: "fromSelector and toSelector are required" }
    }
    const from = await resolveMatches(fromSelectors, fromIndex, timeoutMs, pollMs)
    const to = await resolveMatches(toSelectors, toIndex, timeoutMs, pollMs)
    if (!from.chosen) return { ok: false, error: `Drag source not found for selectors: ${fromSelectors.join(", ")}` }
    if (!to.chosen) return { ok: false, error: `Drag target not found for selectors: ${toSelectors.join(", ")}` }
    try {
      from.chosen.scrollIntoView({ block: "center", inline: "center" })
    } catch {}
    dragElements(from.chosen, to.chosen)
    return { ok: true, fromSelectorUsed: from.selectorUsed, toSelectorUsed: to.selectorUsed }
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
    let submitted = false
    try {
      const notCancelled = target.dispatchEvent(new KeyboardEvent("keydown", opts))
      target.dispatchEvent(new KeyboardEvent("keypress", opts))
      target.dispatchEvent(new KeyboardEvent("keyup", opts))
      // Synthetic key events have no default action, so emulate the browser's implicit form submission.
      const plainEnter = key === "Enter" && !mod.ctrlKey && !mod.metaKey && !mod.altKey
      if (plainEnter && notCancelled && target.tagName === "INPUT" && target.form) {
        target.form.requestSubmit()
        submitted = true
      }
    } catch (e) {
      return { ok: false, error: e?.message || String(e) }
    }
    return { ok: true, key, selectorUsed, method: "dom", submitted }
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

  if (command === "mark") {
    const match = await resolveMatches(selectors, index, timeoutMs, pollMs)
    if (!match.chosen) return { ok: false, error: `Element not found for selectors: ${selectors.join(", ")}` }
    match.chosen.setAttribute("data-iris-mark", safeString(options.token))
    const isFileInput = match.chosen.tagName === "INPUT" && String(match.chosen.type).toLowerCase() === "file"
    return { ok: true, selectorUsed: match.selectorUsed, isFileInput }
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

    if (!QUERY_MODES.includes(mode)) {
      return { ok: false, error: `Unknown mode: ${rawMode}. Valid modes: ${QUERY_MODES.join(", ")} (count is an alias of exists).` }
    }

    if (!selectors.length) {
      return { ok: false, error: `selector is required for mode=${mode}; use mode=page_text to read the whole page.` }
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
      return {
        ok: false,
        error:
          `No matches for selectors: ${selectors.join(", ")}. ` +
          "mode=exists returns {exists:false} instead of failing; browser_snapshot or " +
          'browser_query mode=list selector="button,a,input,textarea,[role]" shows what is on the page.',
      }
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

    return { ok: false, error: `Unknown mode: ${rawMode}. Valid modes: ${QUERY_MODES.join(", ")}.` }
  }

  return { ok: false, error: `Unknown command: ${String(command)}` }
}

async function toolGetActiveTab() {
  const tab = await getActiveTab()
  const pendingDialog = debuggerState.get(tab.id)?.pendingDialog || null
  const win = await chrome.windows.get(tab.windowId).catch(() => null)
  return {
    tabId: tab.id,
    content: { tabId: tab.id, url: tab.url, title: tab.title, pendingDialog, windowFocused: !!win?.focused },
  }
}

// Agent tabs are collected in one Chrome tab group per session so they are visible and easy to close together.
// Join the group of anchorTabId (another tab of the same session) when it is in this window; otherwise start a new
// group. Matching by title alone would merge two sessions that happen to share a name ("codeable · omo").
async function addToSessionGroup(tab, title, color, anchorTabId) {
  if (!chrome.tabGroups || !chrome.tabs.group || !title) return null
  try {
    const anchor = Number.isFinite(anchorTabId) ? await chrome.tabs.get(anchorTabId).catch(() => null) : null
    if (anchor && anchor.groupId >= 0 && anchor.windowId === tab.windowId) {
      await chrome.tabs.group({ groupId: anchor.groupId, tabIds: [tab.id] })
      return anchor.groupId
    }
    const groupId = await chrome.tabs.group({ tabIds: [tab.id], createProperties: { windowId: tab.windowId } })
    await chrome.tabGroups.update(groupId, { title, color: color || "green" })
    return groupId
  } catch (error) {
    console.warn("[Iris] Could not group tab:", error?.message || error)
    return null
  }
}

// Background by default: agents should not take over the tab the user is looking at.
async function toolOpenTab({ url, active = false, group, groupColor, groupWith }) {
  const createOptions = {}
  if (typeof url === "string" && url.trim()) createOptions.url = url.trim()
  if (typeof active === "boolean") createOptions.active = active

  const tab = await chrome.tabs.create(createOptions)
  const groupId = await addToSessionGroup(tab, group, groupColor, groupWith)
  return { tabId: tab.id, content: { tabId: tab.id, url: tab.url, active: tab.active, groupId } }
}

// Retitle the groups holding these tabs; loose tabs join the first of those groups (or a new one) per window.
async function toolNameGroup({ tabIds = [], title, color } = {}) {
  if (!chrome.tabGroups || !chrome.tabs.group) throw new Error("Tab groups unavailable. Reload the Iris extension.")
  if (typeof title !== "string" || !title.trim()) throw new Error("title is required")
  const tabs = (await Promise.all(tabIds.map((id) => chrome.tabs.get(id).catch(() => null)))).filter(Boolean)
  const groups = new Set()
  const groupByWindow = new Map()
  for (const tab of tabs) {
    if (tab.groupId < 0) continue
    if (!groups.has(tab.groupId)) {
      await chrome.tabGroups.update(tab.groupId, { title, ...(color ? { color } : {}) })
      groups.add(tab.groupId)
    }
    if (!groupByWindow.has(tab.windowId)) groupByWindow.set(tab.windowId, tab.groupId)
  }
  for (const tab of tabs) {
    if (tab.groupId >= 0) continue
    const existing = groupByWindow.get(tab.windowId)
    if (existing !== undefined) {
      await chrome.tabs.group({ groupId: existing, tabIds: [tab.id] }).catch(() => {})
    } else {
      const gid = await addToSessionGroup(tab, title, color)
      if (gid !== null) {
        groups.add(gid)
        groupByWindow.set(tab.windowId, gid)
      }
    }
  }
  return { content: { title, groups: [...groups] } }
}

// Runs in the page (isolated world): shows or removes the handoff banner and checks the completion condition.
function irisUserPrompt(message, selector, text, mode) {
  const ID = "__iris_user_prompt"
  let bar = document.getElementById(ID)
  if (mode === "remove") {
    bar?.remove()
    return { done: false, matched: false }
  }
  if (mode === "start") window.__irisUserDone = false
  if (!bar && !window.__irisUserDone) {
    bar = document.createElement("div")
    bar.id = ID
    bar.style.cssText =
      "position:fixed;top:0;left:0;right:0;z-index:2147483647;display:flex;gap:12px;align-items:center;" +
      "padding:10px 16px;background:#14532d;color:#fff;font:14px/1.4 system-ui,sans-serif;box-shadow:0 2px 8px rgba(0,0,0,.3)"
    const label = document.createElement("span")
    label.style.flex = "1"
    label.textContent = `Iris: ${message} The agent is waiting; click Done when finished.`
    const button = document.createElement("button")
    button.textContent = "Done"
    button.style.cssText = "padding:4px 14px;border:0;border-radius:4px;background:#22c55e;color:#052e16;font-weight:600;cursor:pointer"
    button.addEventListener("click", () => {
      window.__irisUserDone = true
      bar.remove()
    })
    bar.append(label, button)
    ;(document.body || document.documentElement).appendChild(bar)
  }
  let matched = false
  try {
    if (selector) matched = !!document.querySelector(selector)
    if (!matched && text) matched = (document.body?.innerText || "").includes(text)
  } catch {}
  return { done: !!window.__irisUserDone, matched }
}

function urlMatches(url, pattern) {
  if (!pattern || !url) return false
  try {
    return new RegExp(pattern).test(url) || url.includes(pattern)
  } catch {
    return url.includes(pattern)
  }
}

async function injectUserPrompt(tabId, message, selector, text, mode) {
  try {
    const [res] = await chrome.scripting.executeScript({
      target: { tabId },
      world: "ISOLATED",
      func: irisUserPrompt,
      args: [message, selector || "", text || "", mode],
    })
    return res?.result || { done: false, matched: false }
  } catch {
    // Mid-navigation or a restricted page (chrome://, Web Store): try again on the next poll.
    return { done: false, matched: false }
  }
}

// Hand the tab to the user (sign-in, 2FA, CAPTCHA, a choice only they can make) and wait until they finish.
async function toolRequestUser({ message, tabId, urlPattern, selector, text, timeoutMs, focus = true } = {}) {
  if (typeof message !== "string" || !message.trim()) throw new Error("message is required")
  const tab = await getTabById(tabId)
  const timeout = clampNumber(timeoutMs, 5000, 1800000, 300000)
  const startUrl = tab.url || ""

  if (focus !== false) {
    await chrome.tabs.update(tab.id, { active: true })
    await chrome.windows.update(tab.windowId, { focused: true, drawAttention: true }).catch(() => {})
  }
  if (chrome.notifications?.create) {
    chrome.notifications
      .create(`iris-handoff-${tab.id}`, {
        type: "basic",
        iconUrl: "icons/icon128.png",
        title: "Iris needs you",
        message: message.trim(),
        requireInteraction: true,
      })
      .catch(() => {})
  }

  let mode = "start"
  const endAt = Date.now() + timeout
  let status = "timeout"
  let finalUrl = startUrl
  while (Date.now() < endAt) {
    const current = await chrome.tabs.get(tab.id).catch(() => null)
    if (!current) {
      status = "tab_closed"
      break
    }
    finalUrl = current.url || finalUrl
    if (urlPattern && urlMatches(finalUrl, urlPattern)) {
      status = "condition_met"
      break
    }
    const check = await injectUserPrompt(tab.id, message.trim(), selector, text, mode)
    mode = "poll"
    if (check.matched) {
      status = "condition_met"
      break
    }
    if (check.done) {
      status = "user_done"
      break
    }
    await new Promise((resolve) => setTimeout(resolve, 1000))
  }

  if (status !== "tab_closed") await injectUserPrompt(tab.id, "", "", "", "remove")
  chrome.notifications?.clear?.(`iris-handoff-${tab.id}`).catch?.(() => {})
  return {
    tabId: tab.id,
    content: JSON.stringify({ ok: status === "condition_met" || status === "user_done", status, url: finalUrl }, null, 2),
  }
}

// --- The profile's own memory: history, bookmarks, recently closed tabs, other devices ---

async function toolSearchHistory({ query = "", days = 30, maxResults = 50 } = {}) {
  if (!chrome.history?.search) throw new Error("History permission not granted. Reload the Iris extension.")
  const startTime = Date.now() - clampNumber(days, 0.01, 3650, 30) * 86400000
  const items = await chrome.history.search({ text: String(query || ""), startTime, maxResults: clampNumber(maxResults, 1, 1000, 50) })
  const out = items.map((item) => ({
    url: item.url,
    title: item.title,
    lastVisit: item.lastVisitTime ? new Date(item.lastVisitTime).toISOString() : null,
    visits: item.visitCount,
  }))
  return { content: JSON.stringify(out, null, 2) }
}

async function bookmarkFolderPath(parentId, cache) {
  const parts = []
  let id = parentId
  while (id && id !== "0") {
    if (!cache.has(id)) {
      const [node] = await chrome.bookmarks.get(id).catch(() => [null])
      cache.set(id, node)
    }
    const node = cache.get(id)
    if (!node) break
    if (node.title) parts.unshift(node.title)
    id = node.parentId
  }
  return parts.join(" / ")
}

async function toolBookmarks({ query = "", maxResults = 50 } = {}) {
  if (!chrome.bookmarks) throw new Error("Bookmarks permission not granted. Reload the Iris extension.")
  const limit = clampNumber(maxResults, 1, 1000, 50)
  const nodes = String(query || "").trim()
    ? (await chrome.bookmarks.search(String(query))).filter((n) => n.url)
    : await chrome.bookmarks.getRecent(limit)
  const cache = new Map()
  const out = []
  for (const node of nodes.slice(0, limit)) {
    out.push({
      title: node.title,
      url: node.url,
      folder: await bookmarkFolderPath(node.parentId, cache),
      added: node.dateAdded ? new Date(node.dateAdded).toISOString() : null,
    })
  }
  return { content: JSON.stringify(out, null, 2) }
}

function describeSessionTab(tab) {
  return { url: tab.url, title: tab.title }
}

async function toolRecentlyClosed({ maxResults = 25, devices = false, restore } = {}) {
  if (!chrome.sessions) throw new Error("Sessions permission not granted. Reload the Iris extension.")
  if (restore) {
    const restored = await chrome.sessions.restore(String(restore))
    const tab = restored?.tab || restored?.window?.tabs?.[0]
    return { tabId: tab?.id, content: { restored: true, tabId: tab?.id, url: tab?.url, title: tab?.title } }
  }
  const limit = clampNumber(maxResults, 1, 25, 25)
  const closed = await chrome.sessions.getRecentlyClosed({ maxResults: limit })
  const out = {
    recentlyClosed: closed.map((s) =>
      s.tab
        ? { sessionId: s.tab.sessionId, closedAt: new Date(s.lastModified * 1000).toISOString(), ...describeSessionTab(s.tab) }
        : {
            sessionId: s.window?.sessionId,
            closedAt: new Date(s.lastModified * 1000).toISOString(),
            window: true,
            tabs: (s.window?.tabs || []).map(describeSessionTab),
          }
    ),
  }
  if (devices) {
    const list = await chrome.sessions.getDevices({ maxResults: 10 }).catch(() => [])
    out.otherDevices = list.map((d) => ({
      device: d.deviceName,
      tabs: d.sessions.flatMap((s) => s.window?.tabs || (s.tab ? [s.tab] : [])).map(describeSessionTab).slice(0, 50),
    }))
  }
  return { content: JSON.stringify(out, null, 2) }
}

// Upload real files by path. A file input gets the files directly; any other element (a custom "Upload" button)
// is clicked with a user gesture and Chrome's native file chooser is intercepted, so no OS dialog ever appears.
async function toolUpload({ selector, files, tabId, index = 0, timeoutMs = 2000, pollMs } = {}) {
  const paths = (Array.isArray(files) ? files : [files]).filter((f) => typeof f === "string" && f.trim())
  if (!paths.length) throw new Error("files is required (absolute paths)")
  if (!selector) throw new Error("selector is required: the file input or the button that opens the file chooser")
  const tab = await getTabById(tabId)
  const state = await ensureDebuggerAttached(tab.id)
  if (!state.attached) throw new Error(state.unavailableReason || "Debugger not attached; browser_upload needs it.")

  const token = `u${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
  const mark = await runInPage(tab.id, "mark", { selector, index, timeoutMs, pollMs, token })
  if (!mark?.ok) throw new Error(mark?.error || "Element not found")

  const found = await chrome.debugger.sendCommand({ tabId: tab.id }, "Runtime.evaluate", {
    expression: `(() => {
      const find = (root) => {
        const hit = root.querySelector('[data-iris-mark="${token}"]')
        if (hit) return hit
        for (const el of root.querySelectorAll("*")) if (el.shadowRoot) { const deep = find(el.shadowRoot); if (deep) return deep }
        return null
      }
      const el = find(document)
      if (el) el.removeAttribute("data-iris-mark")
      return el
    })()`,
  })
  const objectId = found?.result?.objectId
  if (!objectId) throw new Error("Could not reach the element through the debugger")

  if (mark.isFileInput) {
    await chrome.debugger.sendCommand({ tabId: tab.id }, "DOM.setFileInputFiles", { files: paths, objectId })
    return { tabId: tab.id, content: JSON.stringify({ ok: true, via: "file-input", files: paths }, null, 2) }
  }

  await chrome.debugger.sendCommand({ tabId: tab.id }, "Page.setInterceptFileChooserDialog", { enabled: true })
  try {
    const opened = new Promise((resolve) => {
      const timer = setTimeout(() => {
        state.fileChooserWaiter = null
        resolve(null)
      }, 5000)
      state.fileChooserWaiter = (params) => {
        clearTimeout(timer)
        state.fileChooserWaiter = null
        resolve(params)
      }
    })
    await chrome.debugger.sendCommand({ tabId: tab.id }, "Runtime.callFunctionOn", {
      objectId,
      functionDeclaration: "function () { this.scrollIntoView({ block: 'center' }); this.click() }",
      userGesture: true,
    })
    const chooser = await opened
    if (!chooser) {
      throw new Error("Clicking the element did not open a file chooser. Point selector at the upload button or the input[type=file].")
    }
    const list = chooser.mode === "selectSingle" ? paths.slice(0, 1) : paths
    await chrome.debugger.sendCommand({ tabId: tab.id }, "DOM.setFileInputFiles", { files: list, backendNodeId: chooser.backendNodeId })
    return {
      tabId: tab.id,
      content: JSON.stringify(
        { ok: true, via: "file-chooser", mode: chooser.mode, files: list, ...(list.length < paths.length ? { note: "Chooser accepts one file; extra files ignored." } : {}) },
        null,
        2
      ),
    }
  } finally {
    await chrome.debugger.sendCommand({ tabId: tab.id }, "Page.setInterceptFileChooserDialog", { enabled: false }).catch(() => {})
  }
}

// Evaluate JavaScript in the page's main world. CDP Runtime.evaluate is used first because it ignores page CSP
// and can await promises; without the debugger it falls back to a main-world script (blocked by strict CSP).
async function toolEvaluate({ expression, tabId, awaitPromise = true, maxChars = 20000 } = {}) {
  if (typeof expression !== "string" || !expression.trim()) throw new Error("expression is required")
  const tab = await getTabById(tabId)
  const limit = clampNumber(maxChars, 100, 500000, 20000)
  const format = (value, via) => {
    let text
    try {
      text = typeof value === "string" ? value : JSON.stringify(value, null, 2)
    } catch {
      text = String(value)
    }
    if (text === undefined) text = "undefined"
    const truncated = text.length > limit
    return { tabId: tab.id, content: truncated ? `${text.slice(0, limit)}\n[truncated ${text.length - limit} chars; via ${via}]` : text }
  }

  const state = await ensureDebuggerAttached(tab.id)
  if (state.attached) {
    const res = await chrome.debugger.sendCommand({ tabId: tab.id }, "Runtime.evaluate", {
      expression,
      awaitPromise: awaitPromise !== false,
      returnByValue: true,
      userGesture: true,
      replMode: true,
    })
    if (res?.exceptionDetails) {
      const detail = res.exceptionDetails.exception?.description || res.exceptionDetails.text || "Evaluation failed"
      throw new Error(`Evaluation threw: ${detail}`)
    }
    const remote = res?.result || {}
    return format("value" in remote ? remote.value : remote.description ?? remote.type, "cdp")
  }

  const [res] = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    world: "MAIN",
    func: async (code) => {
      try {
        const value = await (0, eval)(code)
        return { ok: true, value: value === undefined ? null : JSON.parse(JSON.stringify(value)) }
      } catch (error) {
        return { ok: false, error: error?.message || String(error) }
      }
    },
    args: [expression],
  })
  const out = res?.result
  if (!out?.ok) throw new Error(`Evaluation failed: ${out?.error || "no result"} (debugger unavailable: ${state.unavailableReason || "unknown"})`)
  return format(out.value, "main-world script")
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
  await waitForTabComplete(tab.id)
  return { tabId: tab.id, content: `Navigated to ${url}` }
}

async function toolHistory({ action, tabId } = {}) {
  const op = String(action || "").toLowerCase()
  if (!["back", "forward", "reload"].includes(op)) {
    throw new Error("action must be back, forward, or reload")
  }
  const tab = await getTabById(tabId)
  const beforeUrl = tab.url
  if (op === "back") {
    try {
      await chrome.tabs.goBack(tab.id)
    } catch {
      return { tabId: tab.id, content: { action: op, changed: false } }
    }
  } else if (op === "forward") {
    try {
      await chrome.tabs.goForward(tab.id)
    } catch {
      return { tabId: tab.id, content: { action: op, changed: false } }
    }
  } else {
    await chrome.tabs.reload(tab.id)
  }

  const waitMs = op === "reload" ? 30000 : 2000
  const result = await waitForTabComplete(tab.id, waitMs)
  const after = await chrome.tabs.get(tab.id).catch(() => tab)
  const changed = op === "reload" ? result.completed : after.url !== beforeUrl || result.completed
  return { tabId: tab.id, content: { action: op, changed, url: after.url } }
}

async function toolHandleDialog({ accept, promptText, tabId } = {}) {
  if (typeof accept !== "boolean") throw new Error("accept is required")
  const tab = await getTabById(tabId)
  const state = await ensureDebuggerAttached(tab.id)
  if (!state.attached) {
    throw new Error(state.unavailableReason || "Debugger not attached. DevTools may be open or another debugger is active.")
  }
  await ensureDebuggerDomain(tab.id, state, "Page")
  if (!state.pendingDialog) {
    const deadline = Date.now() + 2000
    while (!state.pendingDialog && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 50))
    }
  }
  const params = { accept }
  if (typeof promptText === "string") params.promptText = promptText
  try {
    await sendDebuggerCommand(tab.id, "Page.handleJavaScriptDialog", params)
  } catch (error) {
    const message = error?.message || String(error)
    if (!state.pendingDialog) {
      throw new Error("No JavaScript dialog is open on this tab.")
    }
    throw new Error(message)
  }
  const dialog = state.pendingDialog
  state.pendingDialog = null
  return { tabId: tab.id, content: { handled: true, accept, dialog } }
}

async function toolClick({ selector, tabId, index = 0, timeoutMs, pollMs, button = "left", clickCount = 1, modifiers } = {}) {
  if (!selector) throw new Error("Selector is required")
  const tab = await getTabById(tabId)
  const point = await runInPage(tab.id, "rect", { selector, index, timeoutMs, pollMs })
  if (!point?.ok) throw new Error(point?.error || "Click failed")
  await showAgentCursor(tab.id, { x: point.x, y: point.y })
  const mods = cdpKeyModifiers(Array.isArray(modifiers) ? modifiers.map(String) : [])
  const count = Number(clickCount) >= 2 ? 2 : 1
  const mouseButton = cdpMouseButton(button)

  // Debugger mouse events are not delivered to hidden (background) tabs; a DOM click still runs the
  // element's activation behavior (links, submit buttons) without bringing the tab to the front.
  const state = tab.active ? await ensureDebuggerAttached(tab.id) : { attached: false }
  if (state.attached) {
    await cdpClick(tab.id, { x: point.x, y: point.y, button: mouseButton, clickCount: count, modifiers: mods })
  } else {
    const result = await runInPage(tab.id, "click", {
      selector,
      index,
      timeoutMs,
      pollMs,
      button: mouseButton,
      clickCount: count,
    })
    if (!result?.ok) throw new Error(result?.error || "Click failed")
  }
  const used = point.selectorUsed || selector
  const extra = count >= 2 ? " (double)" : mouseButton !== "left" ? ` (${mouseButton})` : ""
  return { tabId: tab.id, content: `Clicked ${used}${extra}` }
}

async function toolHover({ selector, tabId, index = 0, timeoutMs, pollMs } = {}) {
  if (!selector) throw new Error("Selector is required")
  const tab = await getTabById(tabId)
  const point = await runInPage(tab.id, "rect", { selector, index, timeoutMs, pollMs })
  if (!point?.ok) throw new Error(point?.error || "Hover failed")
  await showAgentCursor(tab.id, { x: point.x, y: point.y })
  const state = tab.active ? await ensureDebuggerAttached(tab.id) : { attached: false }
  if (state.attached) {
    await dispatchMouse(tab.id, { type: "mouseMoved", x: point.x, y: point.y, button: "left", clickCount: 1 })
  } else {
    const result = await runInPage(tab.id, "hover", { selector, index, timeoutMs, pollMs })
    if (!result?.ok) throw new Error(result?.error || "Hover failed")
  }
  const used = point.selectorUsed || selector
  return { tabId: tab.id, content: `Hovered ${used}` }
}

async function toolDrag({
  fromSelector,
  selector,
  toSelector,
  fromIndex = 0,
  toIndex = 0,
  tabId,
  timeoutMs,
  pollMs,
} = {}) {
  const source = fromSelector || selector
  if (!source) throw new Error("fromSelector is required")
  if (!toSelector) throw new Error("toSelector is required")
  const tab = await getTabById(tabId)
  const from = await runInPage(tab.id, "rect", { selector: source, index: fromIndex, timeoutMs, pollMs })
  if (!from?.ok) throw new Error(from?.error || "Drag source not found")
  const to = await runInPage(tab.id, "rect", { selector: toSelector, index: toIndex, timeoutMs, pollMs })
  if (!to?.ok) throw new Error(to?.error || "Drag target not found")
  await showAgentCursor(tab.id, { x: from.x, y: from.y })
  const state = await ensureDebuggerAttached(tab.id)
  if (state.attached) {
    await showAgentCursor(tab.id, { x: to.x, y: to.y, fromX: from.x, fromY: from.y })
    await cdpDrag(tab.id, { x: from.x, y: from.y }, { x: to.x, y: to.y })
  } else {
    const result = await runInPage(tab.id, "drag", {
      fromSelector: source,
      toSelector,
      fromIndex,
      toIndex,
      timeoutMs,
      pollMs,
    })
    if (!result?.ok) throw new Error(result?.error || "Drag failed")
    await showAgentCursor(tab.id, { x: to.x, y: to.y, fromX: from.x, fromY: from.y })
  }
  return {
    tabId: tab.id,
    content: `Dragged ${from.selectorUsed || source} to ${to.selectorUsed || toSelector}`,
  }
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
  // keyDown needs text to produce the character event that submits forms and inserts characters.
  if (k === "Enter") out.text = "\r"
  else if (k.length === 1) out.text = k
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

  // Debugger key events are not delivered to hidden (background) tabs; use the in-page path there.
  const state = tab.active ? await ensureDebuggerAttached(tab.id) : { attached: false }
  if (state.attached) {
    const fields = cdpKeyFields(key.trim())
    const mods = cdpKeyModifiers(modList)
    // Shortcuts (Ctrl/Cmd/Alt + key) must not insert their character.
    if (mods & ~8) delete fields.text
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

// Draw a numbered uid label on every visible interactive element. Labels use the same data-iris-uid values as
// browser_snapshot, so an agent can act on what it sees with selector="uid:e12".
function irisAnnotate(mode, fullPage) {
  const LAYER = "__iris_annotations"
  document.getElementById(LAYER)?.remove()
  if (mode === "remove") return []
  const root = document.documentElement
  if (root.dataset.irisUidUrl !== location.href) {
    document.querySelectorAll("[data-iris-uid]").forEach((el) => el.removeAttribute("data-iris-uid"))
    root.dataset.irisUidSeq = "0"
    root.dataset.irisUidUrl = location.href
  }
  const selector =
    "a[href],button,input:not([type=hidden]),textarea,select,summary,[contenteditable=''],[contenteditable=true]," +
    "[role=button],[role=link],[role=checkbox],[role=radio],[role=tab],[role=menuitem],[role=option],[role=switch],[role=combobox],[onclick]"
  const layer = document.createElement("div")
  layer.id = LAYER
  layer.style.cssText = "position:absolute;left:0;top:0;width:0;height:0;z-index:2147483647;pointer-events:none"
  const labels = []
  for (const el of document.querySelectorAll(selector)) {
    if (labels.length >= 300) break
    const rect = el.getBoundingClientRect()
    if (rect.width < 2 || rect.height < 2) continue
    const style = getComputedStyle(el)
    if (style.visibility === "hidden" || style.display === "none" || style.opacity === "0") continue
    if (!fullPage && (rect.bottom < 0 || rect.right < 0 || rect.top > innerHeight || rect.left > innerWidth)) continue
    let uid = el.getAttribute("data-iris-uid")
    if (!uid) {
      const seq = Number(root.dataset.irisUidSeq || "0") || 0
      uid = `e${seq}`
      root.dataset.irisUidSeq = String(seq + 1)
      el.setAttribute("data-iris-uid", uid)
    }
    const x = rect.left + scrollX
    const y = rect.top + scrollY
    const box = document.createElement("div")
    box.style.cssText = `position:absolute;left:${x}px;top:${y}px;width:${rect.width}px;height:${rect.height}px;outline:2px solid #e11d48;outline-offset:-1px`
    const tag = document.createElement("div")
    tag.textContent = uid
    tag.style.cssText = `position:absolute;left:${x}px;top:${Math.max(0, y - 14)}px;background:#e11d48;color:#fff;font:bold 11px/14px monospace;padding:0 3px;border-radius:2px`
    layer.append(box, tag)
    const name = (el.getAttribute("aria-label") || el.innerText || el.value || el.placeholder || el.title || "").trim().replace(/\s+/g, " ")
    labels.push({ uid, role: el.getAttribute("role") || el.tagName.toLowerCase(), name: name.slice(0, 60) })
  }
  root.appendChild(layer)
  return labels
}

const lastScreenshotHash = new Map()

function hashString(value) {
  let h = 2166136261
  for (let i = 0; i < value.length; i += 1) {
    h ^= value.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return (h >>> 0).toString(16) + ":" + value.length
}

async function toolScreenshot(args = {}) {
  const { tabId, annotate = false, ifChanged = false, fullPage = false } = args
  const tab = await getTabById(tabId)
  let labels = null
  if (annotate) {
    const [res] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      world: "ISOLATED",
      func: irisAnnotate,
      args: ["draw", !!fullPage],
    })
    labels = res?.result || []
  }
  let shot
  try {
    shot = await captureScreenshot({ ...args, tabId: tab.id })
  } finally {
    if (annotate) {
      await chrome.scripting
        .executeScript({ target: { tabId: tab.id }, world: "ISOLATED", func: irisAnnotate, args: ["remove", false] })
        .catch(() => {})
    }
  }
  if (ifChanged) {
    const key = `${tab.id}|${JSON.stringify([fullPage, args.selector, args.x, args.y, args.width, args.height, annotate])}`
    const hash = hashString(shot.content)
    const unchanged = lastScreenshotHash.get(key) === hash
    lastScreenshotHash.set(key, hash)
    if (unchanged) {
      return { tabId: tab.id, content: JSON.stringify({ unchanged: true, note: "Screenshot identical to the previous one for this tab and region." }) }
    }
  }
  if (labels) return { tabId: tab.id, content: JSON.stringify({ image: shot.content, labels }) }
  return shot
}

async function captureScreenshot({
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

  // captureVisibleTab captures whatever tab is visible in the window, so only use it for the active tab.
  // Background tabs go through the debugger path, which does not change focus.
  if (tab.active && !fullPage && !hasManualClip && !hasSelectorClip && screenshotFormat === "png" && !Number.isFinite(quality)) {
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

// Page content as markdown: far cheaper for an agent to read than page_text or a full snapshot.
function irisPageToMarkdown(opts) {
  const SKIP = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE", "SVG", "CANVAS", "IFRAME", "OBJECT", "HEAD"])
  const CHROME = new Set(["NAV", "FOOTER", "ASIDE", "HEADER"])
  const includeLinks = opts.includeLinks !== false
  const includeImages = !!opts.includeImages

  function hidden(el) {
    if (el.hidden || el.getAttribute("aria-hidden") === "true") return true
    const style = getComputedStyle(el)
    return style.display === "none" || style.visibility === "hidden"
  }

  function pickRoot() {
    if (opts.selector) {
      const sel = String(opts.selector).replace(/^(uid|ref)[:=]\s*/i, "")
      const uidLike = /^e\d+$/.test(sel)
      const el = document.querySelector(uidLike ? `[data-iris-uid="${sel}"]` : sel)
      if (!el) return { error: `No element matches ${opts.selector}` }
      return { root: el, scoped: true }
    }
    const main = document.querySelector("main, [role=main], article")
    return { root: main || document.body, scoped: !!main }
  }

  const clean = (s) => String(s || "").replace(/\s+/g, " ")

  function inline(node) {
    let out = ""
    for (const child of node.childNodes) {
      if (child.nodeType === 3) out += clean(child.textContent)
      else if (child.nodeType === 1) out += element(child, true)
    }
    return out
  }

  function table(el) {
    const rows = [...el.querySelectorAll("tr")].slice(0, 200)
    if (!rows.length) return ""
    const cells = rows.map((tr) => [...tr.children].map((c) => inline(c).trim().replace(/\|/g, "\\|")))
    const width = Math.max(...cells.map((r) => r.length))
    const line = (r) => `| ${Array.from({ length: width }, (_, i) => r[i] || "").join(" | ")} |`
    return `\n\n${line(cells[0])}\n| ${Array(width).fill("---").join(" | ")} |\n${cells.slice(1).map(line).join("\n")}\n\n`
  }

  function list(el, depth) {
    const ordered = el.tagName === "OL"
    let i = 0
    let out = "\n"
    for (const li of el.children) {
      if (li.tagName !== "LI" || hidden(li)) continue
      i += 1
      const nested = [...li.children].filter((c) => c.tagName === "UL" || c.tagName === "OL")
      const clone = li.cloneNode(true)
      clone.querySelectorAll("ul,ol").forEach((n) => n.remove())
      out += `${"  ".repeat(depth)}${ordered ? `${i}.` : "-"} ${inline(clone).trim()}\n`
      for (const sub of nested) out += list(sub, depth + 1).replace(/^\n/, "")
    }
    return out + "\n"
  }

  function element(el, inInline) {
    if (SKIP.has(el.tagName) || hidden(el)) return ""
    if (!opts.includeChrome && !opts.explicit) {
      // Site chrome: navigation and sidebars anywhere; header/footer only when reading the whole body.
      const role = el.getAttribute("role")
      if (el.tagName === "NAV" || el.tagName === "ASIDE" || ["navigation", "complementary", "search", "menu", "menubar"].includes(role)) return ""
      if (!opts.scoped && CHROME.has(el.tagName)) return ""
    }
    const tag = el.tagName
    if (/^H[1-6]$/.test(tag)) return `\n\n${"#".repeat(Number(tag[1]))} ${inline(el).trim()}\n\n`
    if (tag === "P") return `\n\n${inline(el).trim()}\n\n`
    if (tag === "BR") return "\n"
    if (tag === "HR") return "\n\n---\n\n"
    if (tag === "UL" || tag === "OL") return list(el, 0)
    if (tag === "TABLE") return table(el)
    if (tag === "PRE") return `\n\n\`\`\`\n${el.innerText.replace(/\n+$/, "")}\n\`\`\`\n\n`
    if (tag === "CODE") return `\`${el.textContent}\``
    if (tag === "BLOCKQUOTE") return `\n\n> ${inline(el).trim().replace(/\n/g, "\n> ")}\n\n`
    if (tag === "STRONG" || tag === "B") {
      const t = inline(el).trim()
      return t ? ` **${t}** ` : ""
    }
    if (tag === "EM" || tag === "I") {
      const t = inline(el).trim()
      return t ? ` _${t}_ ` : ""
    }
    if (tag === "A") {
      const t = inline(el).trim()
      if (!t) return ""
      const href = el.href && !el.href.startsWith("javascript:") ? el.href : ""
      return includeLinks && href ? `[${t}](${href})` : t
    }
    if (tag === "IMG") return includeImages && el.alt ? `![${clean(el.alt)}](${el.src})` : ""
    if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || tag === "BUTTON") {
      const label = clean(el.getAttribute("aria-label") || el.placeholder || el.innerText || el.value || el.name || "")
      return label ? ` [${tag.toLowerCase()}: ${label.trim().slice(0, 80)}] ` : ""
    }
    let out = ""
    for (const child of el.childNodes) {
      if (child.nodeType === 3) out += clean(child.textContent)
      else if (child.nodeType === 1) out += element(child, inInline)
    }
    if (el.shadowRoot) for (const child of el.shadowRoot.children) out += element(child, inInline)
    const block = !inInline && /^(DIV|SECTION|ARTICLE|MAIN|LI|DD|DT|FIGURE|FIGCAPTION|DETAILS|SUMMARY|FORM|FIELDSET)$/.test(tag)
    return block ? `\n${out}\n` : out
  }

  const picked = pickRoot()
  if (picked.error) return { ok: false, error: picked.error }
  opts.scoped = picked.scoped
  opts.explicit = !!opts.selector

  if (opts.outline) {
    const heads = [...picked.root.querySelectorAll("h1,h2,h3,h4")].filter((h) => !hidden(h))
    const outline = heads.map((h) => `${"  ".repeat(Number(h.tagName[1]) - 1)}- ${clean(h.innerText).trim()}`).join("\n")
    return { ok: true, url: location.href, title: document.title, markdown: outline, totalChars: outline.length, offset: 0, truncated: false }
  }

  const markdown = element(picked.root, false)
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n[ \t]+/g, "\n")
    .replace(/ {2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
  const offset = Math.max(0, Number(opts.offset) || 0)
  const maxChars = Math.max(200, Number(opts.maxChars) || 15000)
  const slice = markdown.slice(offset, offset + maxChars)
  return {
    ok: true,
    url: location.href,
    title: document.title,
    markdown: slice,
    totalChars: markdown.length,
    offset,
    truncated: offset + maxChars < markdown.length,
    nextOffset: offset + maxChars < markdown.length ? offset + maxChars : null,
  }
}

async function toolRead({ tabId, selector, maxChars, offset, includeLinks, includeImages, includeChrome, outline } = {}) {
  const tab = await getTabById(tabId)
  const [res] = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    world: "ISOLATED",
    func: irisPageToMarkdown,
    args: [{ selector, maxChars, offset, includeLinks, includeImages, includeChrome, outline }],
  })
  const out = res?.result
  if (!out?.ok) throw new Error(out?.error || "Could not read the page")
  const header = `# ${out.title}\n<${out.url}>`
  const footer = out.truncated
    ? `\n\n[truncated: showing ${out.offset}-${out.offset + out.markdown.length} of ${out.totalChars} chars; pass offset=${out.nextOffset} for more]`
    : ""
  return { tabId: tab.id, content: `${header}\n\n${out.markdown}${footer}` }
}

async function toolSnapshot({ tabId, full = false, interactive = false, selector, includeText, maxNodes } = {}) {
  const tab = await getTabById(tabId)
  const optionsKey = JSON.stringify([!!interactive, selector || "", includeText ?? null, maxNodes ?? null])

  const result = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    args: [{ full: !!full, interactive: !!interactive, selector: selector || "", includeText, maxNodes }],
    func: (opts) => {
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

      function clearIrisUids(root) {
        try {
          root.querySelectorAll("[data-iris-uid]").forEach((el) => {
            try {
              el.removeAttribute("data-iris-uid")
            } catch {}
          })
          root.querySelectorAll("*").forEach((el) => {
            if (el.shadowRoot) clearIrisUids(el.shadowRoot)
          })
        } catch {}
      }

      function maxExistingUid(root) {
        let max = -1
        const visit = (r) => {
          try {
            r.querySelectorAll("[data-iris-uid]").forEach((el) => {
              const match = String(el.getAttribute("data-iris-uid") || "").match(/^e(\d+)$/)
              if (match) max = Math.max(max, Number(match[1]))
            })
            r.querySelectorAll("*").forEach((el) => {
              if (el.shadowRoot) visit(el.shadowRoot)
            })
          } catch {}
        }
        visit(root)
        return max
      }

      function takeUid(el) {
        const existing = el.getAttribute("data-iris-uid")
        if (existing && /^e\d+$/.test(existing)) return existing
        const seq = Number(document.documentElement.dataset.irisUidSeq || "0") || 0
        const uidStr = `e${seq}`
        document.documentElement.dataset.irisUidSeq = String(seq + 1)
        try {
          el.setAttribute("data-iris-uid", uidStr)
        } catch {}
        return uidStr
      }

      function build(el, depth = 0) {
        if (!el || depth > 12) return { nodes: [] }
        const nodes = []

        if (!isVisible(el)) return { nodes: [] }

        const isInteractive =
          ["A", "BUTTON", "INPUT", "TEXTAREA", "SELECT", "SUMMARY"].includes(el.tagName) ||
          el.getAttribute("onclick") ||
          ["button", "link", "checkbox", "radio", "tab", "menuitem", "option", "switch", "combobox", "textbox"].includes(
            el.getAttribute("role")
          ) ||
          el.isContentEditable

        const name = getName(el)
        const pt = pseudoText(el)

        const shouldInclude = opts.interactive ? !!isInteractive : isInteractive || name.trim() || pt.before || pt.after

        if (shouldInclude) {
          const uidStr = takeUid(el)
          const tagName = el.tagName.toLowerCase()
          const role = el.getAttribute("role") || tagName
          // Compact nodes: act on them with selector="uid:<uid>"; role is omitted when it only repeats the tag.
          const node = { uid: uidStr, tag: tagName, name: opts.interactive ? name.slice(0, 100) : name }
          if (role !== tagName) node.role = role

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

          nodes.push(node)
        }

        if (el.shadowRoot) {
          for (const child of el.shadowRoot.children) {
            nodes.push(...build(child, depth + 1).nodes)
          }
        }

        for (const child of el.children) {
          nodes.push(...build(child, depth + 1).nodes)
        }

        return { nodes }
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

      let root = document.body
      if (opts.selector) {
        const sel = String(opts.selector).replace(/^(uid|ref)[:=]\s*/i, "")
        root = document.querySelector(/^e\d+$/.test(sel) ? `[data-iris-uid="${sel}"]` : sel)
        if (!root) return { error: `No element matches ${opts.selector}` }
      }
      const wantText = opts.includeText ?? !opts.interactive
      let pageText = ""
      try {
        if (wantText) pageText = safeText(root.innerText || "").slice(0, 20000)
      } catch {}

      const reset = !!opts?.full || document.documentElement.dataset.irisUidUrl !== location.href
      if (reset) {
        clearIrisUids(document)
        document.documentElement.dataset.irisUidSeq = "0"
      } else {
        const existingMax = maxExistingUid(document)
        const stored = Number(document.documentElement.dataset.irisUidSeq || "0") || 0
        document.documentElement.dataset.irisUidSeq = String(Math.max(stored, existingMax + 1))
      }
      document.documentElement.dataset.irisUidUrl = location.href

      const limit = Math.min(Math.max(Number(opts.maxNodes) || 800, 1), 3000)
      const built = build(root).nodes.slice(0, limit)

      return {
        url: location.href,
        title: document.title,
        text: pageText,
        nodes: built,
        links: opts.interactive || opts.selector ? [] : getAllLinks(),
        restamped: reset,
      }
    },
    world: "ISOLATED",
  })

  const snapshot = result[0]?.result || { url: tab.url, title: tab.title, nodes: [] }
  if (snapshot.error) throw new Error(snapshot.error)
  const prev = lastSnapshot.get(tab.id)
  // A diff is only meaningful against a snapshot taken with the same filters.
  const shouldFull = !!full || !prev || prev.url !== snapshot.url || snapshot.restamped || prev.optionsKey !== optionsKey
  lastSnapshot.set(tab.id, { url: snapshot.url, optionsKey, nodesByUid: indexByUid(snapshot.nodes) })

  if (shouldFull) {
    return {
      tabId: tab.id,
      content: JSON.stringify(
        {
          mode: "full",
          url: snapshot.url,
          title: snapshot.title,
          ...(snapshot.text ? { text: snapshot.text } : {}),
          nodes: snapshot.nodes,
          ...(snapshot.links?.length ? { links: snapshot.links } : {}),
        }
      ),
    }
  }

  const diff = diffSnapshots(prev.nodesByUid, snapshot.nodes)
  return {
    tabId: tab.id,
    content: JSON.stringify(
      {
        mode: "diff",
        url: snapshot.url,
        title: snapshot.title,
        added: diff.added,
        removed: diff.removed,
        changed: diff.changed,
      }
    ),
  }
}

async function toolGetTabs() {
  const tabs = await chrome.tabs.query({})
  const groupTitles = new Map()
  if (chrome.tabGroups) {
    for (const g of await chrome.tabGroups.query({}).catch(() => [])) groupTitles.set(g.id, g.title || "")
  }
  const out = tabs.map((t) => ({
    id: t.id,
    url: t.url,
    title: t.title,
    active: t.active,
    windowId: t.windowId,
    ...(t.groupId >= 0 ? { group: groupTitles.get(t.groupId) ?? "" } : {}),
  }))
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
  if (!selector && mode !== "page_text" && mode !== "page") {
    throw new Error(`selector is required for mode=${mode}; use mode=page_text to read the whole page.`)
  }
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

  if (["list", "all", "property", "exists", "count", "page_text", "page"].includes(mode)) {
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

  // Poll from the service worker with single in-page checks: a loop inside the page dies with the document,
  // so a wait started on about:blank or before a navigation would never see the new page.
  const endAt = Date.now() + timeout
  while (true) {
    let result = null
    try {
      result = await runInPage(tab.id, "wait_for", { selector, text, pattern, urlPattern, state, timeoutMs: 0, index, flags })
    } catch (error) {
      const message = error?.message || String(error)
      if (/permission|No tab with id|cannot be scripted/i.test(message)) throw error
      // Mid-navigation: the frame is being replaced; check again on the next poll.
    }
    if (result?.ok) return { tabId: tab.id, content: JSON.stringify(result, null, 2) }
    if (result && result.error !== "Timed out waiting for condition") throw new Error(result.error || "Wait condition failed")
    if (Date.now() >= endAt) throw new Error(`Timed out after ${timeout}ms waiting for condition`)
    await new Promise((resolve) => setTimeout(resolve, poll))
  }
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

// Never attaches: stopping capture must not raise Chrome's debugging bar. Detaches by default so the bar goes away.
async function toolNetworkStop({ tabId, detach = true } = {}) {
  const tab = await getTabById(tabId)
  const state = debuggerState.get(tab.id)
  const network = state?.network
  if (state?.attached && network?.enabled) {
    try {
      await chrome.debugger.sendCommand({ tabId: tab.id }, "Network.disable")
    } catch {}
    state.enabledDomains?.delete?.("Network")
  }
  if (network) network.enabled = false
  let detached = false
  if (detach !== false && state?.attached) {
    try {
      await chrome.debugger.detach({ tabId: tab.id })
    } catch {}
    state.attached = false
    state.enabledDomains = new Set()
    detached = true
  }
  return {
    tabId: tab.id,
    content: JSON.stringify({ ok: true, enabled: false, detached, count: network?.order?.length || 0 }, null, 2),
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
      out.base64Encoded = !!redactedBody.base64Encoded
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

  if (!isConnected) return
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
    if (!tab?.id) return
    const claimed = lastClaims.some((c) => c.tabId === tab.id)
    if (claimed) send({ type: "release_tab", tabId: tab.id })
  } catch {}
})

connect().catch(() => {})
