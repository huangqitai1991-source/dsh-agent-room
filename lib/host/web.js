/**
 * dsh-agent-room — browser API routes under /agent-room-api.
 *
 * The web client (RoomDock) polls GET /agent-room-api/state and posts actions
 * here. The host forwards owned-room operations to RoomService (authoritative)
 * and joined-room operations to the matching RoomClient.
 */
import { IdentityNotReadyError, InvalidNicknameError } from "./safety.js";
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
            // Server-sent events: real-time push for the room dock (polling fallback stays).
            if (method === "GET" && path === "/agent-room-api/events") {
                return streamEvents(service, response);
            }
            if (method === "GET" && path === "/agent-room-api/relay-config") {
                return sendJson(response, 200, { ok: true, data: service.getRelayConfig() });
            }
            if (method === "POST" && path === "/agent-room-api/relay-config") {
                const body = (await readJson(request));
                const relay = await service.setRelayConfig(body.relay);
                return sendJson(response, 200, { ok: true, data: { relay: relay ?? null } });
            }
            // One-click 中继 ⇄ 局域网 switch: relay-config plus a re-join of every
            // joined room in one server-side step (a half-applied switch strands rooms
            // on mixed transports and the node flaps).
            if (method === "POST" && path === "/agent-room-api/mode") {
                const body = (await readJson(request));
                if (body.mode !== "lan" && body.mode !== "relay") {
                    return sendJson(response, 400, { ok: false, error: "mode must be \"lan\" or \"relay\"" });
                }
                const data = await service.setConnectionMode(body.mode, body.address);
                return sendJson(response, 200, { ok: true, data });
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
                const roomId = decodeURIComponent(leaveMatch[1]);
                try {
                    await service.gateway.leaveRoom(roomId);
                    return sendJson(response, 200, { ok: true });
                }
                catch (err) {
                    // Leaving is LOCAL cleanup. The owner may be unreachable or the room may
                    // have been deleted long ago (HTTP 500 blocked exactly that cleanup),
                    // so surface the reason but never pretend the local record survived.
                    console.error(`[agent-room] leave ${roomId} failed: ${err.message}`);
                    return sendJson(response, 200, { ok: true, local: true, warn: err.message });
                }
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
            const revokeMatch = /^\/agent-room-api\/rooms\/([^/]+)\/members\/([^/]+)\/revoke$/.exec(path);
            if (method === "POST" && revokeMatch) {
                const body = (await readJson(request));
                try {
                    await service.gateway.revokeMember(decodeURIComponent(revokeMatch[1]), decodeURIComponent(revokeMatch[2]), body.reason);
                    return sendJson(response, 200, { ok: true });
                }
                catch (err) {
                    return sendJson(response, 400, { ok: false, error: err.message });
                }
            }
            const unrevokeMatch = /^\/agent-room-api\/rooms\/([^/]+)\/members\/([^/]+)\/unrevoke$/.exec(path);
            if (method === "POST" && unrevokeMatch) {
                try {
                    await service.gateway.unrevokeMember(decodeURIComponent(unrevokeMatch[1]), decodeURIComponent(unrevokeMatch[2]));
                    return sendJson(response, 200, { ok: true });
                }
                catch (err) {
                    return sendJson(response, 400, { ok: false, error: err.message });
                }
            }
            // 激活聊天 (one-shot): mark the room thinking and ask the local agent to
            // reply once via room_send; 409 while a previous thinking is still in flight.
            const activateChatMatch = /^\/agent-room-api\/rooms\/([^/]+)\/activate-chat$/.exec(path);
            if (method === "POST" && activateChatMatch) {
                const roomId = decodeURIComponent(activateChatMatch[1]);
                if (service.isActivateThinking(roomId)) {
                    console.error("[agent-room] activate-chat: 409 for " + roomId + " — already thinking");
                    return sendJson(response, 409, { ok: false, error: "该房间正在思考中，请等待回复完成" });
                }
                try {
                    const result = await service.activateChat(roomId);
                    console.error("[agent-room] activate-chat: accepted for " + roomId + " (agent=" + (result?.agentId ?? "unknown") + ") — thinking=true");
                    return sendJson(response, 200, { ok: true, data: { thinking: true } });
                }
                catch (error) {
                    const message = error instanceof Error ? error.message : String(error);
                    console.error("[agent-room] activate-chat: rejected for " + roomId + " — " + message);
                    return sendJson(response, 500, { ok: false, error: message });
                }
            }
            const activateStateMatch = /^\/agent-room-api\/rooms\/([^/]+)\/activate-state$/.exec(path);
            if (method === "GET" && activateStateMatch) {
                return sendJson(response, 200, { ok: true, data: { thinking: service.isActivateThinking(decodeURIComponent(activateStateMatch[1])) } });
            }
            // 监听 (listening): the local agent watches the room and wakes itself
            // when a message needs it (rule layer + prompt; see sweepListening).
            const listeningMatch = /^\/agent-room-api\/rooms\/([^/]+)\/listening$/.exec(path);
            if (method === "POST" && listeningMatch) {
                const body = (await readJson(request));
                service.setListening(decodeURIComponent(listeningMatch[1]), body.on === true);
                return sendJson(response, 200, { ok: true });
            }
            const chatMatch = /^\/agent-room-api\/rooms\/([^/]+)\/chat$/.exec(path);
            if (method === "POST" && chatMatch) {
                const roomId = decodeURIComponent(chatMatch[1]);
                const body = (await readJson(request));
                if (!body.text)
                    return sendJson(response, 400, { ok: false, error: "text is required" });
                const result = await service.gateway.sendChat(roomId, {
                    text: body.text,
                    mentions: body.mentions,
                    human: body.human,
                });
                // Joined rooms answer with a delivery status; owned rooms with the real
                // message. Report both instead of a bare `seq: null` that hid the drop.
                //
                // 0.1.35: `delivered` is kept as a DEPRECATED alias of
                // `acceptedByLocalHub` because dsh-agent-org 0.2.10 reads it; the honest
                // fields are the two new ones. `confirmedByOwner` is only true when the
                // owner echoed the message back with its own seq.
                //
                // 0.1.45: `woken` is the answer to the question those two fields could not
                // answer. On 2026-09-15 seq 3267 (the questionnaire) came back
                // `confirmedByOwner: true` and woke NOBODY on three of four machines, so
                // "delivered" was read as "acted on". `woken` is the rule's own count of room
                // members this post addresses (mention / controller / human fallback), and
                // `wake.note` says in one line that it is a prediction over this node's room
                // view, not a receipt. Backward compatible: nothing existing changed.
                const wake = service.gateway.wakePreview(roomId, {
                    text: body.text,
                    mentions: body.mentions,
                    human: body.human,
                });
                const wakeFields = { woken: wake.woken, wake };
                if (result && "delivered" in result) {
                    return sendJson(response, 200, {
                        ok: true,
                        data: {
                            seq: result.confirmedSeq ?? null,
                            acceptedByLocalHub: result.acceptedByLocalHub,
                            confirmedByOwner: result.confirmedByOwner,
                            confirmedSeq: result.confirmedSeq ?? null,
                            confirmNote: result.confirmNote,
                            delivered: result.delivered,
                            queued: result.queued,
                            reason: result.reason,
                            ...wakeFields,
                        },
                    });
                }
                return sendJson(response, 200, { ok: true, data: { seq: result?.seq ?? null, acceptedByLocalHub: true, delivered: true, confirmedByOwner: true, confirmNote: "owner-confirmed", ...wakeFields } });
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
                try {
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
                }
                catch (err) {
                    const message = err.message;
                    // Joined-room actions are fire-and-forget; a missing projected task just
                    // means the owner hasn't synced yet — treat as sent (the UI re-polls).
                    if (message.includes("任务操作已发送")) {
                        return sendJson(response, 200, { ok: true, data: { sent: true } });
                    }
                    throw err;
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
            // 0.1.40: the supported rename entry point (card-01). One call converges
            // identity.json, the room members' view (pushed immediately, not on the 15s
            // timer) and the agent-org node name; no restart.
            if (method === "POST" && path === "/agent-room-api/profile") {
                const body = (await readJson(request));
                try {
                    const data = await service.renameSelf(String(body.nickname ?? ""));
                    return sendJson(response, 200, { ok: true, data });
                }
                catch (error) {
                    // A name the node must not write is the CALLER's problem (400), and a
                    // node whose identity cache is not up yet is a state conflict (409).
                    // Neither is a 500: nothing here is broken, and nothing was changed.
                    if (error instanceof InvalidNicknameError) {
                        return sendJson(response, 400, { ok: false, error: error.message, reason: error.reason });
                    }
                    if (error instanceof IdentityNotReadyError) {
                        return sendJson(response, 409, { ok: false, error: error.message });
                    }
                    throw error;
                }
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
/** Keep an SSE stream open and forward browser events until the client disconnects. */
function streamEvents(service, response) {
    response.writeHead(200, {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-store",
        connection: "keep-alive",
    });
    response.write(": connected\n\n");
    const unsubscribe = service.onBrowserEvent((event) => {
        try {
            response.write(`event: ${event.kind}\ndata: ${JSON.stringify(event)}\n\n`);
        }
        catch {
            /* client gone */
        }
    });
    const heartbeat = setInterval(() => {
        try {
            response.write(`: ping ${Date.now()}\n\n`);
        }
        catch {
            /* client gone */
        }
    }, 15_000);
    const done = () => {
        clearInterval(heartbeat);
        unsubscribe();
    };
    response.on("close", done);
    response.on("error", done);
}
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
