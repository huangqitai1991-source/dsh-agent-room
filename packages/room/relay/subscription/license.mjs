/**
 * license.mjs — 中继订阅的 license 签发与校验（席位 × 时长）。
 *
 * license 结构: base64url(payload).hmacHex
 *   payload = { accountId, seats, plan, iat, exp, lic }
 * - 平台侧: issueLicense() 签发（账号、席位上限、时长天数）。
 * - 中继侧: verifyLicense() 离线校验签名 + 到期（无需查数据库，保持哑管道）。
 * - 席位计数放中继内存（本文件只负责签发/校验，不计数）。
 */
import { createHmac, timingSafeEqual, randomBytes } from "node:crypto";

// 平台主密钥：生产必须从环境变量注入，绝不硬编码。
const SECRET = process.env.LICENSE_SECRET ?? "dev-insecure-secret-change-me";

const b64url = (buf) => Buffer.from(buf).toString("base64url");
const sign = (body) => createHmac("sha256", SECRET).update(body).digest("hex");

/** 平台签发 license（账号、席位上限、时长天数）。返回 license 字符串。 */
export function issueLicense({ accountId, seats = 3, durationDays = 60, plan = "basic" }) {
  if (!accountId) throw new Error("accountId required");
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    accountId,
    seats: Math.max(1, Number(seats) || 1),
    plan,
    iat: now,
    exp: now + Math.max(1, Number(durationDays) || 1) * 86400,
    lic: randomBytes(6).toString("hex"), // license 唯一标识，用于席位计数
  };
  const body = b64url(JSON.stringify(payload));
  return body + "." + sign(body);
}

/** 校验 license 签名与到期。返回 { payload, expired }；无效返回 null。 */
export function verifyLicense(token) {
  if (typeof token !== "string" || !token) return null;
  const dot = token.lastIndexOf(".");
  if (dot <= 0 || dot === token.length - 1) return null;
  const body = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const a = Buffer.from(sign(body), "hex");
  const b = Buffer.from(sig, "hex");
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  let p;
  try {
    p = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (!p || typeof p !== "object" || typeof p.exp !== "number") return null;
  return { payload: p, expired: p.exp < Math.floor(Date.now() / 1000) };
}
