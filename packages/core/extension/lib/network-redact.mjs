/**
 * Pure network redaction helpers shared by the extension service worker and Node tests.
 */

/** Anchored secret key names (after camelCase → snake normalization). */
export const NETWORK_BODY_SECRET_KEY =
  /(?:^|[_-])(?:password|passwd|secret|token|authorization|access[_-]?token|refresh[_-]?token|id[_-]?token|api[_-]?key|cookie|credential|session(?:_?id)?)$/i;

/**
 * @param {unknown} name
 * @returns {boolean}
 */
export function isSensitiveHeaderName(name) {
  const lower = String(name || "").toLowerCase();
  if (
    lower === "authorization" ||
    lower === "proxy-authorization" ||
    lower === "cookie" ||
    lower === "set-cookie"
  ) {
    return true;
  }
  return (
    lower.includes("api-key") ||
    lower.includes("token") ||
    lower.includes("secret") ||
    lower.includes("password") ||
    lower.includes("credential") ||
    lower.includes("session")
  );
}

/**
 * @param {unknown} headers
 * @returns {Record<string, unknown>}
 */
export function redactHeaders(headers) {
  if (!headers || typeof headers !== "object") return {};
  /** @type {Record<string, unknown>} */
  const out = {};
  for (const [key, value] of Object.entries(headers)) {
    out[key] = isSensitiveHeaderName(key) ? "[redacted]" : value;
  }
  return out;
}

/**
 * @param {string} key
 * @returns {string}
 */
function normalizeSecretKey(key) {
  return key.replace(/([a-z0-9])([A-Z])/g, "$1_$2").replace(/\s+/g, "_");
}

/**
 * Body keys: anchored secret names + session_id style (aligned with header session policy without matching tokenCount).
 * @param {string} key
 * @returns {boolean}
 */
export function isSensitiveBodyKey(key) {
  const normalized = normalizeSecretKey(String(key));
  if (NETWORK_BODY_SECRET_KEY.test(normalized)) return true;
  const lower = normalized.toLowerCase();
  // session_id / user_session_id / sessionId — not session_count / sessions_total
  if (
    lower === "session" ||
    lower === "sessionid" ||
    /(?:^|[_-])session[_-]?id$/.test(lower) ||
    /(?:^|[_-])session$/.test(lower)
  ) {
    return true;
  }
  return false;
}

/**
 * @param {unknown} value
 * @returns {{ value: unknown, redacted: boolean }}
 */
function scrubJsonValue(value) {
  let redacted = false;
  const scrub = (entry) => {
    if (!entry || typeof entry !== "object") return;
    if (Array.isArray(entry)) {
      for (const item of entry) scrub(item);
      return;
    }
    for (const [key, child] of Object.entries(entry)) {
      if (isSensitiveBodyKey(key)) {
        entry[key] = "[redacted]";
        redacted = true;
      } else {
        scrub(child);
      }
    }
  };
  scrub(value);
  return { value, redacted };
}

/**
 * @param {string} text decoded or raw body text to inspect
 * @returns {{ text: string, redacted: boolean } | null}
 */
function scrubJsonBody(text) {
  const trimmed = text.trim();
  const looksLikeJson =
    (trimmed.startsWith("{") && trimmed.endsWith("}")) || (trimmed.startsWith("[") && trimmed.endsWith("]"));
  if (!looksLikeJson) return null;

  let parsed;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }

  const { value, redacted } = scrubJsonValue(parsed);
  // Always return decoded UTF-8 JSON text (not the original base64 input).
  return { text: redacted ? JSON.stringify(value) : trimmed, redacted };
}

/**
 * @param {string} text
 * @returns {{ text: string, redacted: boolean } | null}
 */
function scrubFormBody(text) {
  const trimmed = text.trim();
  if (!trimmed.includes("=")) return null;
  if (/^\s*[\[{]/.test(trimmed)) return null;
  if (!/^[^=\s]+=.*/.test(trimmed) && !trimmed.includes("&")) return null;

  const parts = trimmed.split("&");
  let redacted = false;
  const out = parts.map((part) => {
    if (!part) return part;
    const eq = part.indexOf("=");
    if (eq === -1) return part;
    const rawKey = part.slice(0, eq);
    const rawVal = part.slice(eq + 1);
    let key = rawKey;
    try {
      key = decodeURIComponent(rawKey.replace(/\+/g, " "));
    } catch {
      // keep raw key
    }
    if (isSensitiveBodyKey(key)) {
      redacted = true;
      return `${rawKey}=${encodeURIComponent("[redacted]")}`;
    }
    return `${rawKey}=${rawVal}`;
  });

  // Return the (possibly decoded) form text, not a base64 original.
  return { text: redacted ? out.join("&") : trimmed, redacted };
}

/**
 * @param {string} text
 * @returns {string | null}
 */
function tryDecodeBase64Utf8(text) {
  try {
    if (typeof Buffer !== "undefined") {
      return Buffer.from(text, "base64").toString("utf8");
    }
  } catch {
    // fall through
  }
  try {
    if (typeof atob === "function") {
      const binary = atob(text);
      if (typeof TextDecoder !== "undefined") {
        const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
        return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
      }
      return binary;
    }
  } catch {
    return null;
  }
  return null;
}

/**
 * @param {unknown} text
 * @param {{ base64Encoded?: boolean }} [opts]
 * @returns {{ text: string, redacted: boolean, base64Encoded: boolean }}
 *   `base64Encoded` is true only when `text` is still the original base64 payload (not decoded UTF-8).
 */
export function redactNetworkBody(text, opts = {}) {
  const inputWasBase64 = !!opts.base64Encoded;
  if (typeof text !== "string") {
    return { text: "", redacted: false, base64Encoded: false };
  }

  let work = text;
  if (inputWasBase64) {
    const decoded = tryDecodeBase64Utf8(text);
    if (decoded == null) {
      return { text, redacted: false, base64Encoded: true };
    }
    work = decoded;
  }

  const jsonResult = scrubJsonBody(work);
  if (jsonResult) {
    return { text: jsonResult.text, redacted: jsonResult.redacted, base64Encoded: false };
  }

  const formResult = scrubFormBody(work);
  if (formResult) {
    // form path always returns decoded/plain form text
    return { text: formResult.text, redacted: formResult.redacted, base64Encoded: false };
  }

  // Not JSON/form: keep original base64 bytes if input was base64
  if (inputWasBase64) {
    return { text, redacted: false, base64Encoded: true };
  }
  return { text: work, redacted: false, base64Encoded: false };
}
