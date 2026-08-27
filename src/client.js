/* dsh-agent-org browser bundle.
 *
 * This file is intentionally written in the final ModuleLoader shape so it can
 * be loaded directly without a separate build step. It registers an OrgDock
 * slot in the conversation header next to agent-room's dock.
 */
window.__ModuleLoader__.load({
  id: "dsh-agent-org",
  factory: (require) => {
    "use strict";
    var module = { exports: {} };
    var exports = module.exports;

    var React = require("react");

    /* ----------------------------- helpers ----------------------------- */

    async function api(path, body) {
      const response = await fetch(path, {
        method: body === undefined ? "GET" : "POST",
        headers: body === undefined ? undefined : { "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const json = await response.json();
      if (!json.ok || !response.ok) throw new Error(json.error || ("HTTP " + response.status));
      return json.data;
    }

    var h = React.createElement;

    var S = {
      wrap: {
        position: "relative",
        display: "inline-flex",
        alignItems: "center",
      },
      tab: {
        display: "flex",
        alignItems: "center",
        gap: 6,
        padding: "3px 10px",
        fontSize: 12,
        fontWeight: 600,
        color: "#111",
        background: "linear-gradient(135deg, rgba(140,100,255,.18), rgba(240,140,60,.16))",
        border: "1px solid rgba(140,100,255,.45)",
        borderRadius: 999,
        cursor: "pointer",
        whiteSpace: "nowrap",
        userSelect: "none",
        boxShadow: "0 2px 8px rgba(140,100,255,.25)",
      },
      dropdown: {
        position: "absolute",
        top: "calc(100% + 8px)",
        right: 0,
        width: 520,
        maxWidth: "min(520px, calc(100vw - 24px))",
        background: "rgba(22,24,30,.94)",
        border: "1px solid rgba(140,100,255,.35)",
        borderRadius: 12,
        boxShadow: "0 16px 44px rgba(0,0,0,.5), 0 0 0 1px rgba(140,100,255,.12), 0 0 24px rgba(140,100,255,.18)",
        zIndex: 999,
        overflow: "hidden",
        fontSize: 13,
        color: "#fff",
      },
      panelScroll: {
        overflowY: "auto",
        maxHeight: "72vh",
        display: "flex",
        flexDirection: "column",
      },
      header: {
        display: "flex",
        alignItems: "center",
        gap: 8,
        padding: "6px 10px",
        borderBottom: "1px solid var(--dsh-border-color, rgba(128,128,128,.25))",
        fontWeight: 600,
        flexShrink: 0,
      },
      section: {
        padding: "8px 10px",
        borderBottom: "1px solid var(--dsh-border-color, rgba(128,128,128,.18))",
      },
      title: {
        fontSize: 12,
        fontWeight: 700,
        opacity: 0.75,
        marginBottom: 6,
      },
      row: {
        display: "flex",
        alignItems: "center",
        gap: 6,
        padding: "3px 0",
        flexWrap: "wrap",
      },
      input: {
        flex: 1,
        minWidth: 120,
        background: "rgba(0,0,0,.28)",
        border: "1px solid var(--dsh-border-color, rgba(128,128,128,.4))",
        borderRadius: 6,
        padding: "4px 8px",
        color: "inherit",
        fontSize: 13,
      },
      select: {
        flex: 1,
        minWidth: 140,
        background: "rgba(255,255,255,.92)",
        border: "1px solid var(--dsh-border-color, rgba(128,128,128,.4))",
        borderRadius: 6,
        padding: "4px 8px",
        color: "#111",
        fontSize: 13,
      },
      button: {
        background: "var(--dsh-accent, #7a5cff)",
        color: "#fff",
        border: "none",
        borderRadius: 6,
        padding: "4px 10px",
        fontSize: 12,
        cursor: "pointer",
      },
      buttonGhost: {
        background: "transparent",
        color: "inherit",
        border: "1px solid var(--dsh-border-color, rgba(128,128,128,.4))",
        borderRadius: 6,
        padding: "2px 8px",
        fontSize: 11,
        cursor: "pointer",
      },
      nodeRow: {
        display: "flex",
        alignItems: "center",
        gap: 6,
        padding: "3px 0",
        flexWrap: "wrap",
      },
      badge: {
        display: "inline-block",
        borderRadius: 999,
        padding: "0 6px",
        fontSize: 10,
        lineHeight: "16px",
        background: "rgba(140,100,255,.22)",
        border: "1px solid rgba(140,100,255,.4)",
        marginRight: 4,
      },
      error: {
        color: "#ff6b6b",
        padding: "4px 10px",
        fontSize: 12,
        background: "rgba(255,0,0,.08)",
      },
    };

    function OrgDock() {
      var [state, setState] = React.useState(null);
      var [error, setError] = React.useState("");
      var [open, setOpen] = React.useState(false);
      var [draft, setDraft] = React.useState({
        company: "",
        dept: "",
        team: "",
        teamParent: "",
        memberParent: "",
        memberAgentId: "",
        memberName: "",
        leaderNode: "",
        leaderAgentId: "",
      });
      var [confirm, setConfirm] = React.useState(null);

      var refresh = React.useCallback(async function () {
        try {
          var data = await api("/agent-org-api/state");
          setState(data);
          setError("");
        } catch (e) {
          setError(e.message);
        }
      }, []);

      React.useEffect(function () {
        refresh();
        var timer = setInterval(refresh, 5000);
        return function () { clearInterval(timer); };
      }, [refresh]);

      function set(key) {
        return function (event) {
          var value = event.target.value;
          setDraft(function (old) { return Object.assign({}, old, { [key]: value }); });
        };
      }

      async function act(path, body) {
        try {
          await api(path, body);
          await refresh();
          setError("");
        } catch (e) {
          setError(e.message);
        }
      }

      function renameNode(node) {
        var name = window.prompt("新名称", node.name);
        if (name && name.trim()) act("/agent-org-api/nodes/" + encodeURIComponent(node.id) + "/update", { name: name.trim() });
      }

      function setLeader(node) {
        var agentId = window.prompt("上级 agentId（留空清除）", node.leaderAgentId || "");
        act("/agent-org-api/nodes/" + encodeURIComponent(node.id) + "/leader", { agentId: agentId || "" });
      }

      function removeNode(node) {
        if (confirm === node.id) {
          act("/agent-org-api/nodes/" + encodeURIComponent(node.id) + "/delete", {});
          setConfirm(null);
        } else {
          setConfirm(node.id);
        }
      }

      var nodes = state && state.nodes ? state.nodes : [];
      var company = nodes.find(function (n) { return n.kind === "company"; }) || null;
      var departments = nodes.filter(function (n) { return n.kind === "department"; });
      var orgUnits = nodes.filter(function (n) { return n.kind !== "member"; });
      var memberParents = nodes.filter(function (n) { return n.kind === "department" || n.kind === "team"; });
      var summary = state && state.summary ? state.summary : { total: 0, byStatus: {}, byOwner: {}, rooms: [] };

      function renderNode(node, depth) {
        var kids = (node.children || []).map(function (child) {
          return renderNode(child, depth + 1);
        });
        var label = node.kind === "member"
          ? h("span", null, h("strong", null, node.name), " (", node.agentId, ")")
          : h("span", null, h("strong", null, node.name), node.leaderAgentId ? h("span", { style: { opacity: 0.65 } }, " 上级:" + node.leaderAgentId) : null);
        return h("div", { key: node.id },
          h("div", { style: Object.assign({ paddingLeft: depth * 14 }, S.nodeRow) },
            h("span", { style: S.badge }, node.kind),
            label,
            node.kind !== "company" && h("button", { style: S.buttonGhost, onClick: function () { removeNode(node); } }, confirm === node.id ? "确认删除" : "删除"),
            h("button", { style: S.buttonGhost, onClick: function () { renameNode(node); } }, "改名"),
            node.kind !== "member" && h("button", { style: S.buttonGhost, onClick: function () { setLeader(node); } }, node.leaderAgentId ? "换上级" : "设上级")
          ),
          kids
        );
      }

      var tree = state && state.tree ? state.tree : [];

      return h("div", { style: S.wrap },
        h("div", { style: S.tab, onClick: function () { setOpen(!open); } }, "组织", state ? "(" + summary.total + ")" : ""),
        open && h("div", { style: S.dropdown },
          h("div", { style: S.panelScroll },
            h("div", { style: S.header }, "公司组织 / 层级可见性", state && state.identity ? h("span", { style: { opacity: 0.65, fontSize: 11 } }, "我:" + state.identity.agentId) : null),
            error && h("div", { style: S.error }, error),

            h("div", { style: S.section },
              h("div", { style: S.title }, "公司"),
              h("div", { style: S.row },
                company
                  ? h("span", { style: { flex: 1 } }, company.name)
                  : h("input", { style: S.input, value: draft.company, onChange: set("company"), placeholder: "公司名称" }),
                company
                  ? h("button", { style: S.buttonGhost, onClick: function () { renameNode(company); } }, "改名")
                  : h("button", { style: S.button, onClick: function () { act("/agent-org-api/company", { name: draft.company }); } }, "创建公司")
              )
            ),

            h("div", { style: S.section },
              h("div", { style: S.title }, "新增部门 / 团队 / 成员"),
              h("div", { style: S.row },
                h("input", { style: S.input, value: draft.dept, onChange: set("dept"), placeholder: "部门名称" }),
                h("button", { style: S.button, disabled: !company, onClick: function () { if (company) act("/agent-org-api/departments", { companyId: company.id, name: draft.dept }); } }, "加部门")
              ),
              h("div", { style: S.row },
                h("select", { style: S.select, value: draft.teamParent, onChange: set("teamParent") },
                  h("option", { value: "" }, "选择部门…"),
                  departments.map(function (d) { return h("option", { key: d.id, value: d.id }, d.name); })
                ),
                h("input", { style: S.input, value: draft.team, onChange: set("team"), placeholder: "团队名称" }),
                h("button", { style: S.button, onClick: function () { if (draft.teamParent) act("/agent-org-api/teams", { departmentId: draft.teamParent, name: draft.team }); } }, "加团队")
              ),
              h("div", { style: S.row },
                h("select", { style: S.select, value: draft.memberParent, onChange: set("memberParent") },
                  h("option", { value: "" }, "选择部门/团队…"),
                  memberParents.map(function (n) { return h("option", { key: n.id, value: n.id }, n.name + " (" + n.kind + ")"); })
                ),
                h("input", { style: S.input, value: draft.memberAgentId, onChange: set("memberAgentId"), placeholder: "成员 agentId" }),
                h("input", { style: S.input, value: draft.memberName, onChange: set("memberName"), placeholder: "姓名（可选）" }),
                h("button", { style: S.button, onClick: function () { if (draft.memberParent && draft.memberAgentId) act("/agent-org-api/members", { parentId: draft.memberParent, agentId: draft.memberAgentId, name: draft.memberName }); } }, "加成员")
              )
            ),

            h("div", { style: S.section },
              h("div", { style: S.title }, "设置上级（可见范围：本节点及所有下级）"),
              h("div", { style: S.row },
                h("select", { style: S.select, value: draft.leaderNode, onChange: set("leaderNode") },
                  h("option", { value: "" }, "选择公司/部门/团队…"),
                  orgUnits.map(function (n) { return h("option", { key: n.id, value: n.id }, n.name + " (" + n.kind + ")"); })
                ),
                h("input", { style: S.input, value: draft.leaderAgentId, onChange: set("leaderAgentId"), placeholder: "上级 agentId" }),
                h("button", { style: S.button, onClick: function () { if (draft.leaderNode && draft.leaderAgentId) act("/agent-org-api/nodes/" + encodeURIComponent(draft.leaderNode) + "/leader", { agentId: draft.leaderAgentId }); } }, "设上级")
              )
            ),

            h("div", { style: S.section },
              h("div", { style: S.title }, "组织树"),
              tree.map(function (node) { return renderNode(node, 0); })
            ),

            h("div", { style: S.section },
              h("div", { style: S.title }, "我能看到的下级任务汇总"),
              h("div", { style: S.row }, "总任务: ", summary.total),
              h("div", { style: S.row }, "按状态: ", JSON.stringify(summary.byStatus)),
              h("div", { style: S.row }, "按成员: ", JSON.stringify(summary.byOwner)),
              h("div", { style: S.row }, "可见成员: ", state && state.visibleMemberIds ? state.visibleMemberIds.join(", ") : "（无）")
            )
          )
        )
      );
    }

    /* ----------------------------- registration ---------------------------- */

    var NS = "agent-org";

    var zh = { title: "公司组织" };
    var en = { title: "Org" };

    function apply(ctx) {
      ctx.effect(function () { return ctx.locale.register(NS, { zh: zh, en: en }); }, "agent-org: dictionaries");
      ctx.effect(function () {
        return ctx.slots.inject("conversation.session.header.utilities", function () {
          return ctx.slots.register(
            {
              name: "conversation.session.header.utilities",
              id: "agent-org-dock-top",
              order: 460,
              locale: NS,
              inject: function () { return {}; },
            },
            OrgDock
          );
        });
      }, "agent-org: dock");
    }

    var inject = ["slots", "locale"];

    exports.apply = apply;
    exports.inject = inject;

    return module.exports;
  }
});
