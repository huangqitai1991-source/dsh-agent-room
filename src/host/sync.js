/**
 * dsh-agent-org — cross-machine org sync (v2.1).
 *
 * The org tree is small (a handful of nodes), so we sync by broadcasting a
 * full-state snapshot over a dedicated agent-room room. Every node applies an
 * inbound snapshot only when its `rev` is strictly newer than the local one,
 * which also makes the protocol self-echo-safe (a node that just broadcast its
 * own snapshot sees rev === local and skips).
 */

export const SNAPSHOT_PREFIX = "[org:snapshot]";

/**
 * @param {{version:number, nodes:Array, updatedAt:string, rev:number}} state
 * @returns {string}
 */
export function encodeSnapshot(state) {
  return SNAPSHOT_PREFIX + JSON.stringify({
    version: state.version,
    nodes: state.nodes,
    updatedAt: state.updatedAt,
    rev: state.rev,
  });
}

/**
 * @param {string} text
 * @returns {{version:number, nodes:Array, updatedAt:string, rev:number}|null}
 */
export function decodeSnapshot(text) {
  if (typeof text !== "string" || !text.startsWith(SNAPSHOT_PREFIX)) return null;
  try {
    const payload = JSON.parse(text.slice(SNAPSHOT_PREFIX.length));
    if (!payload || !Array.isArray(payload.nodes) || typeof payload.rev !== "number") return null;
    return {
      version: payload.version ?? 1,
      nodes: payload.nodes,
      updatedAt: typeof payload.updatedAt === "string" ? payload.updatedAt : "",
      rev: payload.rev,
    };
  } catch {
    return null;
  }
}

/**
 * @param {{rev?:number}} local
 * @param {{rev:number}} incoming
 * @returns {boolean}
 */
export function shouldApply(local, incoming) {
  const localRev = typeof local.rev === "number" ? local.rev : 0;
  return incoming.rev > localRev;
}
