/**
 * dsh-agent-room — browser API routes under /agent-room-api.
 *
 * The web client (RoomDock) polls GET /agent-room-api/state and posts actions
 * here. The host forwards owned-room operations to RoomService (authoritative)
 * and joined-room operations to the matching RoomClient.
 */
export const name = "agent-room-web";
export const inject = ["agentRoom", "webServer"];
const MAX_BODY = 64 * 1024;
export function createRouter(service) {
    return async (request, response) => {
        try {
            const url = new URL(request.url ?? "/", "http://localhost");
            const path = url.pathname;
            const method = request.method ?? "GET";
            if (method === "GET" && path === "/agent-room-api/state") {
                const state = await service.browserState();
                return sendJson(response, 200, { ok: true, data: state });
            }
            const messagesMatch = /^\/agent-room-api\/rooms\/([^/]+)\/messages$/.exec(path);
            if (method === "GET" && messagesMatch) {
                const before = url.searchParams.get("before");
                const messages = await service.browserMessages(decodeURIComponent(messagesMatch[1]), 200, before ? Number(before) : undefined);
                return sendJson(response, 200, { ok: true, data: { messages } });
            }
            if (method === "POST" && path === "/agent-room-api/rooms") {
                const body = (await readJson(request));
                if (!body.title)
                    return sendJson(response, 400, { ok: false, error: "title is required" });
                const room = await service.gateway.createRoom({
                    title: body.title,
                    type: body.type === "temporary" ? "temporary" : "persistent",
                    settings: {
                        authMode: body.authMode === "password" ? "password" : "open",
                        password: body.password,
                        autoMode: body.autoMode,
                    },
                });
                return sendJson(response, 200, { ok: true, data: { roomId: room.roomId, serverAddress: room.serverAddress } });
            }
            if (method === "POST" && path === "/agent-room-api/join") {
                const body = (await readJson(request));
                const addresses = Array.isArray(body.addresses) && body.addresses.length > 0
                    ? body.addresses
                    : body.address ? [body.address] : [];
                if (addresses.length === 0)
                    return sendJson(response, 400, { ok: false, error: "address is required" });
                try {
                    const result = await service.gateway.joinRoom(addresses, {
                        roomId: body.roomId,
                        password: body.password,
                    });
                    return sendJson(response, 200, { ok: true, data: result });
                }
                catch (err) {
                    return sendJson(response, 400, { ok: false, error: err.message });
                }
            }
            const leaveMatch = /^\/agent-room-api\/rooms\/([^/]+)\/leave$/.exec(path);
            if (method === "POST" && leaveMatch) {
                await service.gateway.leaveRoom(decodeURIComponent(leaveMatch[1]));
                return sendJson(response, 200, { ok: true });
            }
            const deleteMatch = /^\/agent-room-api\/rooms\/([^/]+)\/delete$/.exec(path);
            if (method === "POST" && deleteMatch) {
                try {
                    await service.gateway.destroyRoom(decodeURIComponent(deleteMatch[1]));
                    return sendJson(response, 200, { ok: true });
                }
                catch (err) {
                    return sendJson(response, 400, { ok: false, error: err.message });
                }
            }
            const kickMatch = /^\/agent-room-api\/rooms\/([^/]+)\/members\/([^/]+)\/kick$/.exec(path);
            if (method === "POST" && kickMatch) {
                try {
                    await service.gateway.kickMember(decodeURIComponent(kickMatch[1]), decodeURIComponent(kickMatch[2]));
                    return sendJson(response, 200, { ok: true });
                }
                catch (err) {
                    return sendJson(response, 400, { ok: false, error: err.message });
                }
            }
            const autoReplyMatch = /^\/agent-room-api\/rooms\/([^/]+)\/auto-reply$/.exec(path);
            if (method === "POST" && autoReplyMatch) {
                const body = (await readJson(request));
                service.gateway.setAutoReply(decodeURIComponent(autoReplyMatch[1]), body.on === true);
                return sendJson(response, 200, { ok: true });
            }
            const chatMatch = /^\/agent-room-api\/rooms\/([^/]+)\/chat$/.exec(path);
            if (method === "POST" && chatMatch) {
                const body = (await readJson(request));
                if (!body.text)
                    return sendJson(response, 400, { ok: false, error: "text is required" });
                const message = await service.gateway.sendChat(decodeURIComponent(chatMatch[1]), {
                    text: body.text,
                    mentions: body.mentions,
                    human: body.human,
                });
                return sendJson(response, 200, { ok: true, data: { seq: message?.seq ?? null } });
            }
            const settingsMatch = /^\/agent-room-api\/rooms\/([^/]+)\/settings$/.exec(path);
            if (method === "POST" && settingsMatch) {
                const body = (await readJson(request));
                const room = await service.gateway.updateSettings(decodeURIComponent(settingsMatch[1]), {
                    authMode: body.authMode === "password" ? "password" : body.authMode ? "open" : undefined,
                    password: body.password,
                    autoMode: body.autoMode,
                    allowHumanTakeover: body.allowHumanTakeover,
                });
                return sendJson(response, 200, { ok: true, data: { roomId: room.roomId } });
            }
            const transferMatch = /^\/agent-room-api\/rooms\/([^/]+)\/transfer$/.exec(path);
            if (method === "POST" && transferMatch) {
                const body = (await readJson(request));
                if (!body.toAgentId)
                    return sendJson(response, 400, { ok: false, error: "toAgentId is required" });
                await service.gateway.transferController(decodeURIComponent(transferMatch[1]), body.toAgentId);
                return sendJson(response, 200, { ok: true });
            }
            const reviewMatch = /^\/agent-room-api\/rooms\/([^/]+)\/applications\/([^/]+)\/review$/.exec(path);
            if (method === "POST" && reviewMatch) {
                return sendJson(response, 410, { ok: false, error: "申请入房已移除" });
            }
            const createTaskMatch = /^\/agent-room-api\/rooms\/([^/]+)\/tasks$/.exec(path);
            if (method === "POST" && createTaskMatch) {
                const body = (await readJson(request));
                if (!body.title)
                    return sendJson(response, 400, { ok: false, error: "title is required" });
                const task = await service.gateway.taskCreate(decodeURIComponent(createTaskMatch[1]), {
                    title: body.title,
                    description: body.description,
                    assignee: body.assignee,
                    claimable: body.claimable,
                    requiredCapabilities: body.requiredCapabilities,
                    requiredRoles: body.requiredRoles,
                    acceptance: body.acceptance,
                    judgeMode: body.judgeMode === "auto" ? "auto" : "controller",
                });
                return sendJson(response, 200, { ok: true, data: { taskId: task.taskId, status: task.status } });
            }
            const taskAction = /^\/agent-room-api\/rooms\/([^/]+)\/tasks\/([^/]+)\/(assign|claim|comment|status|complete|handoff|approve|reject|reopen|remove)$/.exec(path);
            if (method === "POST" && taskAction) {
                const roomId = decodeURIComponent(taskAction[1]);
                const taskId = decodeURIComponent(taskAction[2]);
                const action = taskAction[3];
                const body = (await readJson(request));
                switch (action) {
                    case "assign":
                        await service.gateway.taskAssign(roomId, taskId, String(body.assignee ?? ""));
                        break;
                    case "claim":
                        await service.gateway.taskClaim(roomId, taskId);
                        break;
                    case "comment":
                        await service.gateway.taskComment(roomId, taskId, String(body.text ?? ""));
                        break;
                    case "status":
                        await service.gateway.taskStatus(roomId, taskId, body.status === "doing" ? "doing" : "todo");
                        break;
                    case "complete":
                        await service.gateway.taskComplete(roomId, taskId, body.note ? String(body.note) : undefined);
                        break;
                    case "handoff":
                        await service.gateway.taskHandoff(roomId, taskId, {
                            done: String(body.done ?? ""),
                            basis: body.basis ? String(body.basis) : undefined,
                            next: String(body.next ?? ""),
                            risk: body.risk ? String(body.risk) : undefined,
                        });
                        break;
                    case "approve":
                        await service.gateway.taskApprove(roomId, taskId, body.note ? String(body.note) : undefined);
                        break;
                    case "reject":
                        await service.gateway.taskReject(roomId, taskId, body.note ? String(body.note) : undefined);
                        break;
                    case "reopen":
                        await service.gateway.taskReopen(roomId, taskId);
                        break;
                    case "remove":
                        await service.gateway.taskDelete(roomId, taskId);
                        break;
                }
                return sendJson(response, 200, { ok: true });
            }
            const memberRolesMatch = /^\/agent-room-api\/rooms\/([^/]+)\/member-roles$/.exec(path);
            if (method === "POST" && memberRolesMatch) {
                const body = (await readJson(request));
                await service.gateway.setMemberRoles(decodeURIComponent(memberRolesMatch[1]), body.roles ?? []);
                return sendJson(response, 200, { ok: true });
            }
            const assignRolesMatch = /^\/agent-room-api\/rooms\/([^/]+)\/members\/([^/]+)\/roles$/.exec(path);
            if (method === "POST" && assignRolesMatch) {
                const body = (await readJson(request));
                await service.gateway.assignMemberRoles(decodeURIComponent(assignRolesMatch[1]), decodeURIComponent(assignRolesMatch[2]), body.roles ?? []);
                return sendJson(response, 200, { ok: true });
            }
            const memberCapsMatch = /^\/agent-room-api\/rooms\/([^/]+)\/member-capabilities$/.exec(path);
            if (method === "POST" && memberCapsMatch) {
                const body = (await readJson(request));
                await service.gateway.setMemberCapabilities(decodeURIComponent(memberCapsMatch[1]), body.capabilities ?? []);
                return sendJson(response, 200, { ok: true });
            }
            return sendJson(response, 404, { ok: false, error: "not-found" });
        }
        catch (error) {
            return sendJson(response, 500, { ok: false, error: error instanceof Error ? error.message : String(error) });
        }
    };
}
export const webPlugin = {
    name,
    inject,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    apply(ctx) {
        ctx.effect(() => ctx.webServer.register({ kind: "prefix", path: "/agent-room-api", handler: createRouter(ctx.agentRoom) }), "agent-room: browser api");
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
        if (bytes > MAX_BODY)
            throw new Error("request body is too large");
        chunks.push(buffer);
    }
    if (chunks.length === 0)
        return {};
    try {
        return JSON.parse(Buffer.concat(chunks).toString("utf8"));
    }
    catch {
        throw new Error("request body must be valid JSON");
    }
}
