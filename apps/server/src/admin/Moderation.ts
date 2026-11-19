/**
 * Bans, sitewide timeouts and per-table timeouts (the poker rejoin lockout, plus any an admin adds).
 * In memory like everything else: a restart clears them.
 */
export interface Timeout {
  until: number;
  reason: string | null;
}

export interface TableTimeout extends Timeout {
  roomName: string;
}

export interface Ban {
  at: number;
  reason: string | null;
}

/** Why a player can't sit at a table right now (null = they can). */
export type JoinBlock =
  | { kind: "banned" }
  | { kind: "site"; until: number }
  | { kind: "table"; until: number; reason: string | null };

export class Moderation {
  private readonly tables = new Map<string, Map<string, TableTimeout>>();
  private readonly site = new Map<string, Timeout>();
  private readonly bans = new Map<string, Ban>();

  // ---------- per-table ----------

  tableTimeout(roomId: string, playerId: string): TableTimeout | null {
    const timeout = this.tables.get(roomId)?.get(playerId);
    if (!timeout) return null;
    if (timeout.until <= Date.now()) {
      this.clearTableTimeout(roomId, playerId);
      return null;
    }
    return timeout;
  }

  setTableTimeout(roomId: string, roomName: string, playerId: string, ms: number, reason: string | null) {
    if (ms <= 0) return this.clearTableTimeout(roomId, playerId);
    let room = this.tables.get(roomId);
    if (!room) this.tables.set(roomId, (room = new Map()));
    room.set(playerId, { until: Date.now() + ms, reason, roomName });
  }

  clearTableTimeout(roomId: string, playerId: string): boolean {
    const room = this.tables.get(roomId);
    const removed = room?.delete(playerId) ?? false;
    if (room?.size === 0) this.tables.delete(roomId);
    return removed;
  }

  /** The table closed: its timeouts mean nothing any more. */
  dropRoom(roomId: string) {
    this.tables.delete(roomId);
  }

  // ---------- sitewide ----------

  siteTimeout(playerId: string): Timeout | null {
    const timeout = this.site.get(playerId);
    if (!timeout) return null;
    if (timeout.until <= Date.now()) {
      this.site.delete(playerId);
      return null;
    }
    return timeout;
  }

  setSiteTimeout(playerId: string, ms: number, reason: string | null) {
    if (ms <= 0) return void this.site.delete(playerId);
    this.site.set(playerId, { until: Date.now() + ms, reason });
  }

  clearSiteTimeout(playerId: string): boolean {
    return this.site.delete(playerId);
  }

  // ---------- bans ----------

  ban(playerId: string, reason: string | null) {
    if (!this.bans.has(playerId)) this.bans.set(playerId, { at: Date.now(), reason });
  }

  unban(playerId: string): boolean {
    return this.bans.delete(playerId);
  }

  banOf(playerId: string): Ban | null {
    return this.bans.get(playerId) ?? null;
  }

  bannedCount(): number {
    return this.bans.size;
  }

  // ---------- checks ----------

  joinBlock(roomId: string, playerId: string): JoinBlock | null {
    if (this.bans.has(playerId)) return { kind: "banned" };
    const site = this.siteTimeout(playerId);
    if (site) return { kind: "site", until: site.until };
    const table = this.tableTimeout(roomId, playerId);
    if (table) return { kind: "table", until: table.until, reason: table.reason };
    return null;
  }

  /** Every active timeout (expired ones are dropped on the way). */
  allTimeouts(): ({ scope: "site"; playerId: string } & Timeout | { scope: "table"; playerId: string; roomId: string } & TableTimeout)[] {
    const now = Date.now();
    const out: ReturnType<Moderation["allTimeouts"]> = [];
    for (const [playerId, timeout] of [...this.site]) {
      if (timeout.until <= now) this.site.delete(playerId);
      else out.push({ scope: "site", playerId, ...timeout });
    }
    for (const [roomId, room] of [...this.tables]) {
      for (const [playerId, timeout] of [...room]) {
        if (timeout.until <= now) this.clearTableTimeout(roomId, playerId);
        else out.push({ scope: "table", playerId, roomId, ...timeout });
      }
    }
    return out;
  }

  tableTimeoutCount(playerId: string): number {
    const now = Date.now();
    let count = 0;
    for (const room of this.tables.values()) {
      const timeout = room.get(playerId);
      if (timeout && timeout.until > now) count += 1;
    }
    return count;
  }
}

const minutesLeft = (until: number) => Math.max(1, Math.ceil((until - Date.now()) / 60_000));

/** The message a player sees when a join is refused. */
export function joinBlockMessage(block: JoinBlock): string {
  switch (block.kind) {
    case "banned":
      return "You're banned from OWL IN.";
    case "site":
      return `You're timed out from every table for ${minutesLeft(block.until)} more min.`;
    case "table":
      return block.reason === LEFT_REASON
        ? `You left this table recently. You can rejoin it in ${minutesLeft(block.until)} min.`
        : `You were removed from this table. You can rejoin it in ${minutesLeft(block.until)} min.`;
  }
}

/** Reason recorded for the automatic poker rejoin lockout. */
export const LEFT_REASON = "Left the table";
