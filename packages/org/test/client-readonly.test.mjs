/**
 * client-readonly.test.mjs — the 2026-09-16 UI change, asserted.
 *
 * The page became READ-ONLY except for the company name: "新增部门 / 团队 / 成员" and "设置上级"
 * were removed, every node row lost its 改名 / 删除 buttons, and the architecture area is drawn from
 * the pure host tree (src/host/org-tree.js) instead of the `window.__orgTreeLines` placeholder.
 *
 * Two things are easy to regress and both are checked here:
 *   1. the DRAWN tree -- the client's own renderer, fed with the payload the host really builds;
 *   2. the BOUNDARY -- no write route may reappear in the client, and no write route may disappear
 *      from the host (the agent still arranges the org).
 *
 * The client bundle is not a module: it is a ModuleLoader script. It is loaded here exactly the way
 * DSH loads it (a fake `window`), with a minimal React stub -- renderTree is pure element building,
 * no hooks, no DOM. Run directly: node test/client-readonly.test.mjs
 */

import assert from "node:assert";
import { test } from "node:test";
import { readFileSync } from "node:fs";

import { buildTree, treeLines } from "../src/host/org-tree.js";

const root = new URL("../", import.meta.url);
const clientSource = readFileSync(new URL("src/client.js", root), "utf8");
const serviceSource = readFileSync(new URL("src/host/service.js", root), "utf8");
const webSource = readFileSync(new URL("src/host/web.js", root), "utf8");

/**
 * The source scans below are about CODE, not prose: the file's own header explains that the removed
 * blocks are gone, and a naive scan would trip over its own changelog. Comments out, then scan.
 * (This bundle contains no "//" or "/*" inside a string literal.)
 */
const code = clientSource.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");

/* ------------------------------ loading the bundle ------------------------------ */

const ReactStub = {
  createElement(type, props, ...children) {
    return { type, props: { ...(props || {}), children: children.length <= 1 ? children[0] : children } };
  },
  useState: () => { throw new Error("renderTree must not use hooks"); },
  useCallback: () => { throw new Error("renderTree must not use hooks"); },
  useEffect: () => { throw new Error("renderTree must not use hooks"); },
};

/**
 * A React stub that MOUNTS the real component: the hook script answers OrgDock's useState calls in
 * order (state payload / error / open / draft), so `component()` returns the whole panel element
 * tree. This is how the panel itself is asserted without a browser -- and it executes the real code,
 * which a source scan cannot do (a comment here once closed early and `node --check` stayed green).
 */
function makeReact(hookScript) {
  let cursor = 0;
  return {
    createElement: ReactStub.createElement,
    useState(initial) {
      const value = cursor < hookScript.length ? hookScript[cursor] : initial;
      cursor += 1;
      return [value, () => {}];
    },
    useCallback: (fn) => fn,
    useEffect: () => {},
  };
}

function loadClient(reactImpl) {
  const required = [];
  let definition = null;
  const fakeWindow = { __ModuleLoader__: { load: (config) => { definition = config; } } };
  // eslint-disable-next-line no-new-func
  new Function("window", clientSource)(fakeWindow);
  assert.ok(definition, "src/client.js must register itself through window.__ModuleLoader__");
  assert.equal(definition.id, "dsh-agent-org");
  const bundle = definition.factory((id) => {
    required.push(id);
    if (id === "react") return reactImpl;
    throw new Error("client.js required an unexpected module: " + id);
  });
  return { bundle, required };
}

const { bundle, required } = loadClient(ReactStub);
const renderTree = bundle.__internals.renderTree;

/* ------------------------------ element helpers ------------------------------ */

function textOf(node) {
  if (node === null || node === undefined || node === false || node === true) return "";
  if (Array.isArray(node)) return node.map(textOf).join("");
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (typeof node !== "object") return "";
  return textOf(node.props ? node.props.children : undefined);
}

function typesOf(node, out = []) {
  if (node === null || node === undefined || node === false || node === true) return out;
  if (Array.isArray(node)) { for (const n of node) typesOf(n, out); return out; }
  if (typeof node !== "object") return out;
  out.push(node.type);
  typesOf(node.props ? node.props.children : undefined, out);
  return out;
}

