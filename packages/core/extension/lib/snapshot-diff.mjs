/**
 * Snapshot fingerprinting and diffing for Iris uid-preserving snapshots.
 */

/**
 * @param {Record<string, unknown> | null | undefined} node
 * @returns {string}
 */
export function nodeFingerprint(node) {
  if (!node || typeof node !== "object") return "";
  return [
    node.role ?? "",
    node.name ?? "",
    node.tag ?? "",
    node.href ?? "",
    node.type ?? "",
    node.value ?? "",
    node.disabled ? "1" : "0",
    node.readOnly ? "1" : "0",
  ].join("\0");
}

/**
 * @param {Array<Record<string, unknown>> | null | undefined} nodes
 * @returns {Map<string, Record<string, unknown>>}
 */
export function indexByUid(nodes) {
  const map = new Map();
  if (!Array.isArray(nodes)) return map;
  for (const node of nodes) {
    if (node && typeof node === "object" && typeof node.uid === "string" && node.uid) {
      map.set(node.uid, node);
    }
  }
  return map;
}

/**
 * @param {Map<string, Record<string, unknown>>} prevByUid
 * @param {Array<Record<string, unknown>>} nextNodes
 * @param {{ cap?: number }} [options]
 */
export function diffSnapshots(prevByUid, nextNodes, options = {}) {
  const cap = Number.isFinite(options.cap) ? Math.max(1, options.cap) : 800;
  const prev = prevByUid instanceof Map ? prevByUid : indexByUid([]);
  const nextByUid = indexByUid(nextNodes);
  const added = [];
  const changed = [];
  const removed = [];

  for (const [uid, node] of nextByUid) {
    const prior = prev.get(uid);
    if (!prior) added.push(node);
    else if (nodeFingerprint(prior) !== nodeFingerprint(node)) changed.push(node);
  }

  for (const uid of prev.keys()) {
    if (!nextByUid.has(uid)) removed.push({ uid });
  }

  return {
    added: added.slice(0, cap),
    removed: removed.slice(0, cap),
    changed: changed.slice(0, cap),
    nextByUid,
  };
}
