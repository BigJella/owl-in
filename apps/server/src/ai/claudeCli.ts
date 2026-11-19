import { spawn } from "node:child_process";
import type { CompleteFn, Completion } from "./LlmStrategy";

/** The only shape the model may answer with (enforced by the CLI's structured output). */
export const ACTION_SCHEMA = {
  type: "object",
  properties: {
    type: { type: "string", enum: ["fold", "check", "call", "raise"] },
    to: { type: "number", description: "Total bet to raise to (raise only)." },
  },
  required: ["type"],
  additionalProperties: false,
} as const;

export const SYSTEM_PROMPT =
  "You are a No-Limit Texas Hold'em player at a cash game. Play solid, winning poker. " +
  "You are given only what your seat can see. Answer with your action and nothing else.";

export interface ClaudeCliOptions {
  /** Executable (default "claude"). */
  bin: string;
  model: string;
  /** The call is killed after this long (the strategy then falls back to the script). */
  timeoutMs: number;
}

export function claudeArgs(model: string): string[] {
  return [
    "-p",
    "--model", model,
    "--output-format", "json",
    "--json-schema", JSON.stringify(ACTION_SCHEMA),
    "--system-prompt", SYSTEM_PROMPT,
    // No tools, MCP servers, user/project settings or saved sessions: a bare, fast, stateless call.
    "--tools", "",
    "--strict-mcp-config",
    "--setting-sources", "",
    "--no-session-persistence",
  ];
}

/**
 * Pull the action out of `claude -p --output-format json` stdout: its JSON text (what `parseAction`
 * reads) and the call's cost. Throws on CLI errors.
 */
export function parseCliOutput(stdout: string): Completion {
  const out = JSON.parse(stdout) as { is_error?: boolean; structured_output?: unknown; result?: unknown; total_cost_usd?: unknown };
  if (out.is_error) throw new Error(`claude error: ${String(out.result ?? "unknown")}`);
  const costUsd = typeof out.total_cost_usd === "number" ? out.total_cost_usd : null;
  if (out.structured_output && typeof out.structured_output === "object") return { text: JSON.stringify(out.structured_output), costUsd };
  if (typeof out.result === "string") return { text: out.result, costUsd };
  throw new Error("claude returned no action");
}

/** A CompleteFn that runs the local Claude Code CLI headlessly, one process per decision. */
export function createClaudeCliComplete(options: ClaudeCliOptions): CompleteFn {
  return (prompt, signal) =>
    new Promise<Completion>((resolve, reject) => {
      if (signal.aborted) return reject(new Error("aborted"));
      const child = spawn(options.bin, claudeArgs(options.model), { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
      let stdout = "";
      let stderr = "";
      let settled = false;
      const finish = (error: Error | null, value?: Completion) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal.removeEventListener("abort", onAbort);
        if (error) {
          if (child.exitCode === null) child.kill();
          reject(error);
        } else resolve(value!);
      };
      const onAbort = () => finish(new Error("aborted"));
      const timer = setTimeout(() => finish(new Error("timeout")), options.timeoutMs);
      signal.addEventListener("abort", onAbort, { once: true });

      child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
      child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
      child.on("error", (error) => finish(error));
      child.on("close", (code) => {
        if (code !== 0) return finish(new Error(`claude exited ${code}: ${stderr.trim().slice(0, 200)}`));
        try {
          finish(null, parseCliOutput(stdout));
        } catch (error) {
          finish(error as Error);
        }
      });
      child.stdin.on("error", () => {}); // process died before reading the prompt; 'close' reports it
      child.stdin.end(prompt);
    });
}

/** True if the CLI runs (`claude --version`). */
export function claudeAvailable(bin: string, timeoutMs = 10_000): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn(bin, ["--version"], { stdio: "ignore", windowsHide: true });
    const timer = setTimeout(() => {
      child.kill();
      resolve(false);
    }, timeoutMs);
    child.on("error", () => {
      clearTimeout(timer);
      resolve(false);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve(code === 0);
    });
  });
}
