import {
  ADMIN_ACTION_LABEL,
  ALLOWED_BIG_BLINDS,
  BJ_ALLOWED_MIN_BETS,
  BJ_BOT_SPOTS,
  POKER_MAX_SEATS,
  STARTING_BANKROLL,
  formatDD,
  type AdminActionType,
  type AdminLogPage,
  type AdminLogQuery,
  type AdminPlayer,
  type AdminSnapshot,
  type AdminTable,
  type AdminTimeout,
  type AdminTotals,
  type CareerView,
  type HandRecord,
  type BotMode,
  type GameType,
  type LlmStats,
  type TimeoutScope,
} from "@owl-in/shared";
import type { LlmTelemetry } from "../ai/LlmTelemetry";
import type { HouseBank } from "../economy/HouseBank";
import type { HumanPlayer } from "../players/HumanPlayer";
import { nameSchema } from "../players/names";
import type { PlayerRegistry } from "../players/PlayerRegistry";
import type { BlackjackRoom } from "../rooms/BlackjackRoom";
import type { BlackjackRoomManager } from "../rooms/BlackjackRoomManager";
import type { PokerRoom } from "../rooms/PokerRoom";
import { careerView, sessionHandsFor } from "../stats/careerView";
import type { StatsStore } from "../stats/StatsStore";
import { MIN_OPEN_ROOMS, type RoomManager } from "../rooms/RoomManager";
import { logPlayer, type EventLog } from "./EventLog";
import type { Moderation } from "./Moderation";

/** A refused admin request: the HTTP status and a message for the panel. */
export class AdminError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export interface AdminServiceDeps {
  registry: PlayerRegistry;
  rooms: RoomManager;
  blackjack: BlackjackRoomManager;
  bank: HouseBank;
  moderation: Moderation;
  telemetry: LlmTelemetry;
  /** Career stats (same store the game's Career page reads). */
  stats?: StatsStore;
  /** The Logging tab's event log: every admin action (and refusal) is added here. */
  eventLog?: EventLog;
  /** Called after anything that changes what the lobby shows (player counts). */
  publishLobby?: () => void;
}

const MINUTE = 60_000;

/**
 * Every management operation, shared by the admin panel, the itcan.do bridge and curl (through `adminRoutes`).
 * Reads never include hidden cards, browser tokens or IP addresses.
 */
export class AdminService {
  constructor(private readonly deps: AdminServiceDeps) {}

  // ---------- reads ----------

  snapshot(): AdminSnapshot {
    const tables = this.tables();
    return {
      at: Date.now(),
      totals: this.totals(tables),
      tables,
      players: this.players(),
      timeouts: this.timeouts(),
      llm: this.deps.telemetry.stats(20),
    };
  }

  tables(): AdminTable[] {
    return [
      ...[...this.deps.rooms.rooms.values()].map((room) => room.admin()),
      ...[...this.deps.blackjack.rooms.values()].map((room) => room.admin()),
    ];
  }

  table(id: string): AdminTable {
    return this.findTable(id).room.admin();
  }

  players(): AdminPlayer[] {
    const { registry, rooms, moderation } = this.deps;
    return registry
      .all()
      .map((player): AdminPlayer => {
        const atTable = rooms.chipsOf(player);
        const room = this.roomOf(player);
        const ban = moderation.banOf(player.id);
        const timeout = moderation.siteTimeout(player.id);
        return {
          id: player.id,
          name: player.name,
          online: player.connected,
          bankroll: player.bankroll,
          atTable,
          total: player.bankroll + atTable,
          table: room ? { id: room.id, name: room.name, game: player.game ?? "poker" } : null,
          banned: ban ? { at: ban.at, reason: ban.reason } : null,
          timeout: timeout ? { until: timeout.until, reason: timeout.reason } : null,
          tableTimeouts: moderation.tableTimeoutCount(player.id),
        };
      })
      .sort((a, b) => b.total - a.total);
  }

  timeouts(): AdminTimeout[] {
    const now = Date.now();
    return this.deps.moderation
      .allTimeouts()
      .map((t) => ({
        playerId: t.playerId,
        playerName: this.deps.registry.byPlayerId(t.playerId)?.name ?? "?",
        scope: t.scope,
        roomId: t.scope === "table" ? t.roomId : null,
        roomName: t.scope === "table" ? t.roomName : null,
        until: t.until,
        remainingMs: Math.max(0, t.until - now),
        reason: t.reason,
      }))
      .sort((a, b) => a.until - b.until);
  }

