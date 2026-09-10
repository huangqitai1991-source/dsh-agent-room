/**
 * dsh-agent-org — cross-machine org sync (v2.2).
 *
 * The org tree is small, so we sync by broadcasting a full-state snapshot over
 * a dedicated agent-room room. Convergence rule (owner-authoritative + rev):
 *   - a snapshot broadcast by the org owner (company leader) wins over a
 *     non-owner's local tree even at equal rev;
 *   - otherwise higher `rev` wins.
 */

export const SNAPSHOT_PREFIX = "[org:snapshot]";

/**
 * @param {{version:number, nodes:Array, updatedAt:string, rev:number}} state
 * @param {{by: string, ownerAgentId: string}} meta
 * @returns {string}
 */
export function encodeSnapshot(state, meta = {}) {
  return SNAPSHOT_PREFIX + JSON.stringify({
    version: state.version,
    nodes: state.nodes,
    updatedAt: state.updatedAt,
    rev: state.rev ?? 0,
    by: meta.by ?? "",
    ownerAgentId: meta.ownerAgentId ?? "",
  });
}

/**
 * @param {string} text
 * @returns {{version:number, nodes:Array, updatedAt:string, rev:number, by:string, ownerAgentId:string}|null}
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
      by: typeof payload.by === "string" ? payload.by : "",
      ownerAgentId: typeof payload.ownerAgentId === "string" ? payload.ownerAgentId : "",
    };
  } catch {
    return null;
  }
}

/**
 * Decide whether to adopt an incoming snapshot.
 * @param {{rev?:number, nodes?:Array}} local
 * @param {{rev:number, by:string, ownerAgentId:string}} incoming
 * @param {string} myAgentId
 * @returns {boolean}
 */
export function shouldApply(local, incoming, myAgentId) {
  const localRev = typeof local.rev === "number" ? local.rev : 0;
  const incRev = typeof incoming.rev === "number" ? incoming.rev : 0;
  const incomingIsOwner = incoming.ownerAgentId !== "" && incoming.by === incoming.ownerAgentId;
  // I am the org owner if my agentId is the company leader of MY local tree.
  const localOwner = (Array.isArray(local.nodes) && local.nodes.find((n) => n.kind === "company")?.leaderAgentId) || "";
  const localIsOwner = localOwner !== "" && myAgentId === localOwner;

  if (incomingIsOwner && !localIsOwner) return true;  // owner's version wins here
  if (localIsOwner && !incomingIsOwner) return false; // I'm the owner; ignore non-owner
  return incRev > localRev;
}
