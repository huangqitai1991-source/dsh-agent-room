/**
 * 0.2.14 horizontal isolation — unit tests for the exec authorization decision.
 *
 * Run: node test/exec-authz.test.mjs      (no dependencies; the plugin carries no node_modules)
 *
 * Four counterexample classes are required by the card:
 *   A. lead OUTSIDE its subtree  -> denied (the new rule; pre-0.2.14 this was allowed)
 *   B. lead INSIDE its subtree   -> allowed
 *   C. owner across departments  -> allowed (owner is the only cross-department channel)
 *   D. member / observer / empty actor / unknown target -> denied (fail-closed)
 * plus a malformed-tree (parentId cycle) case that must ANSWER, not hang.
 */
import { canExecTarget, leadsTarget, subtreeUnitIds, superiorOf, roleFor } from "../src/host/permission.js";
import { descendantNodes } from "../src/host/visibility.js";

const OWNER = "01a00000-0000-7000-8000-000000000001";
const TING = "01a00000-0000-7000-8000-000000000002"; // lead of deptA
const TAI = "01a00000-0000-7000-8000-000000000003";  // member of deptA (new machine)
const MAI = "01a00000-0000-7000-8000-000000000004";  // member of deptB (unreachable box)
const NOBODY = "01a00000-0000-7000-8000-000000000009";

const state = {
  nodes: [
    { id: "c", kind: "company", name: "AI 工作室", parentId: null, leaderAgentId: OWNER },
    { id: "hq", kind: "department", name: "总部", parentId: "c", leaderAgentId: "" },
    { id: "m-main", kind: "member", name: "主控·总控", parentId: "hq", agentId: OWNER },
    { id: "m-bb", kind: "member", name: "BB·执行", parentId: "hq", agentId: MAI },
    { id: "dep-a", kind: "department", name: "黄銮泰", parentId: "c", leaderAgentId: TING },
    { id: "m-ting", kind: "member", name: "DD·复核", parentId: "dep-a", agentId: TING },
    { id: "m-tai", kind: "member", name: "泰泰宝", parentId: "dep-a", agentId: TAI },
    { id: "team-a1", kind: "team", name: "小组", parentId: "dep-a", leaderAgentId: "" },
  ],
};

let pass = 0;
let fail = 0;
const t = (name, cond, extra = "") => {
  if (cond) { pass += 1; console.log("PASS  " + name + (extra ? "  " + extra : "")); }
  else { fail += 1; console.log("FAIL  " + name + (extra ? "  " + extra : "")); }
};

const d = (actor, target) => canExecTarget(state, actor, target);

// C. owner is company-wide
t("C owner -> other department's member = allowed", d(OWNER, MAI).allowed === true, JSON.stringify(d(OWNER, MAI)));
t("C owner -> own member = allowed", d(OWNER, TING).allowed === true);

// B. lead inside its own subtree
t("B lead -> member in own department = allowed", d(TING, TAI).allowed === true, JSON.stringify(d(TING, TAI)));
t("B  viaNodeId is the led unit", d(TING, TAI).viaNodeId === "dep-a");
t("B  lead -> itself is inside own subtree = allowed", d(TING, TING).allowed === true);

// A. THE NEW RULE: a lead may not reach outside the subtree it leads
t("A lead -> member of ANOTHER department = DENIED", d(TING, MAI).allowed === false, d(TING, MAI).reason);
t("A lead -> company owner = DENIED", d(TING, OWNER).allowed === false);
t("A leadsTarget() reports outside=false", leadsTarget(state, TING, MAI).inSubtree === false);

// D. fail-closed
t("D member -> anyone = DENIED", d(MAI, TAI).allowed === false, d(MAI, TAI).reason);
t("D observer -> anyone = DENIED", d(NOBODY, TAI).allowed === false);
t("D empty actor = DENIED", d("", TAI).allowed === false);
t("D empty target = DENIED", d(OWNER, "").allowed === false);
t("D unknown target: owner allowed BY RULE but recorded targetKnown=false", d(OWNER, "deadbeef-0000-7000-8000-000000000000").allowed === true && d(OWNER, "deadbeef-0000-7000-8000-000000000000").targetKnown === false);
t("D unknown target: lead DENIED (fail-closed)", d(TING, "deadbeef-0000-7000-8000-000000000000").allowed === false, d(TING, "deadbeef-0000-7000-8000-000000000000").reason);
t("D known target: owner records targetKnown=true", d(OWNER, MAI).targetKnown === true);
t("D classify('exec') stays unknown (no L1/L2 shortcut)", canExecTarget(state, OWNER, MAI).level === "unknown");

// roles
t("roleFor: company leader = owner", roleFor(state, OWNER) === "owner");
t("roleFor: dept leader = lead", roleFor(state, TING) === "lead");
t("roleFor: plain member = member", roleFor(state, MAI) === "member");
t("roleFor: stranger = observer", roleFor(state, NOBODY) === "observer");

// subtree helper
const ids = subtreeUnitIds(state, "dep-a");
t("subtreeUnitIds lists team-a1", ids.includes("team-a1"), JSON.stringify(ids));

// malformed tree: parentId cycle must ANSWER, not hang
const cyclic = {
  nodes: [
    { id: "x", kind: "department", name: "X", parentId: "y", leaderAgentId: TING },
    { id: "y", kind: "department", name: "Y", parentId: "x", leaderAgentId: "" },
    { id: "m-z", kind: "member", name: "Z", parentId: "x", agentId: MAI },
  ],
};
const guard = (label, fn) => {
  const started = Date.now();
  try {
    const value = fn();
    t(label + " returns instead of hanging", Date.now() - started < 2000, `${Date.now() - started}ms`);
    return value;
  } catch (e) {
    t(label + " returns instead of hanging", false, String(e && e.message));
    return null;
  }
};
guard("cycle: subtreeUnitIds", () => subtreeUnitIds(cyclic, "x"));
guard("cycle: descendantNodes", () => descendantNodes(cyclic, "x"));
guard("cycle: superiorOf", () => superiorOf(cyclic, MAI));
const cyc = guard("cycle: canExecTarget", () => canExecTarget(cyclic, TING, MAI));
t("cycle: decision is still fail-closed or explicit", cyc === null || typeof cyc.allowed === "boolean");

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