  /** A player's career, exactly what their Career page shows (private careers included: this is the admin). */
  career(playerId: string): CareerView {
    const player = this.player(playerId);
    if (!this.deps.stats) throw new AdminError(404, "Career stats aren't available on this server.");
    return careerView(this.deps.stats, player, null, this.deps.rooms.chipsOf(player));
  }

  /** One table session's hands, as the Career page's history shows them (unshown poker hole cards hidden). */
  sessionHands(playerId: string, sessionId: string): HandRecord[] {
    const player = this.player(playerId);
    if (!this.deps.stats) throw new AdminError(404, "Career stats aren't available on this server.");
    return sessionHandsFor(this.deps.stats, player, null, sessionId);
  }

  llm(limit = 100): LlmStats {
    return this.deps.telemetry.stats(limit);
  }

  /** The event log (hands, LLM decisions, admin actions), newest first. */
  log(query: AdminLogQuery = {}): AdminLogPage {
    if (!this.deps.eventLog) return { entries: [], more: false, counts: { hand: 0, llm: 0, admin: 0 } };
    return this.deps.eventLog.query(query);
  }

  private totals(tables: AdminTable[]): AdminTotals {
    const { registry, bank, moderation } = this.deps;
    const players = registry.all();
    const bankrolls = players.reduce((sum, p) => sum + p.bankroll, 0);
    const onPokerTables = tables.filter((t) => t.game === "poker").reduce((sum, t) => sum + t.chips, 0);
    const onBlackjackTables = tables.filter((t) => t.game === "blackjack").reduce((sum, t) => sum + t.chips, 0);
    const total = bankrolls + bank.balance + onPokerTables + onBlackjackTables;
    const expected = bank.initial + players.length * STARTING_BANKROLL;
    return {
      bankrolls,
      house: bank.balance,
      onPokerTables,
      onBlackjackTables,
      total,
      expected,
      conserved: total === expected,
      playersKnown: players.length,
      playersOnline: registry.onlineCount(),
      playersAtTables: players.filter((p) => p.roomId !== null).length,
      banned: moderation.bannedCount(),
      pokerTables: this.deps.rooms.rooms.size,
      blackjackTables: this.deps.blackjack.rooms.size,
    };
  }

  // ---------- tables ----------

  createTable(request: {
    game: GameType;
    name: string;
    bigBlind?: number;
    minBet?: number;
    maxBots?: number;
    maxAi?: number;
  }): AdminTable {
    return this.refusable("create-table", { summary: `${request.game} table "${request.name.trim()}"` }, () => {
      const table = this.createTableUnlogged(request);
      const ai = table.settings.maxAi === null ? "" : `, max AI ${table.settings.maxAi}`;
      this.audit("create-table", {
        table,
        summary: `Created ${table.game} table ${table.name} (${table.stakes}, max bots ${table.settings.maxBots}${ai})`,
      });
      return table;
    });
  }

  private createTableUnlogged(request: {
    game: GameType;
    name: string;
    bigBlind?: number;
    minBet?: number;
    maxBots?: number;
    maxAi?: number;
  }): AdminTable {
    const name = request.name.trim();
    if (name.length < 1 || name.length > 24) throw new AdminError(400, "Table names are 1–24 characters.");
    if (request.game === "poker") {
      if (!(ALLOWED_BIG_BLINDS as readonly number[]).includes(request.bigBlind ?? -1)) {
        throw new AdminError(400, `Big blind must be one of ${ALLOWED_BIG_BLINDS.join(", ")}.`);
      }
      const settings = this.checkPokerSettings(request.maxBots, request.maxAi, null);
      return this.deps.rooms.create(name, request.bigBlind!, settings).admin();
    }
    if (!(BJ_ALLOWED_MIN_BETS as readonly number[]).includes(request.minBet ?? -1)) {
      throw new AdminError(400, `Minimum bet must be one of ${BJ_ALLOWED_MIN_BETS.join(", ")}.`);
    }
    if (request.maxAi !== undefined && request.maxAi !== null) throw new AdminError(400, "Blackjack tables have no AI bots yet.");
    const maxBots = this.checkBlackjackBots(request.maxBots);
    return this.deps.blackjack.create(name, request.minBet!, maxBots).admin();
  }

  updateTable(id: string, request: { maxBots?: number; maxAi?: number | null }): AdminTable {
    return this.refusable("update-table", { tableId: id }, () => {
      const table = this.updateTableUnlogged(id, request);
      const changed = [
        request.maxBots !== undefined ? `max bots ${table.settings.maxBots}` : null,
        request.maxAi !== undefined && request.maxAi !== null ? `max AI ${table.settings.maxAi}` : null,
      ].filter(Boolean);
      this.audit("update-table", { table, summary: `${table.name}: ${changed.join(", ") || "no change"}` });
      return table;
    });
  }

