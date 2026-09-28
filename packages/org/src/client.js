/* dsh-agent-org browser bundle.
 *
 * This file is intentionally written in the final ModuleLoader shape so it can
 * be loaded directly without a separate build step. It registers an OrgDock
 * slot in the conversation header next to agent-room's dock.
 *
 * 2026-09-16 (human): the panel is READ-ONLY except for the company name.
 *   * "新增部门 / 团队 / 成员" and "设置上级" are gone -- arrangement is the agent's job;
 *   * every node row lost its 改名 / 删除 buttons; only the company can be renamed;
 *   * the architecture area is a small read-only tree drawn from the pure, tested host
 *     module src/host/org-tree.js (see "read-only architecture view" below);
 *   * the host write routes are UNTOUCHED -- the page stopped offering them, the
 *     capability stays for the agent (see the note inside OrgDock).
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

    /* ------------------------- shared visual vocabulary -------------------------
     * Token for token from dsh-agent-room (src/client/theme.ts: THEME, GLOBAL_CSS), because the two
     * docks sit side by side in the same header: one word, one visual level, not two inventions.
     * Nothing here is a new colour, a new radius or a new type size.
     *
     * The .ar-* class names below are agent-room's own vocabulary (.ar-root / .ar-panel / .ar-btn /
     * .ar-input): when that plugin is loaded its injected global CSS adds the shared hover / active /
     * focus / scrollbar polish. The inline values are complete on their own, so the panel is still
     * correct if agent-room is not installed -- the class names never carry required layout.
     */
    var T = {
      panelGrad: "linear-gradient(160deg, rgba(22,16,44,.96), rgba(11,8,22,.98)), radial-gradient(1200px 600px at 18% -12%, rgba(139,92,246,.28), transparent 60%), radial-gradient(900px 520px at 112% 8%, rgba(34,211,238,.14), transparent 55%), radial-gradient(700px 500px at 50% 118%, rgba(192,132,252,.18), transparent 60%)",
      card: "rgba(26,20,46,.8)",
      input: "rgba(8,6,18,.7)",
      border: "rgba(168,139,250,.24)",
      accent: "#8b5cf6",
      purple: "#c084fc",
      cyan: "#22d3ee",
      green: "#34d399",
      amber: "#fbbf24",
      red: "#f87171",
      redSoft: "rgba(248,113,113,.14)",
      text: "#ede9fe",
      dim: "rgba(237,233,254,.64)",
      faint: "rgba(237,233,254,.42)",
      font: '-apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif',
      mono: '"SF Mono", "Cascadia Code", Consolas, "Liberation Mono", monospace',
      radius: 16,
      radiusSm: 9,
    };

    var S = {
      wrap: {
        position: "relative",
        display: "inline-flex",
        alignItems: "center",
        fontFamily: T.font,
      },
      // The trigger is agent-room's dock trigger, value for value: same padding, same type size,
      // same gradient, same border, same glow, same " · N" count form (see index.tsx of that client,
      // "Agent 房间 · N").
      tab: {
        display: "flex",
        alignItems: "center",
        gap: 8,
        padding: "7px 16px",
        fontSize: 14,
        fontWeight: 700,
        color: "#eef2ff",
        background: "linear-gradient(135deg, rgba(139,92,246,.32), rgba(192,132,252,.16))",
        border: "1px solid rgba(168,139,250,.6)",
        borderRadius: 999,
        cursor: "pointer",
        whiteSpace: "nowrap",
        userSelect: "none",
        boxShadow: "0 2px 14px rgba(139,92,246,.42)",
        transition: "box-shadow .25s ease, transform .25s ease, border-color .25s ease",
      },
      // ... and the panel is that client's panel (gradient / border / radius / shadow). The HEIGHT is
      // carried by the scrolling child, not by a `flex: 1` child of an auto-height column: with a
      // single flex-basis-0 child the column collapses to its 2px of borders (the render harness
      // measured exactly that, 3px tall).
      dropdown: {
        position: "absolute",
        top: "calc(100% + 10px)",
        right: 0,
        width: 520,
        maxWidth: "min(96vw, 520px)",
        background: T.panelGrad,
        border: "1px solid rgba(168,139,250,.45)",
        borderRadius: 16,
        boxShadow: "0 20px 60px rgba(0,0,0,.65), 0 0 0 1px rgba(168,139,250,.16), 0 0 36px rgba(139,92,246,.28)",
        zIndex: 9999,
        overflow: "hidden",
        fontSize: 14,
        color: T.text,
      },
      panelScroll: {
        overflowY: "auto",
        maxHeight: "76vh",
        display: "flex",
        flexDirection: "column",
      },
      header: {
        display: "flex",
        alignItems: "center",
        gap: 10,
        padding: "10px 14px",
        borderBottom: "1px solid " + T.border,
        flexShrink: 0,
      },
      headerTitle: {
        fontWeight: 800,
        fontSize: 16,
        letterSpacing: 0.2,
        color: T.text,
      },
      headerSub: {
        fontSize: 12,
        color: T.faint,
        fontWeight: 400,
      },
      section: {
        padding: "10px 14px",
        borderBottom: "1px solid " + T.border,
      },
      // SectionTitle of agent-room's common.tsx: 13px / 700 / full-strength text (never a dimmed 12px).
      title: {
        display: "flex",
        alignItems: "center",
        gap: 6,
        fontSize: 13,
        fontWeight: 700,
        color: T.text,
        marginBottom: 6,
      },
      row: {
        display: "flex",
        alignItems: "center",
        gap: 8,
        padding: "5px 0",
        flexWrap: "wrap",
      },
      input: {
        flex: 1,
        minWidth: 120,
        fontFamily: "inherit",
        color: T.text,
        background: T.input,
        border: "1px solid " + T.border,
        borderRadius: T.radiusSm,
        padding: "5px 9px",
        fontSize: 13,
        outline: "none",
      },
      // Btn variant="primary" (common.tsx).
      button: {
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        gap: 6,
        fontSize: 12,
        padding: "5px 10px",
        background: "linear-gradient(135deg, #8b5cf6, #6d28d9)",
        color: "#fff",
        border: "1px solid rgba(192,132,252,.55)",
        borderRadius: T.radiusSm,
        boxShadow: "0 2px 12px rgba(139,92,246,.4)",
        fontFamily: "inherit",
        cursor: "pointer",
        whiteSpace: "nowrap",
        userSelect: "none",
      },
      // Btn variant="ghost" (common.tsx).
      buttonGhost: {
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        gap: 6,
        fontSize: 12,
        padding: "5px 10px",
        background: "rgba(168,139,250,.1)",
        color: T.text,
        border: "1px solid " + T.border,
        borderRadius: T.radiusSm,
        fontFamily: "inherit",
        cursor: "pointer",
        whiteSpace: "nowrap",
        userSelect: "none",
      },
      // Pill (common.tsx) -- also the shape of the role badges in the tree.
      pill: {
        display: "inline-flex",
        alignItems: "center",
        gap: 4,
        fontSize: 11,
        fontWeight: 600,
        lineHeight: 1,
        padding: "3px 7px",
        borderRadius: 999,
        color: "#e7e0ff",
        background: "rgba(139,92,246,.18)",
        border: "1px solid rgba(168,139,250,.34)",
        whiteSpace: "nowrap",
      },
      tree: {
        padding: "2px 0",
      },
      treeRow: {
        display: "flex",
        alignItems: "center",
        gap: 6,
        fontSize: 12,
        lineHeight: "20px",
        whiteSpace: "nowrap",
      },
      treeBranch: {
        fontFamily: T.mono,
        color: T.faint,
        whiteSpace: "pre",
      },
      treeName: {
        color: T.text,
      },
      treeNameRoot: {
        color: T.text,
        fontWeight: 700,
      },
      treeId: {
        fontFamily: T.mono,
        fontSize: 10,
        color: T.faint,
      },
      treeText: {
        fontFamily: T.mono,
        fontSize: 11,
        lineHeight: "18px",
        color: T.text,
        whiteSpace: "pre",
      },
      muted: {
        fontSize: 12,
        color: T.faint,
      },
      warn: {
        fontSize: 12,
        color: T.amber,
        lineHeight: "18px",
      },
      // The error strip of agent-room's panel.
      error: {
        display: "flex",
        alignItems: "center",
        gap: 8,
        padding: "6px 14px",
        background: T.redSoft,
        color: T.red,
        fontSize: 12,
        borderBottom: "1px solid rgba(248,113,113,.35)",
        flexShrink: 0,
      },
    };

    /* ---------------------- read-only architecture view ----------------------
     * WHERE THE LINES COME FROM (chosen deliberately, 2026-09-16 -- the placeholder
     * `window.__orgTreeLines` is gone):
     *   the host builds the tree with the pure, tested module src/host/org-tree.js and ships it in
     *   GET /agent-org-api/state as `orgTree` (the buildTree object: roots / displayed / orphans)
     *   plus `treeLines` (the indented text fallback). This bundle only DRAWS it.
     *
     * Neither of the two other options can reach this file, and that is why:
     *   * module import -- this bundle is executed by the DSH client ModuleLoader in the browser and
     *     can require("react") and nothing of the plugin's host ESM. agent-room's client is the same
     *     shape: it fetches /agent-room-api/state instead of importing host code.
     *   * build-time injection -- package.json exports "./client" -> "./src/client.js" and lib/ is a
     *     gitignored build copy that `files` does not publish, so anything injected into lib/client.js
     *     would never be loaded by DSH.
     * One implementation (the host's), already covered by test/org-tree.test.mjs, drawn here.
     */
    var KIND_ZH = { company: "公司", department: "部门", team: "团队", owner: "负责人", member: "成员" };

    /** Role badge colour, from agent-room's ROLE_COLOR palette (theme.ts). */
    function roleColor(role) {
      if (role === "company") return T.purple;
      if (role === "owner") return T.amber;
      if (role === "department") return T.cyan;
      if (role === "team") return T.green;
      return "#9b93b4";
    }

    function treeRow(node, marker, key) {
      var color = roleColor(node.role);
      // Only a node that carries an agentId gets one printed (treeLines makes the same choice): a
      // company or a department is a place, not an agent, and "-" there is noise.
      var shortId = node.agentId ? (node.shortId || String(node.agentId).slice(0, 8)) : "";
      return h("div", { key: key, style: S.treeRow },
        h("span", { style: S.treeBranch }, marker),
        h("span", { style: Object.assign({}, S.pill, { color: color, background: color + "1f", border: "1px solid " + color + "55" }) }, KIND_ZH[node.role] || node.role),
        h("span", { style: node.role === "company" ? S.treeNameRoot : S.treeName }, node.name || "(未命名)"),
        shortId ? h("span", { style: S.treeId }, shortId) : null
      );
    }

    function walkTree(children, prefix, rows, path) {
      var list = Array.isArray(children) ? children : [];
      for (var i = 0; i < list.length; i++) {
        var last = i === list.length - 1;
        rows.push(treeRow(list[i], prefix + (last ? "└─ " : "├─ "), path + i));
        walkTree(list[i].children, prefix + (last ? "   " : "│  "), rows, path + i + ".");
      }
    }

    /**
     * Draw the read-only tree. No controls are produced here -- the architecture section cannot
     * edit anything, by construction (asserted in test/client-readonly.test.mjs).
     */
    function renderTree(orgTree, treeLines) {
      var usable = orgTree && Array.isArray(orgTree.roots) && orgTree.roots.every(function (r) {
        return r && typeof r === "object" && !Array.isArray(r);
      });

      if (!usable) {
        // Graphic impossible (client/host version skew or a damaged payload). Fall back to the
        // host's indented text tree -- and when even that is absent, say so BY NAME rather than
        // drawing an empty box that looks like an empty organisation.
        if (Array.isArray(treeLines) && treeLines.length) {
          var textRows = [h("div", { key: "note", style: S.muted }, "宿主没给图形树，退回文字树（客户端与宿主版本不一致）")];
          for (var i = 0; i < treeLines.length; i++) {
            textRows.push(h("div", { key: "line-" + i, style: S.treeText }, String(treeLines[i])));
          }
          return h("div", { style: S.tree }, textRows);
        }
        return h("div", { style: S.warn }, "宿主没有提供只读树：/agent-org-api/state 里既没有 orgTree 也没有 treeLines（客户端与宿主版本不一致？）");
      }

      if (!orgTree.roots.length) {
        return h("div", { style: S.muted }, "还没有节点 —— 结构由 agent 安排，本页只读");
      }

      var rows = [];
      for (var r = 0; r < orgTree.roots.length; r++) {
        rows.push(treeRow(orgTree.roots[r], "● ", "root-" + r));
        walkTree(orgTree.roots[r].children, "   ", rows, "root-" + r + ".");
      }
      if (orgTree.orphans > 0) {
        rows.push(h("div", { key: "orphans", style: S.warn }, "⚠ " + orgTree.orphans + " 个节点找不到上级，已按根节点显示 —— 树是坏的，不是空的"));
      }
      return h("div", { style: S.tree }, rows);
    }

    function OrgDock() {
      var [state, setState] = React.useState(null);
      var [error, setError] = React.useState("");
      var [open, setOpen] = React.useState(false);
      // Only the company name is still typed by a human; every other field the old page carried
      // (dept / team / memberAgentId / memberName / leaderNode / leaderAgentId / ...Parent) was
      // removed with its controls instead of being left as dead state.
      var [draft, setDraft] = React.useState({ company: "" });

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

      /* The COMPANY is the only node this page may rename (human, 2026-09-16). Everything else is
       * display-only; the agent arranges the rest. The host write routes that back these removals
       * (departments / teams / members / nodes leader / nodes delete in src/host/web.js) are
       * deliberately still registered -- "the page stopped offering it" is not "the capability is
       * gone". (Route names are spelled out in src/host/web.js; writing them with a wildcard here
       * once closed this comment early -- the harness caught it, node --check did not.)
       */
      function renameCompany(node) {
        var name = window.prompt("公司新名称", node.name);
        if (name && name.trim()) act("/agent-org-api/nodes/" + encodeURIComponent(node.id) + "/update", { name: name.trim() });
      }

      var nodes = state && state.nodes ? state.nodes : [];
      var company = nodes.find(function (n) { return n.kind === "company"; }) || null;
      var orgTree = state && state.orgTree ? state.orgTree : null;
      var treeLines = state && state.treeLines ? state.treeLines : null;
      var summary = state && state.summary ? state.summary : { total: 0, byStatus: {}, byOwner: {}, rooms: [] };
      // The count on the trigger is the NUMBER OF NODES, the way agent-room counts rooms. It used
      // to print summary.total, which is the number of visible TASKS -- a different thing wearing
      // the same label.
      var nodeCount = orgTree && typeof orgTree.displayed === "number" ? orgTree.displayed : nodes.length;
      var who = state && state.identity ? (state.identity.nickname || state.identity.agentId) : "";

      return h("div", { style: S.wrap, className: "ar-root" },
        h("button", {
          style: S.tab,
          className: "ar-tab",
          title: "Agent 组织（点击展开）",
          onClick: function () { setOpen(!open); },
        }, h("span", null, "🏢"), h("span", null, "Agent 组织" + (state ? " · " + nodeCount : ""))),
        open && h("div", { style: S.dropdown, className: "ar-panel" },
          h("div", { style: S.panelScroll },
            h("div", { style: S.header },
              h("span", { style: { fontSize: 17 } }, "🏢"),
              h("div", null,
                h("div", { style: S.headerTitle, className: "ar-neon" }, "Agent 组织"),
                h("div", { style: S.headerSub }, (who ? who + " · " : "") + nodeCount + " 个节点")
              )
            ),
            error && h("div", { style: S.error }, h("span", { style: { flex: 1 } }, "⚠ " + error)),

            h("div", { style: S.section },
              h("div", { style: S.title }, "公司（唯一可改名）"),
              h("div", { style: S.row },
                company
                  ? h("span", { style: { flex: 1, color: T.text } }, company.name)
                  : h("input", { style: S.input, className: "ar-input", value: draft.company, onChange: set("company"), placeholder: "公司名称" }),
                company
                  ? h("button", { style: S.buttonGhost, className: "ar-btn", onClick: function () { renameCompany(company); } }, "改名")
                  : h("button", { style: S.button, className: "ar-btn", onClick: function () { act("/agent-org-api/company", { name: draft.company }); } }, "创建公司")
              )
            ),

            h("div", { style: S.section },
              h("div", { style: S.title }, "组织架构（只读）"),
              renderTree(orgTree, treeLines)
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
    // Test seam, NOT part of the plugin contract (DSH reads apply/inject only). renderTree is pure
    // element building -- no hooks, no DOM -- so test/client-readonly.test.mjs can assert what the
    // read-only section shows without a browser.
    exports.__internals = { renderTree: renderTree, KIND_ZH: KIND_ZH };

    return module.exports;
  }
});
