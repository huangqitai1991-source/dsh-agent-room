/**
 * dsh-agent-room — root Cordis plugin.
 *
 * Composes the service, browser API, tools, and bundled skill into one DSH
 * bundle (mirrors the dsh-univer-office plugin shape).
 */

import type { Context } from "@deepseek-ai/cordis";
import { AgentRoomService, resolveConfig, type AgentRoomConfig } from "./service.js";
import { webPlugin } from "./web.js";
import * as toolsPlugin from "../tools/index.js";
import * as skillsPlugin from "./skills.js";

export const name = "dsh-agent-room";

export function apply(ctx: Context, config: AgentRoomConfig = {}): void {
  const resolved = resolveConfig(config);
  ctx.plugin(AgentRoomService, resolved);
  ctx.plugin(webPlugin);
  if (resolved.tools) ctx.plugin(toolsPlugin);
  if (resolved.skills) ctx.plugin(skillsPlugin);
}

export { AgentRoomService, resolveConfig };
export type { AgentRoomConfig } from "./service.js";
