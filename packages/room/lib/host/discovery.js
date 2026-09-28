/**
 * dsh-agent-room — same-LAN room discovery.
 *
 * Room hosts broadcast a small UDP beacon (kind "agent-room.beacon") every few
 * seconds on DISCOVERY_PORT; every node with the plugin listens on that port
 * and collects beacons from all nearby hosts, so rooms show up by name without
 * typing an address — like LAN games. Beacons expire after a few missed ticks.
 */
import { createSocket } from "node:dgram";
import { networkInterfaces } from "node:os";
import { DISCOVERY_PORT } from "./protocol.js";
import { hostCandidates } from "./peer-server.js";
const BEACON_INTERVAL_MS = 3_000;
const EXPIRE_TTL_MS = 15_000;
const SWEEP_INTERVAL_MS = 5_000;
/** Multicast group for discovery — forwarded by far more APs/routers than plain broadcast. */
const MULTICAST_GROUP = "239.255.0.1";
/** Subnet-directed broadcast addresses (e.g. 192.168.110.255) for each interface. */
function subnetBroadcastAddresses() {
    const out = new Set();
    for (const entries of Object.values(networkInterfaces())) {
        for (const entry of entries ?? []) {
            if (entry.family !== "IPv4" || entry.internal || !entry.address || !entry.netmask)
                continue;
            const ip = entry.address.split(".").map(Number);
            const mask = entry.netmask.split(".").map(Number);
            out.add(ip.map((oct, i) => oct | (~mask[i] & 0xff)).join("."));
        }
    }
    return [...out];
}
export class LanDiscovery {
    options;
    listener;
    sender;
    entries = new Map();
    senderTimer = null;
    sweepTimer = null;
    started = false;
    constructor(options) {
        this.options = options;
        this.listener = createSocket({ type: "udp4", reuseAddr: true });
        this.sender = createSocket({ type: "udp4" });
    }
    async start() {
        if (this.started)
            return;
        this.started = true;
        this.listener.on("message", (msg) => this.handleBeacon(msg));
        this.listener.on("error", (err) => {
            this.options.node();
            console.warn(`[agent-room] discovery listener error: ${String(err)}`);
        });
        this.sender.on("error", (err) => {
            console.warn(`[agent-room] discovery sender error: ${String(err)}`);
        });
        await new Promise((resolve) => {
            this.listener.bind(DISCOVERY_PORT, () => resolve());
        });
        // Join the multicast group on every real interface so beacons sent via
        // multicast are received even when plain broadcast is filtered by the AP.
        for (const entries of Object.values(networkInterfaces())) {
            for (const entry of entries ?? []) {
                if (entry.family === "IPv4" && !entry.internal && entry.address) {
                    try {
                        this.listener.addMembership(MULTICAST_GROUP, entry.address);
                    }
                    catch { /* interface may not support multicast */ }
                }
            }
        }
        try {
            this.sender.setMulticastTTL(1);
        }
        catch { /* non-fatal */ }
        this.senderTimer = setInterval(() => this.broadcast(), BEACON_INTERVAL_MS);
        this.sweepTimer = setInterval(() => this.sweep(), SWEEP_INTERVAL_MS);
        // Immediate first broadcast so rooms appear quickly.
        this.broadcast();
    }
    stop() {
        if (!this.started)
            return;
        this.started = false;
        if (this.senderTimer)
            clearInterval(this.senderTimer);
        if (this.sweepTimer)
            clearInterval(this.sweepTimer);
        this.senderTimer = null;
        this.sweepTimer = null;
        try {
            this.listener.close();
        }
        catch { /* already closed */ }
        try {
            this.sender.close();
        }
        catch { /* already closed */ }
        this.entries.clear();
    }
    /** Currently visible remote rooms, newest first. */
    discovered() {
        const now = Date.now();
        return [...this.entries.values()]
            .filter((entry) => now - entry.lastSeen <= EXPIRE_TTL_MS)
            .map((entry) => entry.beacon)
            .sort((a, b) => b.ts - a.ts);
    }
    broadcast() {
        const identity = this.options.node();
        const addresses = hostCandidates(this.options.serverPort);
        for (const room of this.options.rooms()) {
            if (room.status !== "open")
                continue;
            const beacon = {
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
            const targets = new Set(["255.255.255.255", MULTICAST_GROUP, ...subnetBroadcastAddresses()]);
            for (const target of targets) {
                try {
                    this.sender.send(payload, DISCOVERY_PORT, target);
                }
                catch { /* non-fatal */ }
            }
        }
    }
    handleBeacon(msg) {
        let parsed;
        try {
            parsed = JSON.parse(msg.toString("utf8"));
        }
        catch {
            return;
        }
        const raw = parsed;
        if (raw?.kind !== "agent-room.beacon")
            return;
        // Normalize v1 (single `address`) and v2 (addresses array) beacons.
        const v1 = raw;
        const addresses = Array.isArray(raw.addresses) && raw.addresses.length > 0
            ? raw.addresses
            : typeof v1.address === "string" ? [v1.address] : [];
        if (!v1.nodeId || !v1.roomId || addresses.length === 0)
            return;
        const beacon = {
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
        if (beacon.nodeId === this.options.node().agentId)
            return;
        this.entries.set(`${beacon.nodeId}/${beacon.roomId}`, { beacon, lastSeen: Date.now() });
    }
    sweep() {
        const now = Date.now();
        for (const [key, entry] of this.entries) {
            if (now - entry.lastSeen > EXPIRE_TTL_MS)
                this.entries.delete(key);
        }
    }
}