/** The real host payload: nodes in, buildTree + treeLines out (the shape GET /state ships). */
const stateNodes = () => [
  { id: "c1", kind: "company", name: "AI 工作室", parentId: null, agentId: "01a0231b-bbe5-720a-97a4-819744eeae76", leaderAgentId: "01a0231b-bbe5-720a-97a4-819744eeae76" },
  { id: "d1", kind: "department", name: "总部", parentId: "c1" },
  { id: "m1", kind: "member", name: "主控·总控", parentId: "d1", agentId: "01a0231b-bbe5-720a-97a4-819744eeae76" },
  { id: "m2", kind: "member", name: "AA·助理", parentId: "d1", agentId: "01a0281a-52de-7c4d-a1e9-7e6db367d3dd" },
  { id: "t1", kind: "team", name: "复核组", parentId: "d1" },
];

/* ------------------------------ the drawn tree ------------------------------ */

test("the payload the host builds is drawn as a tree: company -> department -> members", () => {
  const payload = buildTree(stateNodes());
  const text = textOf(renderTree(payload, treeLines(payload)));

  assert.match(text, /公司/, "the company badge must be shown");
  assert.match(text, /AI 工作室/, "the company name must be shown");
  assert.match(text, /部门/);
  assert.match(text, /总部/);
  assert.match(text, /负责人/, "the company leader is derived, not invented");
  assert.match(text, /成员/);
  assert.match(text, /AA·助理/);
  assert.ok(text.indexOf("AI 工作室") < text.indexOf("总部"), "the company is drawn first");
  assert.ok(text.indexOf("总部") < text.indexOf("AA·助理"), "children follow their parent");
  assert.match(text, /└─ /, "the tree must be drawn with connectors, not a flat list");
});

test("the rendered architecture area contains NO controls at all", () => {
  const payload = buildTree(stateNodes());
  const types = typesOf(renderTree(payload, treeLines(payload)));
  assert.deepEqual(types.filter((t) => t === "button" || t === "input" || t === "select"), [],
    "the tree is display-only: a rename/delete/add control here would be a regression");
});

test("an orphan is shown AND called out -- a broken tree is never drawn as an empty one", () => {
  const payload = buildTree([...stateNodes(), { id: "x1", kind: "member", name: "失落者", parentId: "gone", agentId: "deadbeef-0000" }]);
  const text = textOf(renderTree(payload, treeLines(payload)));
  assert.match(text, /失落者/, "an orphan must still be visible");
  assert.match(text, /1 个节点找不到上级/);
  assert.match(text, /树是坏的，不是空的/);
});

test("an empty org says it is empty (structure is the agent's job), not that it is broken", () => {
  const payload = buildTree([]);
  const text = textOf(renderTree(payload, treeLines(payload)));
  assert.match(text, /还没有节点/);
  assert.match(text, /agent 安排/);
  assert.doesNotMatch(text, /树是坏的/);
});

