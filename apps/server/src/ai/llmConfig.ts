import { BOT_FILL_TARGET } from "@owl-in/shared";

export interface LlmConfig {
  /** How many of each table's bots are seated in LLM mode (0 = all script). */
  botsPerTable: number;
  model: string;
  timeoutMs: number;
  bin: string;
}

/**
 * Read from env:
 * - OWL_LLM_BOTS: 0..4 or "all" (default 0)
 * - OWL_LLM_MODEL (default claude-haiku-5-5)
 * - OWL_LLM_TIMEOUT_MS (default 15000)
 * - OWL_CLAUDE_BIN (default "claude")
 */
export function readLlmConfig(env: NodeJS.ProcessEnv = process.env): LlmConfig {
  const raw = (env.OWL_LLM_BOTS ?? "0").trim().toLowerCase();
  const count = raw === "all" ? BOT_FILL_TARGET : Number(raw);
  const timeout = Number(env.OWL_LLM_TIMEOUT_MS ?? 15_000);
  return {
    botsPerTable: Number.isFinite(count) ? Math.max(0, Math.min(BOT_FILL_TARGET, Math.floor(count))) : 0,
    model: env.OWL_LLM_MODEL?.trim() || "claude-haiku-5-5",
    timeoutMs: Number.isFinite(timeout) && timeout > 0 ? timeout : 15_000,
    bin: env.OWL_CLAUDE_BIN?.trim() || "claude",
  };
}
