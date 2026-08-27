/**
 * dsh-agent-org — root Cordis plugin.
 *
 * Composes the OrgService, browser API, and tools. Depends on dsh-agent-room
 * through the injected `ctx.agentRoom` service.
 */

import { OrgService, resolveConfig } from "./service.js";
import { webPlugin } from "./web.js";
import * as toolsPlugin from "../tools/index.js";

export const name = "dsh-agent-org";
export const inject = ["agentRoom"];

export function apply(ctx, config = {}) {
  const resolved = resolveConfig(config);
  ctx.plugin(OrgService, resolved);
  ctx.plugin(webPlugin);
  if (resolved.tools) ctx.plugin(toolsPlugin);
}

export { OrgService, resolveConfig };