  private updateTableUnlogged(id: string, request: { maxBots?: number; maxAi?: number | null }): AdminTable {
    const found = this.findTable(id);
    if (found.game === "poker") {
      const room = found.room;
      const settings = this.checkPokerSettings(request.maxBots, request.maxAi ?? undefined, room);
      room.updateSettings(settings);
      return room.admin();
    }
    if (request.maxAi !== undefined && request.maxAi !== null) throw new AdminError(400, "Blackjack tables have no AI bots yet.");
    const maxBots = this.checkBlackjackBots(request.maxBots);
    if (maxBots !== undefined) found.room.updateSettings(maxBots);
    return found.room.admin();
  }

  /** Close after the current hand / round. At least two tables of each game always stay open. */
  closeTable(id: string): AdminTable {
    return this.refusable("close-table", { tableId: id }, () => {
      const table = this.closeTableUnlogged(id);
      this.audit("close-table", {
        table,
        summary: `Closing ${table.name} after the current ${table.game === "poker" ? "hand" : "round"}`,
      });
      return table;
    });
  }

  private closeTableUnlogged(id: string): AdminTable {
    const found = this.findTable(id);
    if (found.room.closing) return found.room.admin();
    const open = found.game === "poker" ? this.deps.rooms.openCount() : this.deps.blackjack.openCount();
    if (open <= MIN_OPEN_ROOMS) {
      throw new AdminError(409, `At least ${MIN_OPEN_ROOMS} ${found.game} tables stay open. Create another one first.`);
    }
    const snapshot = found.room.admin();
    found.room.requestClose();
    this.deps.publishLobby?.();
    return { ...snapshot, closing: true };
  }

  /** "auto" hands the bot back to the table's AI count. */
  setBotMode(botId: string, mode: BotMode | "auto"): void {
    const table = this.tables().find((t) => t.seats.some((seat) => seat.playerId === botId)) ?? null;
    const bot = table?.seats.find((seat) => seat.playerId === botId)?.name ?? "bot";
    this.refusable("bot-mode", { table, summary: `${bot} to ${mode}` }, () => {
      if (!this.deps.rooms.setBotOverride(botId, mode === "auto" ? null : mode)) {
        throw new AdminError(404, "No poker bot with that id (blackjack bots have no AI mode yet).");
      }
      const label = mode === "llm" ? "AI" : "Script";
      this.audit("bot-mode", {
        table,
        bots: [bot],
        summary: mode === "auto" ? `Set ${bot} back to Auto` : `Pinned ${bot} to ${label}`,
      });
    });
  }

  private checkPokerSettings(maxBots: number | undefined, maxAi: number | undefined, room: PokerRoom | null) {
    const settings: { maxBots?: number; maxAi?: number } = {};
    if (maxBots !== undefined) {
      if (!Number.isInteger(maxBots) || maxBots < 0 || maxBots > POKER_MAX_SEATS) {
        throw new AdminError(400, `Max bots is 0–${POKER_MAX_SEATS}.`);
      }
      settings.maxBots = maxBots;
    }
    if (maxAi !== undefined) {
      const bots = maxBots ?? room?.settings.maxBots ?? POKER_MAX_SEATS;
      if (!Number.isInteger(maxAi) || maxAi < 0 || maxAi > bots) throw new AdminError(400, `Max AI is 0–${bots} (no more than max bots).`);
      settings.maxAi = maxAi;
    }
    return settings;
  }

  private checkBlackjackBots(maxBots: number | undefined): number | undefined {
    if (maxBots === undefined) return undefined;
    if (!Number.isInteger(maxBots) || maxBots < 0 || maxBots > BJ_BOT_SPOTS) {
      throw new AdminError(400, `Blackjack bots sit in spots 1–${BJ_BOT_SPOTS}: max bots is 0–${BJ_BOT_SPOTS}.`);
    }
    return maxBots;
  }

  // ---------- players ----------

  /** Remove from their table (queued if they're in a hand / round). Optional timeout from that table. */
  kick(playerId: string, timeoutMinutes = 0): void {
    this.refusable("kick", { playerId }, () => {
      const player = this.player(playerId);
      const room = this.roomOf(player);
      if (!room) throw new AdminError(409, `${player.name} isn't at a table.`);
      const minutes = this.minutes(timeoutMinutes, true);
      room.kick(player, minutes * MINUTE);
      this.deps.publishLobby?.();
      this.audit("kick", {
        target: player,
        table: room,
        summary: `Kicked ${player.name} from ${room.name}${minutes > 0 ? ` with a ${minutes}-minute timeout` : ""}`,
      });
    });
  }

