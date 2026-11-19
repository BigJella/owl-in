import {
  ALLOWED_BIG_BLINDS,
  BJ_ALLOWED_MIN_BETS,
  BJ_BOT_SPOTS,
  POKER_MAX_SEATS,
  STARTING_BANKROLL,
  formatDD,
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
    if (!this.deps.rooms.setBotOverride(botId, mode === "auto" ? null : mode)) {
      throw new AdminError(404, "No poker bot with that id (blackjack bots have no AI mode yet).");
    }
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
    const player = this.player(playerId);
    const room = this.roomOf(player);
    if (!room) throw new AdminError(409, `${player.name} isn't at a table.`);
    room.kick(player, this.minutes(timeoutMinutes, true) * MINUTE);
    this.deps.publishLobby?.();
  }

  ban(playerId: string, reason: string | null): void {
    const player = this.player(playerId);
    this.deps.moderation.ban(player.id, reason);
    this.leaveTable(player);
    player.disconnectBanned(reason);
    this.deps.publishLobby?.();
  }

  unban(playerId: string): void {
    const player = this.player(playerId);
    if (!this.deps.moderation.unban(player.id)) throw new AdminError(409, `${player.name} isn't banned.`);
  }

  /** Give (positive) or take (negative) Dining Dollars. The house is the other side, so chips stay conserved. */
  adjustBankroll(playerId: string, delta: number): AdminPlayer {
    const player = this.player(playerId);
    if (!Number.isInteger(delta) || delta === 0) throw new AdminError(400, "Enter a whole, non-zero amount.");
    if (player.bankroll + delta < 0) throw new AdminError(400, `${player.name} only has ${formatDD(player.bankroll)} in their bankroll.`);
    player.bankroll += delta;
    this.deps.bank.withdraw(delta);
    player.sendSession();
    return this.players().find((p) => p.id === player.id)!;
  }

  rename(playerId: string, rawName: unknown): AdminPlayer {
    const player = this.player(playerId);
    const name = nameSchema.safeParse(rawName);
    if (!name.success) throw new AdminError(400, name.error.issues[0]?.message ?? "Invalid name.");
    if (this.deps.registry.nameTaken(player.token, name.data)) throw new AdminError(409, `"${name.data}" belongs to another player.`);
    this.deps.registry.identify(player.token, name.data);
    player.sendSession(); // the browser saves the new name from its session
    this.roomOf(player)?.refresh();
    return this.players().find((p) => p.id === player.id)!;
  }

  // ---------- timeouts ----------

  /** Add or replace a timeout. A player at the table (or anywhere, for sitewide) is removed from it. */
  setTimeout(request: { playerId: string; scope: TimeoutScope; roomId?: string | null; minutes: number; reason?: string | null }): void {
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
    const player = this.player(request.playerId);
    const removed =
      request.scope === "site"
        ? this.deps.moderation.clearSiteTimeout(player.id)
        : request.roomId
          ? this.deps.moderation.clearTableTimeout(request.roomId, player.id)
          : false;
    if (!removed) throw new AdminError(404, "No such timeout.");
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
