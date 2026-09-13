/**
 * dsh-agent-org — cross-machine remote execution (org_exec).
 *
 * The controller sends an exec instruction over the agent-room sync room; the
 * target machine's agent-org executes it locally and replies with the result.
 */
import { exec as nodeExec } from "node:child_process";
import { homedir, tmpdir } from "node:os";

export const EXEC_PREFIX = "[org:exec]";
export const EXEC_RESULT_PREFIX = "[org:exec:result]";

/** How long the TARGET machine lets a command run before killing it. */
export const EXEC_TIMEOUT_MS = 30_000;

/**
 * How long the CONTROLLER waits for the target's answer.
 *
 * Must exceed EXEC_TIMEOUT_MS by enough to cover the round trip — the room
 * message out, the relay, and the result frame back. At only 5s of margin a slow
 * or lossy link made the controller give up first and report its own generic
 * "timed out waiting for result", hiding the target's real answer (which may
 * well have been a precise "timed out after 30000ms"). Give it real room.
 */
export const EXEC_WAIT_TIMEOUT_MS = EXEC_TIMEOUT_MS + 15_000;

/**
 * A working directory a remote command can always start in.
 *
 * node's exec defaults the child's cwd to the parent's. When that directory no
 * longer exists — e.g. the DSH host was started from a USB path that was later
 * unplugged — CreateProcess fails outright and EVERY remote command dies with
 * spawn ENOENT, which looks nothing like the real cause. Verified on Windows:
 * an absent cwd fails identically for cmd.exe and powershell.exe, while a valid
 * one runs both. A remote command must never inherit the host's cwd.
 */
function safeWorkingDirectory() {
  for (const candidate of [homedir(), tmpdir()]) {
    try {
      if (candidate) return candidate;
    } catch { /* try the next candidate */ }
  }
  return process.cwd();
}

/**
 * Run a shell command with a timeout. Returns a serializable result.
 * @param {string} command
 * @param {number} timeoutMs
 * @returns {Promise<{ok: boolean, code: number|null, stdout: string, stderr: string, timedOut: boolean, error?: string}>}
 */
export function runCommand(command, timeoutMs = EXEC_TIMEOUT_MS) {
  return new Promise((resolve) => {
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try { child.kill("SIGKILL"); } catch { /* ignore */ }
    }, timeoutMs);
    const child = nodeExec(
      command,
      { encoding: "utf8", windowsHide: true, cwd: safeWorkingDirectory() },
      (error, stdout, stderr) => {
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
