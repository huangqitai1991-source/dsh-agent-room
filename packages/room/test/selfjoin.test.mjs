/**
 * dsh-agent-room 0.1.37 — self-join address classification (P0 regression).
 *
 * 0.1.36 added the live self-join refusal in `AgentRoomService.gateway.joinRoom`
 * (the half of the 0.1.34 fix that `recordJoinedRecord` could not do: that one ran
 * after the handshake and left the socket open, and a node holding a member socket
 * on a room it also serves re-received every frame it broadcast — ONE send produced
 * 3638 deliveries in 195 ms).
 *
 * The intent is right and stays. What broke is the PREDICATE: the address check
 * asked `ownAddresses()`, and `ownAddresses()` built itself from `lanCandidates()`
 * — the JOIN-CANDIDATE helper, which merges the manual address and every address
 * seen in LAN BEACONS, i.e. OTHER NODES' addresses. So every remote owner whose
 * beacon this node had ever discovered was classified as "this machine" and the
 * join was refused:
 *
 *   {"ok":false,"error":"不能通过本机自己的地址加入房间（self-join）: 192.168.31.82:9317"}
 *
 * …where 192.168.31.82:9317 is the OWNER (小婷), advertised by its own beacon,
 * while the caller's interfaces were only 100.64.44.107 / 172.19.208.1 /
 * 192.168.137.1 / 192.168.31.204 / 127.0.0.1. The member was locked out of the
 * room: it could not read messages and its sends failed with 房间不存在.
 *
 * Everything here runs on 127.0.0.1 with fakes; no DSH service is started,
 * stopped or contacted.
 */

import assert from "node:assert";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Context } from "@deepseek-ai/cordis";
import { AgentRoomService, normaliseAddress } from "../lib/host/service.js";
import { RoomService } from "../lib/host/room-service.js";
import { PeerServer } from "../lib/host/peer-server.js";

const OWNER_PORT = 19481;
const MEMBER_PORT = 19482;

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (fn, timeout = 8_000, step = 25) => {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (await fn()) return true;
    await wait(step);
  }
  return false;
};

/** A member node whose `discovery` is a fake returning exactly one beacon — the
 *  shape a real LAN beacon has (`addresses: ["<owner host:port>"]`). */
const fakeBeacon = (beacon) => ({ discovered: () => (beacon ? [beacon] : []) });

/**
 * Failure counter, and tests declared through `guarded` below.
 *
 * node:test only writes `process.exitCode` once a file's run COMPLETES for real.
 * A failure on the buggy path leaves AgentRoomService's bounded rejoin retries
 * pending (their timers are not unref'd), the loop stays alive, and the run never
 * completes — so the exit code would stay 0 for a FAILING regression test. This
 * counter is the source of truth the watchdog below exits with.
 */
let failures = 0;
const guarded = (name, fn) =>
  test(name, async (t) => {
    try {
      await fn(t);
    } catch (error) {
      failures += 1;
      throw error;
    }
  });

/**
 * `AgentRoomService` boots itself fire-and-forget from its constructor
 * (`ctx.effect(() => void this.boot())`, service.ts:223-232), and boot() installs
 * its own discovery + timers last. Every test here waits for that to settle, or
 * it would race both the fake discovery below and the joined.json it seeds.
 */
async function settled(svc) {
  const ok = await waitFor(() => svc.profileTimer != null && svc.listenTimer != null, 8_000);
  assert.ok(ok, "the service's background boot must settle before the test touches it");
  return svc;
}

/** Tear an AgentRoomService down the way DSH's disposer would. `orphans` holds
 *  anything the test replaced on the instance (the real LanDiscovery, whose two
 *  UDP sockets would otherwise keep this process alive forever). */
async function shutdown(svc, orphans = []) {
  if (!svc) return;
  for (const client of svc.clients?.values?.() ?? []) {
    try { client.destroy(); } catch { /* ignore */ }
  }
  for (const orphan of [...orphans, svc.discovery]) {
    try { orphan?.stop?.(); } catch { /* ignore */ }
  }
  try { await svc.peerServer?.stop(); } catch { /* ignore */ }
  for (const timer of [svc.profileTimer, svc.listenTimer]) {
    try { if (timer) clearInterval(timer); } catch { /* ignore */ }
  }
}

