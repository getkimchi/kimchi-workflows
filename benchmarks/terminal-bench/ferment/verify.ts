/**
 * Two things this workflow runs itself rather than asking an agent to run: a step's verification
 * command, and the phase diff the grader is shown.
 *
 * Running a step's verification command, as kimchi's `verify_ferment_step` does.
 *
 * kimchi executes the command through the harness's own `bash` tool with a 60s timeout and records
 * `{exitCode, stdout, stderr}` on the step. There is no tool loop here, so this runs it directly — same
 * shell, same timeout, same recorded shape. It is a FUNCTION step's body, deliberately: the command is
 * the plan's own, and handing it to an agent to run would let the agent decide what it saw.
 */
import { spawn } from "node:child_process";
import type { VerifyResult } from "./contract.ts";

/** kimchi's `VERIFY_TIMEOUT_MS`. */
export const VERIFY_TIMEOUT_MS = 60_000;

const MAX_CAPTURE = 64_000;

export async function runVerification(command: string, signal: AbortSignal): Promise<VerifyResult> {
  return new Promise<VerifyResult>((resolve) => {
    let stdout = "";
    let stderr = "";
    let settled = false;

    const finish = (exitCode: number, extraStderr = ""): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      resolve({ ran: true, command, exitCode, stdout: stdout.slice(0, MAX_CAPTURE), stderr: `${stderr}${extraStderr}`.slice(0, MAX_CAPTURE) });
    };

    // `bash -lc` so the command sees a login shell's PATH — the same assumption every verify command in
    // a terminal-bench container is written against.
    const child = spawn("bash", ["-lc", command], { stdio: ["ignore", "pipe", "pipe"] });
    child.stdout?.on("data", (chunk: Buffer) => {
      if (stdout.length < MAX_CAPTURE) stdout += chunk.toString();
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      if (stderr.length < MAX_CAPTURE) stderr += chunk.toString();
    });

    const kill = (): void => {
      child.kill("SIGKILL");
    };
    const timer = setTimeout(() => {
      kill();
      finish(1, "\nVerification command timed out after 60s");
    }, VERIFY_TIMEOUT_MS);
    const onAbort = (): void => {
      kill();
      finish(1, "\nVerification command was cancelled");
    };
    signal.addEventListener("abort", onAbort, { once: true });

    child.on("error", (error: Error) => finish(1, `\nbash execution threw an exception: ${error.message}`));
    child.on("close", (code: number | null) => finish(code ?? 1));
  });
}

// -- Phase diff evidence ------------------------------------------------------------------------------
//
// kimchi captures a git ref at `activate_ferment_phase` (`setPhaseStartRef`) and turns the range into
// evidence at `complete_ferment_phase` (`phase-evidence.ts`), so the phase grader sees what actually
// changed instead of only what the agent says changed. Same idea, same caps.

/** kimchi's `MAX_FILES_LISTED` / `MAX_DIFF_BYTES` (src/extensions/ferment/phase-evidence.ts). */
const MAX_FILES_LISTED = 20;
const MAX_DIFF_BYTES = 4000;

export interface PhaseDiff {
  available: boolean;
  filesChanged: string;
  diffSnippet: string;
}

/** The commit a phase starts from, or `""` outside a git repo — evidence is best-effort, never fatal. */
export async function currentGitRef(signal: AbortSignal): Promise<string> {
  const result = await runVerification("git rev-parse HEAD", signal);
  return result.exitCode === 0 ? result.stdout.trim() : "";
}

/** What changed since `sinceRef`, as the grader is shown it. */
export async function phaseDiffSince(sinceRef: string, signal: AbortSignal): Promise<PhaseDiff> {
  if (!sinceRef) return { available: false, filesChanged: "", diffSnippet: "" };

  const stat = await runVerification(`git diff --stat ${sinceRef}`, signal);
  if (stat.exitCode !== 0) return { available: false, filesChanged: "", diffSnippet: "" };

  const diff = await runVerification(`git diff --unified=2 ${sinceRef}`, signal);
  return {
    available: true,
    filesChanged: capLines(stat.stdout.trim()),
    diffSnippet: capBytes(diff.exitCode === 0 ? diff.stdout : ""),
  };
}

function capLines(text: string): string {
  const lines = text.split("\n");
  if (lines.length <= MAX_FILES_LISTED + 1) return text;
  return `${lines.slice(0, MAX_FILES_LISTED).join("\n")}\n[... ${lines.length - MAX_FILES_LISTED} more ...]`;
}

/** kimchi keeps the head and the tail of an oversized diff, not just the head. */
function capBytes(diff: string): string {
  if (diff.length <= MAX_DIFF_BYTES) return diff;
  const half = Math.floor(MAX_DIFF_BYTES / 2);
  return `${diff.slice(0, half)}\n\n[... diff truncated, ${diff.length - MAX_DIFF_BYTES} bytes elided ...]\n\n${diff.slice(-half)}`;
}
