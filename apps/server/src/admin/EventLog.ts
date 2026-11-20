import {
  ADMIN_LOG_KINDS,
  type AdminLogPlayer,
  type AdminLogEntry,
  type AdminLogKind,
  type AdminLogPage,
  type AdminLogQuery,
} from "@owl-in/shared";

/** A player as a log entry mentions them: humans keep their id (the panel opens their career), bots don't. */
export function logPlayer(player: { id: string; name: string }, human: boolean): AdminLogPlayer {
  return { playerId: human ? player.id : null, name: player.name, kind: human ? "human" : "bot" };
}

/** How many entries of each kind are kept (separately, so busy bot tables never push out admin actions). */
export const EVENT_LOG_KEEP: Record<AdminLogKind, number> = { hand: 5000, llm: 2000, admin: 2000 };

export type NewLogEntry = Omit<AdminLogEntry, "id" | "at"> & { at?: number };

/**
 * The admin panel's Logging tab: every hand / blackjack round, LLM decision and admin action, in memory (a restart
 * wipes it, like everything else). Entries never carry hidden cards, browser tokens or IP addresses.
 */
export class EventLog {
  private nextId = 1;
  private readonly entries: Record<AdminLogKind, AdminLogEntry[]> = { hand: [], llm: [], admin: [] };

  constructor(private readonly keep: Record<AdminLogKind, number> = EVENT_LOG_KEEP) {}

  add(entry: NewLogEntry): AdminLogEntry {
    const full: AdminLogEntry = { ...entry, id: this.nextId++, at: entry.at ?? Date.now() };
    const list = this.entries[full.kind];
    list.push(full);
    if (list.length > this.keep[full.kind]) list.splice(0, list.length - this.keep[full.kind]);
    return full;
  }

  counts(): Record<AdminLogKind, number> {
    return { hand: this.entries.hand.length, llm: this.entries.llm.length, admin: this.entries.admin.length };
  }

  /** Newest first. `after` returns the newest entries past that id; `before` pages back. */
  query(query: AdminLogQuery = {}): AdminLogPage {
    const limit = Math.max(1, Math.min(500, Math.floor(query.limit ?? 100)));
    const kinds = query.kinds && query.kinds.length > 0 ? query.kinds : ADMIN_LOG_KINDS;
    const q = query.q?.trim().toLowerCase() ?? "";
    const matches = (e: AdminLogEntry) => {
      if (query.before !== undefined && e.id >= query.before) return false;
      if (query.after !== undefined && e.id <= query.after) return false;
      if (query.game && e.game !== query.game) return false;
      if (query.tableId && e.table?.id !== query.tableId) return false;
      if (query.playerId && !e.players.some((p) => p.playerId === query.playerId)) return false;
      if (query.humansOnly && e.kind === "hand" && !e.players.some((p) => p.kind === "human")) return false;
      if (q) {
        const text = [e.summary, e.table?.name ?? "", ...e.players.map((p) => p.name)].join(" ").toLowerCase();
        if (!text.includes(q)) return false;
      }
      return true;
    };
    const found = kinds.flatMap((kind) => this.entries[kind].filter(matches)).sort((a, b) => b.id - a.id);
    return { entries: found.slice(0, limit), more: found.length > limit, counts: this.counts() };
  }
}
