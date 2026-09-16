import assert from "node:assert";
import { test } from "node:test";
const { OrgService } = await import("../src/host/service.js").catch(() => ({}));
test("reassertSyncRoom posts listening for the sync room, and reports a refusal honestly", async () => {
  const calls = [];
  globalThis.fetch = async (url, init) => { calls.push({ url, init }); return { ok: true, status: 200 }; };
  const svc = Object.create(OrgService.prototype);
  svc.config = { syncRoomId: "room-1", roomApiBase: "http://127.0.0.1:9999/" };
  const ok = await svc.reassertSyncRoom();
  assert.equal(ok.ok, true);
  assert.match(calls[0].url, /^http:\/\/127\.0\.0\.1:9999\/agent-room-api\/rooms\/room-1\/listening$/);
  assert.equal(JSON.parse(calls[0].init.body).on, true, "the repair is turning listening ON");
  globalThis.fetch = async () => { throw new Error("connect refused"); };
  const bad = await svc.reassertSyncRoom();
  assert.equal(bad.ok, false);
  assert.match(bad.reason, /connect refused/, "a failed repair must not look like a success");
  svc.config.syncRoomId = "";
  assert.equal((await svc.reassertSyncRoom()).reason, "no_sync_room");
});