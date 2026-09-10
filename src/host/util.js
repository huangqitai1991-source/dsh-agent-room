/**
 * Small shared utilities.
 */
import { randomUUID } from "node:crypto";

export function uuid() {
  return randomUUID();
}

export function nowIso() {
  return new Date().toISOString();
}