  ban(playerId: string, reason: string | null): void {
    this.refusable("ban", { playerId }, () => {
      const player = this.player(playerId);
      const room = this.roomOf(player) ?? null;
      this.deps.moderation.ban(player.id, reason);
      this.leaveTable(player);
      player.disconnectBanned(reason);
      this.deps.publishLobby?.();
      this.audit("ban", { target: player, table: room, summary: `Banned ${player.name}${reason ? ` (${reason})` : ""}` });
    });
  }

  unban(playerId: string): void {
    this.refusable("unban", { playerId }, () => {
      const player = this.player(playerId);
      if (!this.deps.moderation.unban(player.id)) throw new AdminError(409, `${player.name} isn't banned.`);
      this.audit("unban", { target: player, summary: `Unbanned ${player.name}` });
    });
  }

  /** Give (positive) or take (negative) Dining Dollars. The house is the other side, so chips stay conserved. */
  adjustBankroll(playerId: string, delta: number): AdminPlayer {
    const amount = Number.isFinite(delta) ? `${delta < 0 ? "−" : "+"}${formatDD(Math.abs(delta))}` : String(delta);
    return this.refusable("bankroll", { playerId, summary: amount }, () => {
      const player = this.player(playerId);
      if (!Number.isInteger(delta) || delta === 0) throw new AdminError(400, "Enter a whole, non-zero amount.");
      if (player.bankroll + delta < 0) throw new AdminError(400, `${player.name} only has ${formatDD(player.bankroll)} in their bankroll.`);
      player.bankroll += delta;
      this.deps.bank.withdraw(delta);
      player.sendSession();
      const change = delta > 0 ? `Gave ${player.name} ${formatDD(delta)}` : `Took ${formatDD(-delta)} from ${player.name}`;
      this.audit("bankroll", { target: player, summary: `${change} (bankroll now ${formatDD(player.bankroll)})` });
      return this.players().find((p) => p.id === player.id)!;
    });
  }

  rename(playerId: string, rawName: unknown): AdminPlayer {
    return this.refusable("rename", { playerId, summary: `to "${String(rawName).slice(0, 40)}"` }, () => {
      const player = this.player(playerId);
      const before = player.name;
      const name = nameSchema.safeParse(rawName);
      if (!name.success) throw new AdminError(400, name.error.issues[0]?.message ?? "Invalid name.");
      if (this.deps.registry.nameTaken(player.token, name.data)) throw new AdminError(409, `"${name.data}" belongs to another player.`);
      this.deps.registry.identify(player.token, name.data);
      player.sendSession(); // the browser saves the new name from its session
      this.roomOf(player)?.refresh();
      this.audit("rename", { target: player, summary: `Renamed ${before} to ${player.name}` });
      return this.players().find((p) => p.id === player.id)!;
    });
  }

  // ---------- timeouts ----------

  /** Add or replace a timeout. A player at the table (or anywhere, for sitewide) is removed from it. */
  setTimeout(request: { playerId: string; scope: TimeoutScope; roomId?: string | null; minutes: number; reason?: string | null }): void {
    this.refusable("timeout", { playerId: request.playerId, tableId: request.roomId ?? undefined }, () => {
      this.setTimeoutUnlogged(request);
      const player = this.player(request.playerId);
      const room = request.scope === "table" && request.roomId ? this.findTable(request.roomId).room : null;
      const reason = request.reason?.trim();
      this.audit("timeout", {
        target: player,
        table: room,
        summary: `Timed out ${player.name} from ${room ? room.name : "every table"} for ${request.minutes} min${reason ? ` (${reason})` : ""}`,
      });
    });
  }

  private setTimeoutUnlogged(request: { playerId: string; scope: TimeoutScope; roomId?: string | null; minutes: number; reason?: string | null }): void {
    const player = this.player(request.playerId);
    const ms = this.minutes(request.minutes, false) * MINUTE;
    const reason = request.reason?.trim() || null;
    if (request.scope === "site") {
      this.deps.moderation.setSiteTimeout(player.id, ms, reason);
      this.leaveTable(player, "An admin timed you out from every table.");
      return;
    }
    if (!request.roomId) throw new AdminError(400, "A table timeout needs a roomId.");
    const { room } = this.findTable(request.roomId);
    this.deps.moderation.setTableTimeout(room.id, room.name, player.id, ms, reason ?? "Timed out by an admin");
    if (this.roomOf(player) === room) room.kick(player, ms);
    this.deps.publishLobby?.();
  }

