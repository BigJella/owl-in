import { formatDD, type LlmDecision, type LlmStats } from "@owl-in/shared";
import type { LlmDecisionLog } from "./LlmStrategy";

const KEEP = 500;

/** The last 500 LLM decisions plus running totals, for the admin panel and the live views. */
export class LlmTelemetry {
  private readonly log: LlmDecision[] = [];
  private calls = 0;
  private fallbacks = 0;
  private readonly reasons: Record<string, number> = {};
  private totalMs = 0;
  private totalCostUsd = 0;

  constructor(
    readonly available: boolean,
    readonly model: string,
  ) {}

  record(entry: LlmDecisionLog) {
    const action = entry.action.type === "raise" ? `raise to ${formatDD(entry.action.to)}` : entry.action.type;
    this.log.unshift({
      at: entry.at,
      table: entry.table,
      bot: entry.bot,
      handId: entry.handId,
      action,
      ms: entry.ms,
      costUsd: entry.costUsd,
      fallback: entry.fallback,
    });
    if (this.log.length > KEEP) this.log.length = KEEP;
    this.calls += 1;
    this.totalMs += entry.ms;
    this.totalCostUsd += entry.costUsd ?? 0;
    if (entry.fallback) {
      this.fallbacks += 1;
      // Group "timeout", "unavailable", "unrecognized action: ..." etc. by their first words.
      const reason = entry.fallback.split(":")[0]!.slice(0, 40);
      this.reasons[reason] = (this.reasons[reason] ?? 0) + 1;
    }
  }

  stats(recent = 20): LlmStats {
    const sorted = this.log.map((d) => d.ms).sort((a, b) => a - b);
    return {
      available: this.available,
      model: this.model,
      calls: this.calls,
      fallbacks: this.fallbacks,
      fallbackReasons: { ...this.reasons },
      avgMs: this.calls > 0 ? Math.round(this.totalMs / this.calls) : 0,
      p95Ms: sorted.length > 0 ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))]! : 0,
      totalCostUsd: Math.round(this.totalCostUsd * 1e6) / 1e6,
      recent: this.log.slice(0, Math.max(0, Math.min(KEEP, recent))),
    };
  }
}
