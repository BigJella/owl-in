import { DEFAULT_MAX_AI, DEFAULT_MAX_BOTS, POKER_MAX_SEATS } from "@owl-in/shared";

export interface LlmConfig {
  /** Bots per new poker table (admins can change it per table). */
  defaultMaxBots: number;
  /** How many of those bots are LLM bots on a new table (admins can change it per table). */
  defaultMaxAi: number;
  model: string;
  timeoutMs: number;
  bin: string;
}

const count = (raw: string | undefined, fallback: number, max: number) => {
  const text = (raw ?? "").trim().toLowerCase();
  if (text === "all") return max;
  const n = Number(text);
  return text !== "" && Number.isFinite(n) ? Math.max(0, Math.min(max, Math.floor(n))) : fallback;
};

/**
 * Read from env (all optional):
 * - OWL_DEFAULT_BOTS: bots per new poker table, 0..8 (default 4)
 * - OWL_LLM_BOTS: how many of them are LLM bots, a number or "all" (default 2)
 * - OWL_LLM_MODEL (default claude-haiku-5-5)
 * - OWL_LLM_TIMEOUT_MS (default 15000)
 * - OWL_CLAUDE_BIN (default "claude")
 */
export function readLlmConfig(env: NodeJS.ProcessEnv = process.env): LlmConfig {
  const defaultMaxBots = count(env.OWL_DEFAULT_BOTS, DEFAULT_MAX_BOTS, POKER_MAX_SEATS);
  const timeout = Number(env.OWL_LLM_TIMEOUT_MS ?? 15_000);
  return {
    defaultMaxBots,
    defaultMaxAi: count(env.OWL_LLM_BOTS, Math.min(DEFAULT_MAX_AI, defaultMaxBots), defaultMaxBots),
    model: env.OWL_LLM_MODEL?.trim() || "claude-haiku-5-5",
    timeoutMs: Number.isFinite(timeout) && timeout > 0 ? timeout : 15_000,
    bin: env.OWL_CLAUDE_BIN?.trim() || "claude",
  };
}