  clearTimeout(request: { playerId: string; scope: TimeoutScope; roomId?: string | null }): void {
    this.refusable("clear-timeout", { playerId: request.playerId, tableId: request.roomId ?? undefined }, () => {
      const player = this.player(request.playerId);
      const tableTimeout =
        request.scope === "table"
          ? this.timeouts().find((t) => t.scope === "table" && t.roomId === request.roomId && t.playerId === player.id)
          : undefined;
      const removed =
        request.scope === "site"
          ? this.deps.moderation.clearSiteTimeout(player.id)
          : request.roomId
            ? this.deps.moderation.clearTableTimeout(request.roomId, player.id)
            : false;
      if (!removed) throw new AdminError(404, "No such timeout.");
      const roomName = tableTimeout?.roomName ?? null;
      this.audit("clear-timeout", {
        target: player,
        table: request.roomId && roomName ? { id: request.roomId, name: roomName } : null,
        summary: `Removed the timeout on ${player.name} from ${request.scope === "site" ? "every table" : (roomName ?? "a table")}`,
      });
    });
  }

  // ---------- event log ----------

  /** Add an admin action to the event log. */
  private audit(
    action: AdminActionType,
    entry: {
      summary: string;
      target?: HumanPlayer | null;
      /** A room or a table snapshot: anything with an id and a name. */
      table?: { id: string; name: string } | null;
      bots?: string[];
      ok?: boolean;
      error?: string | null;
    },
  ) {
    const log = this.deps.eventLog;
    if (!log) return;
    const target = entry.target ? logPlayer(entry.target, true) : null;
    const table = entry.table ?? null;
    const game: GameType | null = !table
      ? null
      : this.deps.rooms.get(table.id)
        ? "poker"
        : this.deps.blackjack.get(table.id)
          ? "blackjack"
          : null;
    log.add({
      kind: "admin",
      game,
      table: table ? { id: table.id, name: table.name } : null,
      summary: entry.summary,
      players: [...(target ? [target] : []), ...(entry.bots ?? []).map((name) => ({ playerId: null, name, kind: "bot" as const }))],
      admin: { action, target, ok: entry.ok ?? true, error: entry.error ?? null },
    });
  }

  /**
   * Run an admin operation. If the server refuses it (an AdminError), the refusal is logged with the reason
   * before it goes back to the caller. `context` says what was asked for, for that log line.
   */
  private refusable<T>(
    action: AdminActionType,
    context: { playerId?: string; tableId?: string; table?: { id: string; name: string } | null; summary?: string },
    run: () => T,
  ): T {
    try {
      return run();
    } catch (error) {
      if (error instanceof AdminError) {
        const target = context.playerId ? (this.deps.registry.byPlayerId(context.playerId) ?? null) : null;
        let table: { id: string; name: string } | null = context.table ?? null;
        if (!table && context.tableId) table = this.deps.rooms.get(context.tableId) ?? this.deps.blackjack.get(context.tableId) ?? null;
        const what = [ADMIN_ACTION_LABEL[action], target?.name, context.summary].filter(Boolean).join(" ");
        this.audit(action, { target, table, summary: `Refused: ${what}. ${error.message}`, ok: false, error: error.message });
      }
      throw error;
    }
  }

  // ---------- helpers ----------

  private player(playerId: string): HumanPlayer {
    const player = this.deps.registry.byPlayerId(playerId);
    if (!player) throw new AdminError(404, "No player with that id.");
    return player;
  }

  private roomOf(player: HumanPlayer): PokerRoom | BlackjackRoom | undefined {
    return this.deps.rooms.roomOf(player) ?? this.deps.blackjack.roomOf(player);
  }

  private findTable(id: string): { game: "poker"; room: PokerRoom } | { game: "blackjack"; room: BlackjackRoom } {
    const poker = this.deps.rooms.get(id);
    if (poker) return { game: "poker", room: poker };
    const blackjack = this.deps.blackjack.get(id);
    if (blackjack) return { game: "blackjack", room: blackjack };
    throw new AdminError(404, "No table with that id.");
  }

  /** Off their table (queued mid-hand), with no table timeout: for bans and sitewide timeouts. */
  private leaveTable(player: HumanPlayer, message = "An admin removed you from the table.") {
    const room = this.roomOf(player);
    if (!room) return;
    room.kick(player, 0, message);
  }

  private minutes(value: number, allowZero: boolean): number {
    if (!Number.isFinite(value) || value < (allowZero ? 0 : 1) || value > 7 * 24 * 60) {
      throw new AdminError(400, `Minutes must be ${allowZero ? 0 : 1}–${7 * 24 * 60}.`);
    }
    return value;
  }
}
