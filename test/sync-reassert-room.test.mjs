import assert from "node:assert";
import { test } from "node:test";
import { reassertRequest } from "../src/host/sync-health.js";

test("the repair request targets the sync room's listening switch, and turns it ON", () => {
  const req = reassertRequest({ roomId: "room-1", base: "http://127.0.0.1:9999/" });
  assert.equal(req.url, "http://127.0.0.1:9999/agent-room-api/rooms/room-1/listening", "trailing slashes must not double up");
  assert.equal(req.init.method, "POST");
  assert.equal(JSON.parse(req.init.body).on, true, "the repair is turning listening ON, never off");
  assert.equal(reassertRequest({ roomId: "r" }).url, "http://127.0.0.1:3080/agent-room-api/rooms/r/listening", "the default base is the local host");
});