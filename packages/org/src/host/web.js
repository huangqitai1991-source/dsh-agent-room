/**
 * dsh-agent-org — browser API routes under /agent-org-api.
 *
 * The web client (OrgDock) reads GET /agent-org-api/state and posts CRUD
 * operations here.
 */

export const name = "agent-org-web";
export const inject = ["agentOrg", "webServer"];

const MAX_BODY = 64 * 1024;

/**
 * @param {import("./service.js").OrgService} service
 */
export function createRouter(service) {
  return async (request, response) => {
    try {
      const url = new URL(request.url ?? "/", "http://localhost");
      const path = url.pathname;
      const method = request.method ?? "GET";

      if (method === "GET" && path === "/agent-org-api/state") {
        const data = await service.browserState();
        return sendJson(response, 200, { ok: true, data });
      }

      if (method === "GET" && path === "/agent-org-api/me") {
        const identity = await service.agentRoom?.gateway?.identity?.();
        const role = await service.myRole(identity?.agentId ?? "");
        return sendJson(response, 200, { ok: true, data: { identity: identity ?? null, ...role } });
      }

      if (method === "GET" && path === "/agent-org-api/sync") {
        const data = await service.getSyncConfig();
        return sendJson(response, 200, { ok: true, data });
      }

      if (method === "POST" && path === "/agent-org-api/sync") {
        const body = await readJson(request);
        const data = await service.setSyncRoom(body.roomId === undefined ? "" : String(body.roomId ?? ""));
        return sendJson(response, 200, { ok: true, data });
      }

      if (method === "POST" && path === "/agent-org-api/exec") {
        const body = await readJson(request);
        const data = await service.sendExec(String(body.targetAgentId ?? ""), String(body.command ?? ""));
        return sendJson(response, 200, { ok: true, data });
      }

      if (method === "GET" && path === "/agent-org-api/permissions") {
        const identity = await service.agentRoom?.gateway?.identity?.();
        const agentId = identity?.agentId ?? "";
        const role = service.roleOf(agentId);
        return sendJson(response, 200, { ok: true, data: { identity: identity ?? null, role } });
      }

      if (method === "POST" && path === "/agent-org-api/approvals") {
        const body = await readJson(request);
        const identity = await service.agentRoom?.gateway?.identity?.();
        const data = service.requestApproval(identity?.agentId ?? "", String(body.action ?? ""), String(body.target ?? ""));
        return sendJson(response, 200, { ok: true, data });
      }

      if (method === "GET" && path === "/agent-org-api/approvals") {
        const identity = await service.agentRoom?.gateway?.identity?.();
        const data = service.listApprovals(identity?.agentId ?? "");
        return sendJson(response, 200, { ok: true, data });
      }

      const approvalMatch = /^\/agent-org-api\/approvals\/([^/]+)\/(approve|reject)$/.exec(path);
      if (method === "POST" && approvalMatch) {
        const identity = await service.agentRoom?.gateway?.identity?.();
        const data = service.decide(decodeURIComponent(approvalMatch[1]), identity?.agentId ?? "", approvalMatch[2] === "approve");
        return sendJson(response, 200, { ok: true, data });
      }

      if (method === "GET" && path === "/agent-org-api/audit") {
        const data = await service.exportAudit();
        return sendJson(response, 200, { ok: true, data });
      }

      if (method === "POST" && path === "/agent-org-api/studio") {
        const body = await readJson(request);
        const state = await service.applyStudioPreset({
          company: body.company ? String(body.company) : undefined,
          controllerAgentId: body.controllerAgentId ? String(body.controllerAgentId) : undefined,
          members: Array.isArray(body.members)
            ? body.members.map((m) => ({ agentId: String(m.agentId ?? ""), name: m.name ? String(m.name) : undefined }))
            : undefined,
        });
        return sendJson(response, 200, { ok: true, data: { nodes: state.nodes } });
      }

      if (method === "POST" && path === "/agent-org-api/company") {
        const body = await readJson(request);
        const node = await service.createCompany(String(body.name ?? "").trim());
        return sendJson(response, 200, { ok: true, data: { node } });
      }

      if (method === "POST" && path === "/agent-org-api/departments") {
        const body = await readJson(request);
        const node = await service.createDepartment(String(body.companyId ?? ""), String(body.name ?? ""));
        return sendJson(response, 200, { ok: true, data: { node } });
      }

      if (method === "POST" && path === "/agent-org-api/teams") {
        const body = await readJson(request);
        const node = await service.createTeam(String(body.departmentId ?? ""), String(body.name ?? ""));
        return sendJson(response, 200, { ok: true, data: { node } });
      }

      if (method === "POST" && path === "/agent-org-api/members") {
        const body = await readJson(request);
        const node = await service.addMember(String(body.parentId ?? ""), {
          agentId: String(body.agentId ?? ""),
          name: body.name ? String(body.name) : undefined,
        });
        return sendJson(response, 200, { ok: true, data: { node } });
      }

      const updateMatch = /^\/agent-org-api\/nodes\/([^/]+)\/update$/.exec(path);
      if (method === "POST" && updateMatch) {
        const body = await readJson(request);
        // 0.2.12: the rename is authorized against THIS machine's identity, which
        // is the only caller identity an unauthenticated same-origin route can
        // honestly claim. `localAgentId()` never mints an identity (see
        // OrgService.localAgentId), and a cold cache yields "" -> denied.
        const actor = await service.localAgentId();
        const node = await service.updateNode(decodeURIComponent(updateMatch[1]), {
          name: body.name !== undefined ? String(body.name) : undefined,
          agentId: body.agentId !== undefined ? String(body.agentId) : undefined,
          leaderAgentId: body.leaderAgentId !== undefined ? body.leaderAgentId : undefined,
        }, actor);
        return sendJson(response, 200, { ok: true, data: { node, renamedBy: actor } });
      }

      const leaderMatch = /^\/agent-org-api\/nodes\/([^/]+)\/leader$/.exec(path);
      if (method === "POST" && leaderMatch) {
        const body = await readJson(request);
        const node = await service.setLeader(
          decodeURIComponent(leaderMatch[1]),
          body.agentId === undefined || body.agentId === null || body.agentId === "" ? null : String(body.agentId),
        );
        return sendJson(response, 200, { ok: true, data: { node } });
      }

      const deleteMatch = /^\/agent-org-api\/nodes\/([^/]+)\/delete$/.exec(path);
      if (method === "POST" && deleteMatch) {
        await service.removeNode(decodeURIComponent(deleteMatch[1]));
        return sendJson(response, 200, { ok: true });
      }

      return sendJson(response, 404, { ok: false, error: "not-found" });
    } catch (error) {
      return sendJson(response, error?.code ? 400 : 500, {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
        code: error?.code,
      });
    }
  };
}

export const webPlugin = {
  name,
  inject,
  apply(ctx) {
    ctx.effect(
      () => ctx.webServer.register({ kind: "prefix", path: "/agent-org-api", handler: createRouter(ctx.agentOrg) }),
      "agent-org: browser api",
    );
  },
};

function sendJson(response, status, value) {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  response.end(JSON.stringify(value));
}

async function readJson(request) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > MAX_BODY) throw new Error("request body is too large");
    chunks.push(buffer);
  }
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new Error("request body must be valid JSON");
  }
}
