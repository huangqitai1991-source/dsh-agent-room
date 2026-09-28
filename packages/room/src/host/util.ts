/** Small crypto/format helpers used across the plugin. */

import { createHmac, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

/** RFC 9562 UUIDv7 (time-ordered). */
export function uuidv7(): string {
  const b = randomBytes(16);
  const t = BigInt(Date.now());
  b.writeUInt32BE(Number(t >> 16n), 0);
  b.writeUInt16BE(Number(t & 0xffffn), 4);
  b[6] = (b[6]! & 0x0f) | 0x70;
  b[8] = (b[8]! & 0x3f) | 0x80;
  const hex = b.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Random session token (256-bit hex). */
export function randomToken(): string {
  return randomBytes(32).toString("hex");
}

export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const derived = scryptSync(password, salt, 32);
  return `scrypt$${salt.toString("base64")}$${derived.toString("base64")}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const [scheme, saltB64, hashB64] = stored.split("$");
  if (scheme !== "scrypt" || !saltB64 || !hashB64) return false;
  const salt = Buffer.from(saltB64, "base64");
  const expected = Buffer.from(hashB64, "base64");
  const derived = scryptSync(password, salt, expected.length);
  return derived.length === expected.length && timingSafeEqual(derived, expected);
}

export function nowIso(): string {
  return new Date().toISOString();
}

/** Base64url-encode a UTF-8 string (RFC 4648 §5, unpadded). */
export function base64url(text: string): string {
  return Buffer.from(text, "utf8").toString("base64url");
}

/** HMAC-SHA256 of `message` keyed by `secret`, hex-encoded. */
export function hmacSha256Hex(secret: string, message: string): string {
  return createHmac("sha256", secret).update(message).digest("hex");
}

export interface RelayTicketPayload {
  roomId: string;
  agentId: string;
  role: string;
  exp: number;
}

/** Sign a relay ticket: `<base64url(json)>.<hmac-hex>`. */
export function signRelayTicket(secret: string, payload: RelayTicketPayload): string {
  const body = base64url(JSON.stringify(payload));
  return `${body}.${hmacSha256Hex(secret, body)}`;
}

/** Verify a relay ticket; returns the payload, or null when malformed/expired/bad-signature. */
export function verifyRelayTicket(secret: string, ticket: unknown): RelayTicketPayload | null {
  if (typeof ticket !== "string") return null;
  const dot = ticket.lastIndexOf(".");
  if (dot <= 0 || dot === ticket.length - 1) return null;
  const body = ticket.slice(0, dot);
  const sig = ticket.slice(dot + 1);
  const expected = hmacSha256Hex(secret, body);
  const a = Buffer.from(expected, "hex");
  const b = Buffer.from(sig, "hex");
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  let payload: unknown;
  try {
    payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (payload === null || typeof payload !== "object") return null;
  const p = payload as Record<string, unknown>;
  if (typeof p.exp === "number" && p.exp < Math.floor(Date.now() / 1000)) return null;
  return p as unknown as RelayTicketPayload;
}