guarded("joining the room OWNER by its beacon address succeeds even with a local joined record (0.1.37)", async (t) => {
  const dirs = [];
  const mk = async (tag) => {
    const d = await mkdtemp(join(tmpdir(), `ar-selfjoin-${tag}-`));
    dirs.push(d);
    return d;
  };
  const servers = [];
  const orphans = [];
  let svc = null;
  try {
    // ---- the remote OWNER (小婷): an ordinary node serving the room ----
    const ownerService = new RoomService({ dataDir: await mk("owner") });
    await ownerService.boot();
    const ownerServer = new PeerServer({ port: OWNER_PORT, service: ownerService, relay: "" });
    servers.push(ownerServer);
    await ownerServer.start();
    const ownerIdentity = await ownerService.ensureIdentity();
    const room = await ownerService.createRoom({ title: "远端房间", type: "persistent" });
    const ownerAddress = `127.0.0.1:${OWNER_PORT}`;

    // The beacon the owner broadcasts on the LAN: it advertises the OWNER's own
    // address. This is the field beacon verbatim, only the address differs.
    const beacon = {
      kind: "agent-room.beacon",
      nodeId: ownerIdentity.agentId,
      roomId: room.roomId,
      addresses: [ownerAddress],
    };

    // ---- the MEMBER (主控): a different port, so none of this node's own
    //      interfaces can ever be the owner's address ----
    const memberDir = await mk("member");
    // A local joined record for that room ALREADY EXISTS before the node starts —
    // the state the lockout report suspected was the trigger (joined.json).
    const seed = new RoomService({ dataDir: memberDir, onNeedServer: undefined });
    await seed.boot();
    await seed.recordVisited(room.roomId, ownerAddress, room.title);

    svc = await settled(
      new AgentRoomService(new Context(), { dataDir: memberDir, port: MEMBER_PORT, relay: "" }),
    );
    assert.ok(
      svc.roomService.listJoinedRooms().some((r) => r.roomId === room.roomId),
      "precondition: a local joined record for the remote room exists",
    );
    // Replace the real LanDiscovery with the owner's beacon. This is the ONLY
    // difference from the field: the address is loopback instead of 192.168.31.82.
    // Keep the real one: its UDP sockets must be closed at teardown or this
    // process would never exit.
    const realDiscovery = svc.discovery;
    orphans.push(realDiscovery);
    svc.discovery = fakeBeacon(beacon);

    // 1) Join the remote room by the owner's address. Before 0.1.37 this rejected
    //    with 不能通过本机自己的地址加入房间（self-join）: <owner address> because
    //    the beacon address had been folded into this node's "own addresses".
    await svc.gateway.joinRoom([ownerAddress], { roomId: room.roomId });
    assert.ok(
      await waitFor(() => svc.clients.get(room.roomId)?.connected === true),
      "the join must leave a LIVE client on the remote room",
    );
    assert.ok(
      svc.roomService.listJoinedRooms().some((r) => r.roomId === room.roomId),
      "the remote room must stay recorded in joined.json (not pruned as a self-join)",
    );

    // The predicate itself, named explicitly so a re-break is unambiguous: a remote
    // owner's beacon address must NEVER be listed as "ours".
    const own = [...svc.ownAddresses()];
    assert.ok(
      !own.includes(normaliseAddress(ownerAddress)),
      `the owner's beacon address ${ownerAddress} must not be classified as this node's own (ownAddresses=${own.join(", ")})`,
    );

    // 2) The record now exists on disk AND in memory; re-join with the beacon
    //    gone, so the only possible source of a false self-collision is the local
    //    record — the second half of the reported hypothesis.
    svc.discovery = fakeBeacon(null);
    await svc.gateway.joinRoom([ownerAddress], { roomId: room.roomId });
    assert.ok(
      await waitFor(() => svc.clients.get(room.roomId)?.connected === true),
      "a re-join of a remote room must succeed even when a local record exists",
    );

    // 3) It really is a member of the OWNER's room, and can read it.
    assert.ok(ownerService.getOwnedRoom(room.roomId), "the owner still serves the room");
    const info = await svc.gateway.roomInfo(room.roomId);
    assert.strictEqual(info.owned, false, "the member must see this as a joined (not owned) room");
    assert.strictEqual(info.room.roomId, room.roomId);
  } finally {
    await shutdown(svc, orphans);
    for (const s of servers) { try { await s.stop(); } catch { /* ignore */ } }
    for (const d of dirs) { try { await rm(d, { recursive: true, force: true }); } catch { /* ignore */ } }
  }
});

guarded("a live self-join on a room this node OWNS is still refused (0.1.36 protection kept)", async (t) => {
  const dirs = [];
  const mk = async (tag) => {
    const d = await mkdtemp(join(tmpdir(), `ar-selfown-${tag}-`));
    dirs.push(d);
    return d;
  };
  let svc = null;
  try {
    svc = await settled(
      new AgentRoomService(new Context(), { dataDir: await mk("node"), port: MEMBER_PORT + 10, relay: "" }),
    );

    // Creating a room starts this node's own PeerServer (onNeedServer), so the
    // room is served AND reachable at our own address — the exact topology that
    // produced the 3638-delivery loop.
    const owned = await svc.gateway.createRoom({ title: "自己的房间", type: "persistent" });
    assert.ok(svc.roomService.getOwnedRoom(owned.roomId), "precondition: this node owns the room");

    await assert.rejects(
      () => svc.gateway.joinRoom([`127.0.0.1:${MEMBER_PORT + 10}`], { roomId: owned.roomId }),
      (error) => {
        assert.match(String(error.message), /self-join/, "the refusal must name the self-join");
        assert.match(
          String(error.message),
          /不能加入本机自己托管的房间/,
          `a live self-join on an OWNED room must be refused by the room-ownership check, got: ${error.message}`,
        );
        return true;
      },
    );
    assert.strictEqual(
      svc.clients.get(owned.roomId),
      undefined,
      "the refused client must not be registered on the service",
    );
  } finally {
    await shutdown(svc);
    for (const d of dirs) { try { await rm(d, { recursive: true, force: true }); } catch { /* ignore */ } }
  }
});

/**
 * AgentRoomService is meant to live inside DSH, which disposes it; a bare test
 * process has no disposer. If anything it started (a stray reconnect/retry timer)
 * is still holding the event loop, this watchdog ends the process after every
 * assertion has already run — unref'd, so a clean run still exits on its own and
 * reports normally.
 */
const watchdog = setTimeout(() => process.exit(failures > 0 ? 1 : 0), 8_000);
watchdog.unref();
