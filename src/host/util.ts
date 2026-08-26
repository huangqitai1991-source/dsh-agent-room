/** Small crypto/format helpers used across the plugin. */

import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

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
