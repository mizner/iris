/**
 * Pure network redaction helpers shared by the extension service worker and Node tests.
 */

export const NETWORK_BODY_SECRET_KEY =
  /(?:^|[_-])(?:password|passwd|secret|token|authorization|access[_-]?token|refresh[_-]?token|id[_-]?token|api[_-]?key|cookie|credential|session)$/i;

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
      if (NETWORK_BODY_SECRET_KEY.test(normalizeSecretKey(key))) {
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
 * @param {string} text
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
  return { text: redacted ? JSON.stringify(value) : text, redacted };
}

/**
 * @param {string} text
 * @returns {{ text: string, redacted: boolean } | null}
 */
function scrubFormBody(text) {
  const trimmed = text.trim();
  if (!trimmed.includes("=")) return null;
  if (/^\s*[\[{]/.test(trimmed)) return null;
  // form-ish: key=value pairs joined by &
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
    if (NETWORK_BODY_SECRET_KEY.test(normalizeSecretKey(key))) {
      redacted = true;
      return `${rawKey}=${encodeURIComponent("[redacted]")}`;
    }
    return `${rawKey}=${rawVal}`;
  });

  if (!redacted) return { text, redacted: false };
  return { text: out.join("&"), redacted: true };
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
 * @returns {{ text: string, redacted: boolean }}
 */
export function redactNetworkBody(text, opts = {}) {
  const base64Encoded = !!opts.base64Encoded;
  if (typeof text !== "string") return { text: "", redacted: false };

  let work = text;
  let decodedFromBase64 = false;
  if (base64Encoded) {
    const decoded = tryDecodeBase64Utf8(text);
    if (decoded == null) return { text, redacted: false };
    work = decoded;
    decodedFromBase64 = true;
  }

  const jsonResult = scrubJsonBody(work);
  if (jsonResult) {
    return jsonResult;
  }

  const formResult = scrubFormBody(work);
  if (formResult && formResult.redacted) {
    return formResult;
  }

  // base64 that is not JSON/form: keep original base64 bytes on the wire
  if (decodedFromBase64) return { text, redacted: false };
  return { text: work, redacted: false };
}
