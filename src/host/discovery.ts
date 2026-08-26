/**
 * dsh-agent-room — same-LAN room discovery.
 *
 * Room hosts broadcast a small UDP beacon (kind "agent-room.beacon") every few
 * seconds on DISCOVERY_PORT; every node with the plugin listens on that port
 * and collects beacons from all nearby hosts, so rooms show up by name without
 * typing an address — like LAN games. Beacons expire after a few missed ticks.
 */

import { createSocket, type Socket } from "node:dgram";
import { networkInterfaces } from "node:os";
import type { AgentIdentity } from "../types.js";
import { DISCOVERY_PORT, type RoomBeacon } from "./protocol.js";
import { hostCandidates } from "./peer-server.js";

/** A beacon plus when we last heard it. */
interface BeaconEntry {
  beacon: RoomBeacon;
  lastSeen: number;
}

export interface DiscoveryOptions {
  /** The room server port of this node (used to build beacon addresses). */
  serverPort: number;
  /** Current node identity, for beacon attribution. */
  node: () => AgentIdentity;
  /** Snapshot of rooms this node hosts that should be discoverable. */
  rooms: () => Array<{ roomId: string; title: string; authMode: "open" | "password"; memberCount: number; status: string }>;
}

const BEACON_INTERVAL_MS = 3_000;
const EXPIRE_TTL_MS = 15_000;
const SWEEP_INTERVAL_MS = 5_000;
/** Multicast group for discovery — forwarded by far more APs/routers than plain broadcast. */
const MULTICAST_GROUP = "239.255.0.1";

/** Subnet-directed broadcast addresses (e.g. 192.168.110.255) for each interface. */
function subnetBroadcastAddresses(): string[] {
  const out = new Set<string>();
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family !== "IPv4" || entry.internal || !entry.address || !entry.netmask) continue;
      const ip = entry.address.split(".").map(Number);
      const mask = entry.netmask.split(".").map(Number);
      out.add(ip.map((oct, i) => oct | (~mask[i]! & 0xff)).join("."));
    }
  }
  return [...out];
}

export class LanDiscovery {
  private readonly listener: Socket;
  private readonly sender: Socket;
  private readonly entries = new Map<string, BeaconEntry>();
  private senderTimer: NodeJS.Timeout | null = null;
  private sweepTimer: NodeJS.Timeout | null = null;
  private started = false;

  constructor(private readonly options: DiscoveryOptions) {
    this.listener = createSocket({ type: "udp4", reuseAddr: true });
    this.sender = createSocket({ type: "udp4" });
  }

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    this.listener.on("message", (msg) => this.handleBeacon(msg));
    this.listener.on("error", (err) => {
      this.options.node();
      console.warn(`[agent-room] discovery listener error: ${String(err)}`);
    });
    this.sender.on("error", (err) => {
      console.warn(`[agent-room] discovery sender error: ${String(err)}`);
    });
    await new Promise<void>((resolve) => {
      this.listener.bind(DISCOVERY_PORT, () => resolve());
    });
    // Join the multicast group on every real interface so beacons sent via
    // multicast are received even when plain broadcast is filtered by the AP.
    for (const entries of Object.values(networkInterfaces())) {
      for (const entry of entries ?? []) {
        if (entry.family === "IPv4" && !entry.internal && entry.address) {
          try {
            this.listener.addMembership(MULTICAST_GROUP, entry.address);
          } catch { /* interface may not support multicast */ }
        }
      }
    }
    try { this.sender.setMulticastTTL(1); } catch { /* non-fatal */ }
    this.senderTimer = setInterval(() => this.broadcast(), BEACON_INTERVAL_MS);
    this.sweepTimer = setInterval(() => this.sweep(), SWEEP_INTERVAL_MS);
    // Immediate first broadcast so rooms appear quickly.
    this.broadcast();
  }

  stop(): void {
    if (!this.started) return;
    this.started = false;
    if (this.senderTimer) clearInterval(this.senderTimer);
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    this.senderTimer = null;
    this.sweepTimer = null;
    try { this.listener.close(); } catch { /* already closed */ }
    try { this.sender.close(); } catch { /* already closed */ }
    this.entries.clear();
  }

  /** Currently visible remote rooms, newest first. */
  discovered(): RoomBeacon[] {
    const now = Date.now();
    return [...this.entries.values()]
      .filter((entry) => now - entry.lastSeen <= EXPIRE_TTL_MS)
      .map((entry) => entry.beacon)
      .sort((a, b) => b.ts - a.ts);
  }

  private broadcast(): void {
    const identity = this.options.node();
    const addresses = hostCandidates(this.options.serverPort);
    for (const room of this.options.rooms()) {
      if (room.status !== "open") continue;
      const beacon: RoomBeacon = {
        kind: "agent-room.beacon",
        v: 2,
        nodeId: identity.agentId,
        nickname: identity.nickname,
        roomId: room.roomId,
        title: room.title,
        authMode: room.authMode,
        memberCount: room.memberCount,
        addresses,
        ts: Date.now(),
      };
      const payload = Buffer.from(JSON.stringify(beacon));
      const targets = new Set<string>(["255.255.255.255", MULTICAST_GROUP, ...subnetBroadcastAddresses()]);
      for (const target of targets) {
        try {
          this.sender.send(payload, DISCOVERY_PORT, target);
        } catch { /* non-fatal */ }
      }
    }
  }

  private handleBeacon(msg: Buffer): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(msg.toString("utf8"));
    } catch {
      return;
    }
    const raw = parsed as Record<string, unknown>;
    if (raw?.kind !== "agent-room.beacon") return;
    // Normalize v1 (single `address`) and v2 (addresses array) beacons.
    const v1 = raw as { v: number; nodeId?: string; nickname?: string; roomId?: string; title?: string; authMode?: string; memberCount?: number; address?: string; ts?: number };
    const addresses = Array.isArray(raw.addresses) && (raw.addresses as unknown[]).length > 0
      ? (raw.addresses as string[])
      : typeof v1.address === "string" ? [v1.address] : [];
    if (!v1.nodeId || !v1.roomId || addresses.length === 0) return;
    const beacon: RoomBeacon = {
      kind: "agent-room.beacon",
      v: 2,
      nodeId: v1.nodeId,
      nickname: typeof v1.nickname === "string" ? v1.nickname : v1.nodeId,
      roomId: v1.roomId,
      title: typeof v1.title === "string" ? v1.title : v1.roomId,
      authMode: v1.authMode === "password" ? "password" : "open",
      memberCount: typeof v1.memberCount === "number" ? v1.memberCount : 0,
      addresses,
      ts: typeof v1.ts === "number" ? v1.ts : Date.now(),
    };
    // Ignore our own beacons (loopback of the broadcast).
    if (beacon.nodeId === this.options.node().agentId) return;
    this.entries.set(`${beacon.nodeId}/${beacon.roomId}`, { beacon, lastSeen: Date.now() });
  }

  private sweep(): void {
    const now = Date.now();
    for (const [key, entry] of this.entries) {
      if (now - entry.lastSeen > EXPIRE_TTL_MS) this.entries.delete(key);
    }
  }
}