test("graphic impossible + text tree present -> the host's treeLines are drawn, and said so", () => {
  const payload = buildTree(stateNodes());
  const text = textOf(renderTree(undefined, treeLines(payload)));
  assert.match(text, /版本不一致/);
  assert.match(text, /AI 工作室 \[company/, "the host's own indented line, not a client invention");
});

test("graphic impossible and no text tree -> a NAMED failure, never a silently empty box", () => {
  const text = textOf(renderTree(null, null));
  assert.match(text, /宿主没有提供只读树/);
  assert.match(text, /orgTree/);
});

/* ------------------------------ wiring ------------------------------ */

test("the dock draws the host tree; the __orgTreeLines placeholder is gone", () => {
  assert.doesNotMatch(code, /__orgTreeLines/, "the placeholder must not come back");
  assert.doesNotMatch(code, /window\.__org/, "no client-side global carries the tree");
  assert.match(serviceSource, /from "\.\/org-tree\.js"/, "the host must ship org-tree.js output");
  assert.match(serviceSource, /const orgTree = buildOrgTree\(this\.state\.nodes\)/);
  assert.match(serviceSource, /orgTree,\s*\n\s*treeLines: orgTreeLines\(orgTree\)/,
    "browserState must carry orgTree AND its text fallback");
});

test("the client can only touch the company: state / company / company rename", () => {
  const paths = [...code.matchAll(/\/agent-org-api\/[a-z/*]+/g)].map((m) => m[0]);
  const unique = [...new Set(paths)].sort();
  assert.deepEqual(unique, ["/agent-org-api/company", "/agent-org-api/nodes/", "/agent-org-api/state"],
    "the page must offer exactly: read the state, create the company, rename the company");
  assert.match(code, /encodeURIComponent\(node\.id\) \+ "\/update"/, "the company rename route");
});

test("the removed blocks cannot come back unnoticed", () => {
  for (const gone of ["新增部门", "设置上级", "加部门", "加团队", "加成员", "确认删除", "setLeader", "removeNode", "nodeRow"]) {
    assert.doesNotMatch(code, new RegExp(gone),
      `client.js still contains ${gone}: the architecture area must stay read-only`);
  }
  for (const dead of ["draft.dept", "draft.team", "draft.memberAgentId", "draft.memberName", "draft.leaderAgentId", "draft.leaderNode", "teamParent", "memberParent"]) {
    assert.doesNotMatch(code, new RegExp(dead), `${dead} is dead state and must be gone`);
  }
  assert.match(code, /renameCompany/, "the company rename is the one editor that stays");
});

test("the host write routes are UNTOUCHED -- arranging the org is still the agent's job", () => {
  for (const route of ["/agent-org-api/departments", "/agent-org-api/teams", "/agent-org-api/members", "/leader$/", "/delete$/", "/update$"]) {
    assert.ok(webSource.includes(route), `src/host/web.js must still register ${route}`);
  }
});

test("the dock trigger and panel wear agent-room's vocabulary, not their own", () => {
  assert.match(clientSource, /dsh-agent-room \(src\/client\/theme\.ts/,
    "the values are copied from that client, and the copy must stay documented");
  assert.match(code, /"Agent 组织"/, "same word construction as the room dock");
  assert.match(code, /" · " \+ nodeCount/, "same ' · N' count form as the room dock");
  assert.match(code, /padding: "7px 16px"/, "the room dock's trigger padding, not a smaller pill");
  assert.doesNotMatch(code, /(140,100,255|240,140,60)/, "the old org-only purple/orange tint is gone");
});

/* ------------------------------ the mounted panel ------------------------------ */

function mountPanel() {
  const list = stateNodes();
  const payload = buildTree(list);
  const state = {
    identity: { agentId: "01a0231b-bbe5-720a-97a4-819744eeae76", nickname: "*****" },
    nodes: list,
    tree: [],
    orgTree: payload,
    treeLines: treeLines(payload),
    summary: { total: 3, byStatus: { todo: 3 }, byOwner: { x: 3 }, rooms: [] },
    visibleMemberIds: ["01a0231b-bbe5-720a-97a4-819744eeae76"],
  };
  // OrgDock's four useState calls, in order: state / error / open / draft.
  const loaded = loadClient(makeReact([state, "", true, { company: "" }]));
  let registered = null;
  const ctx = {
    effect: (fn) => fn(),
    slots: {
      inject: (name, fn) => fn(),
      register: (definition, component) => { registered = component; return () => {}; },
    },
    locale: { register: () => () => {} },
  };
  loaded.bundle.apply(ctx);
  assert.equal(typeof registered, "function", "apply() must register the dock component");
  return registered();
}

function buttonsOf(node, out = []) {
  if (node === null || node === undefined || typeof node === "string" || typeof node === "number") return out;
  if (Array.isArray(node)) { for (const n of node) buttonsOf(n, out); return out; }
  if (typeof node !== "object") return out;
  if (node.type === "button") out.push(textOf(node));
  buttonsOf(node.props ? node.props.children : undefined, out);
  return out;
}

test("the mounted panel offers exactly ONE editor: the company rename", () => {
  const panel = mountPanel();
  const buttons = buttonsOf(panel);
  assert.deepEqual(buttons, ["🏢Agent 组织 · 5", "改名"],
    "the trigger plus the company rename -- anything else would be a page that can edit the structure");
  assert.equal(typesOf(panel).filter((t) => t === "input" || t === "select").length, 0,
    "a company already exists, so nothing is typed here at all");
});

test("the mounted panel shows the three remaining sections and no removed one", () => {
  const text = textOf(mountPanel());
  assert.match(text, /Agent 组织 · 5/, "the trigger carries the node count, not the task count");
  assert.match(text, /公司（唯一可改名）/);
  assert.match(text, /组织架构（只读）/);
  assert.match(text, /我能看到的下级任务汇总/);
  assert.match(text, /AI 工作室/);
  assert.match(text, /AA·助理/);
  assert.match(text, /负责人/);
  for (const gone of ["新增部门", "设置上级", "加部门", "加团队", "加成员", "删除", "设上级", "换上级", "选择部门"]) {
    assert.doesNotMatch(text, new RegExp(gone), `the panel still shows ${gone}`);
  }
});

test("the bundle requires nothing but react", () => {
  assert.ok(required.length >= 1 && required.every((id) => id === "react"), "requires: " + required.join(", "));
  assert.ok(bundle.apply && bundle.inject, "apply/inject are the plugin contract");
});
