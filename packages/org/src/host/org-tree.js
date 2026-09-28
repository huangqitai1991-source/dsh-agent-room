/**
 * org-tree.js -- the read-only architecture view, as pure data.
 *
 * The page no longer offers "add a department / team / member" or "set the superior": arrangement is
 * the agent's job now (human, 2026-09-16). What a human still needs is to SEE the shape, so the tree
 * is built here -- pure, no DOM, no host -- and can be asserted before anything is rendered.
 *
 * Rules that keep the picture honest:
 *   * a node whose parent is missing is shown as a root, never dropped (a broken tree must be visible);
 *   * children keep the order the state gave them;
 *   * a cycle cannot hang the renderer (visited set);
 *   * the displayed role is derived from the company leader, not from a field that may not exist.
 */

export function shortId(agentId) {
  const s = String(agentId || "");
  return s ? s.slice(0, 8) : "-";
}

export function buildTree(nodes = []) {
  const list = Array.isArray(nodes) ? nodes.filter((n) => n && n.id) : [];
  const byId = new Map(list.map((n) => [n.id, n]));
  const company = list.find((n) => n.kind === "company") || null;
  const leader = company && company.leaderAgentId ? company.leaderAgentId : "";

  const childrenOf = new Map();
  const orphans = [];
  for (const n of list) {
    if (n.kind === "company") continue;
    if (n.parentId && byId.has(n.parentId)) {
      if (!childrenOf.has(n.parentId)) childrenOf.set(n.parentId, []);
      childrenOf.get(n.parentId).push(n);
    } else {
      orphans.push(n);
    }
  }

  const roleOf = (n) => {
    if (n.kind === "company") return "company";
    if (n.agentId && leader && n.agentId === leader) return "owner";
    return n.kind === "member" ? "member" : n.kind;
  };

  const seen = new Set();
  const shape = (n, depth) => {
    if (seen.has(n.id)) return { id: n.id, kind: n.kind, name: n.name, agentId: n.agentId || null, shortId: shortId(n.agentId), role: roleOf(n), depth, children: [], truncated: true };
    seen.add(n.id);
    const kids = childrenOf.get(n.id) || [];
    return {
      id: n.id, kind: n.kind, name: n.name, agentId: n.agentId || null, shortId: shortId(n.agentId),
      role: roleOf(n), depth, children: kids.map((k) => shape(k, depth + 1)),
    };
  };

  const roots = [];
  if (company) roots.push(shape(company, 0));
  for (const o of orphans) roots.push(shape(o, company ? 1 : 0));
  const count = (t) => 1 + t.children.reduce((a, c) => a + count(c), 0);
  return {
    roots,
    companies: list.filter((n) => n.kind === "company").length,
    members: list.filter((n) => n.kind === "member").length,
    displayed: roots.reduce((a, r) => a + count(r), 0),
    orphans: orphans.length,
  };
}

/** One line per node, indented -- the fallback rendering when the graphic tree cannot be drawn. */
export function treeLines(tree) {
  const out = [];
  const walk = (n) => {
    out.push("  ".repeat(n.depth) + (n.name || "(unnamed)") + " [" + n.role + (n.agentId ? " " + n.shortId : "") + "]");
    n.children.forEach(walk);
  };
  tree.roots.forEach(walk);
  return out;
}