/**
 * issue-license.mjs — 平台侧签发 license 的 CLI。
 * 用法:
 *   node issue-license.mjs --account usr_123 --seats 3 --days 60 --plan basic
 */
import { issueLicense } from "./license.mjs";

const args = Object.fromEntries(
  process.argv.slice(2).map((a, i, arr) => (a.startsWith("--") ? [a.slice(2), arr[i + 1] ?? "true"] : null)).filter(Boolean)
);
const accountId = args.account ?? process.env.LICENSE_ACCOUNT;
const seats = Number(args.seats ?? 3);
const days = Number(args.days ?? 60);
const plan = args.plan ?? "basic";

if (!accountId) {
  console.error("用法: node issue-license.mjs --account <账号ID> --seats <台数> --days <天数> [--plan <套餐名>]");
  process.exit(1);
}
const lic = issueLicense({ accountId, seats, durationDays: days, plan });
console.log("ACCOUNT: " + accountId);
console.log("SEATS:   " + seats);
console.log("DAYS:    " + days);
console.log("LICENSE: " + lic);
