/**
 * dsh-agent-org — cross-machine remote execution (org_exec).
 *
 * The controller sends an exec instruction over the agent-room sync room; the
 * target machine's agent-org executes it locally and replies with the result.
 */
import { exec as nodeExec } from "node:child_process";

export const EXEC_PREFIX = "[org:exec]";
export const EXEC_RESULT_PREFIX = "[org:exec:result]";

/**
 * Run a shell command with a timeout. Returns a serializable result.
 * @param {string} command
 * @param {number} timeoutMs
 * @returns {Promise<{ok: boolean, code: number|null, stdout: string, stderr: string, timedOut: boolean, error?: string}>}
 */
export function runCommand(command, timeoutMs = 30000) {
  return new Promise((resolve) => {
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try { child.kill("SIGKILL"); } catch { /* ignore */ }
    }, timeoutMs);
    const child = nodeExec(command, { encoding: "utf8", windowsHide: true }, (error, stdout, stderr) => {
      clearTimeout(timer);
      if (timedOut) {
        resolve({ ok: false, code: null, stdout: "", stderr: "", timedOut: true, error: `timed out after ${timeoutMs}ms` });
        return;
      }
      resolve({
        ok: !error,
        code: typeof error?.code === "number" ? error.code : (error ? 1 : 0),
        stdout: stdout ?? "",
        stderr: stderr ?? "",
        timedOut: false,
        error: error ? String(error.message ?? error) : undefined,
      });
    });
  });
}

/**
 * @param {{id: string, targetAgentId: string, command: string, ts: string}} payload
 */
export function encodeExec(payload) {
  return EXEC_PREFIX + JSON.stringify(payload);
}

/**
 * @param {string} text
 * @returns {{id: string, targetAgentId: string, command: string, ts: string}|null}
 */
export function decodeExec(text) {
  if (typeof text !== "string" || !text.startsWith(EXEC_PREFIX)) return null;
  try {
    const p = JSON.parse(text.slice(EXEC_PREFIX.length));
    if (!p || typeof p.id !== "string" || typeof p.targetAgentId !== "string" || typeof p.command !== "string") return null;
    return p;
  } catch {
    return null;
  }
}

/**
 * @param {{id: string, ok: boolean, code: number|null, stdout: string, stderr: string, timedOut: boolean, error?: string, by: string}} payload
 */
export function encodeExecResult(payload) {
  return EXEC_RESULT_PREFIX + JSON.stringify(payload);
}

/**
 * @param {string} text
 */
export function decodeExecResult(text) {
  if (typeof text !== "string" || !text.startsWith(EXEC_RESULT_PREFIX)) return null;
  try {
    const p = JSON.parse(text.slice(EXEC_RESULT_PREFIX.length));
    if (!p || typeof p.id !== "string") return null;
    return p;
  } catch {
    return null;
  }
}
