import type { HandResult } from "./blackjack";
import type { PokerHandResult } from "./career";
import type { BotMode, PlayerKind, PlayingCard } from "./poker";
import type { GameType } from "./types";

/**
 * Management API types (`/api/admin/*`, localhost only). Used by the admin panel, the itcan.do bridge and curl.
 * Nothing here ever carries hidden cards, browser tokens or IP addresses.
 */

/** Per-table bot settings. Poker: maxBots 0–8 (default 4), maxAi 0–maxBots (default 2). Blackjack: maxBots 0–3, maxAi null. */
export interface TableSettings {
  maxBots: number;
  /** LLM bots wanted at the table (null: this game has no LLM bots yet). */
  maxAi: number | null;
}

export const DEFAULT_MAX_BOTS = 4;
export const DEFAULT_MAX_AI = 2;

export interface AdminSeat {
  /** Poker seat index, or blackjack spot index (0 = spot 1). */
  seat: number;
  playerId: string;
  name: string;
  kind: PlayerKind;
  /** Poker: chips in front of them. Blackjack: null (bets come from the bankroll). */
  stack: number | null;
  /** Poker: bet this street. Blackjack: this spot's bet. */
  bet: number;
  /** Poker: active / folded / allIn / waiting. Blackjack: betting / playing / done. */
  status: string;
  /** Bots that can be switched between script and LLM (poker bots). */
  aiCapable: boolean;
  /** Effective mode of a poker bot (null for humans and blackjack bots). */
  botMode: BotMode | null;
  /** Set when an admin pinned this bot's mode; null = follows the table's AI count. */
  botOverride: BotMode | null;
  connected: boolean;
  /** Last action (poker) or the spot's result label (blackjack). */
  lastAction: string | null;
}

export interface AdminTable {
  id: string;
  game: GameType;
  name: string;
  /** "$5/$10" (poker blinds) or "$10–$500" (blackjack limits). */
  stakes: string;
  /** Human-readable stage ("Flop", "Betting", ...). */
  stage: string;
  /** Hand (poker) or round (blackjack) number. */
  handId: number;
  /** Closes when the current hand / round ends. */
  closing: boolean;
  humans: number;
  bots: number;
  /** LLM-mode bots seated now. */
  aiBots: number;
  waiting: number;
  /** All Dining Dollars at this table (stacks, bets, pots / stakes on the felt). */
  chips: number;
  /** Poker: pot this hand (collected + current bets). */
  pot: number;
  settings: TableSettings;
  seats: AdminSeat[];
}

export interface AdminPlayer {
  id: string;
  name: string;
  online: boolean;
  bankroll: number;
  /** Chips at a poker table (stack or queued buy-in). */
  atTable: number;
  /** bankroll + atTable (what the leaderboard ranks by). */
  total: number;
  table: { id: string; name: string; game: GameType } | null;
  banned: { at: number; reason: string | null } | null;
  /** Sitewide timeout, if any. */
  timeout: { until: number; reason: string | null } | null;
  /** Active per-table timeouts. */
  tableTimeouts: number;
}

export type TimeoutScope = "table" | "site";

export interface AdminTimeout {
  playerId: string;
  playerName: string;
  scope: TimeoutScope;
  /** Per-table timeouts only. */
  roomId: string | null;
  roomName: string | null;
  until: number;
  remainingMs: number;
  reason: string | null;
}

export interface LlmDecision {
  at: number;
  table: string;
  bot: string;
  handId: number;
  /** "fold", "call", "raise to $60", ... */
  action: string;
  ms: number;
  costUsd: number | null;
  /** Why the script decided instead (null: the model decided). */
  fallback: string | null;
}

export interface LlmStats {
  /** The Claude CLI was found at startup. */
  available: boolean;
  model: string;
  calls: number;
  fallbacks: number;
  fallbackReasons: Record<string, number>;
  avgMs: number;
  p95Ms: number;
  totalCostUsd: number;
  /** Newest first. */
  recent: LlmDecision[];
}

export interface AdminTotals {
  bankrolls: number;
  house: number;
  onPokerTables: number;
  onBlackjackTables: number;
  /** Everything above added up. */
  total: number;
  /** House start + every player's starting bankroll. `total` must always equal this. */
  expected: number;
  conserved: boolean;
  playersKnown: number;
  playersOnline: number;
  /** Seated or waiting at any table. */
  playersAtTables: number;
  banned: number;
  pokerTables: number;
  blackjackTables: number;
}

export interface AdminSnapshot {
  at: number;
  totals: AdminTotals;
  tables: AdminTable[];
  players: AdminPlayer[];
  timeouts: AdminTimeout[];
  llm: LlmStats;
}

/** GET /api/admin/network: this computer's LAN addresses, for the presentation's "join at http://<ip>:5173" slide. */
export interface AdminNetwork {
  /** Non-internal IPv4 addresses, the likeliest LAN address first (private ranges first, virtual adapters last). */
  addresses: string[];
  /** The player site's port (Vite dev server). */
  clientPort: number;
}

// ---------- Event log (the admin panel's Logging tab, GET /api/admin/log) ----------

export type AdminLogKind = "hand" | "llm" | "admin";
export const ADMIN_LOG_KINDS: AdminLogKind[] = ["hand", "llm", "admin"];
export const ADMIN_LOG_KIND_LABEL: Record<AdminLogKind, string> = { hand: "Hands", llm: "AI decisions", admin: "Admin actions" };

/** A player mentioned by a log entry. `playerId` is set for humans only (their career can be opened). */
export interface AdminLogPlayer {
  playerId: string | null;
  name: string;
  kind: PlayerKind;
}

export interface PokerHandLog {
  game: "poker";
  handId: number;
  stakes: string;
  board: PlayingCard[];
  pot: number;
  seats: {
    seat: number;
    player: AdminLogPlayer;
    position: "D" | "SB" | "BB" | null;
    wagered: number;
    /** Profit or loss for the hand. */
    net: number;
    result: PokerHandResult;
    lastAction: string | null;
    showdownHand: string | null;
    /** Only cards shown at a showdown (never hidden ones). */
    shown: PlayingCard[] | null;
  }[];
}

export interface BlackjackRoundLog {
  game: "blackjack";
  roundId: number;
  stakes: string;
  dealer: { cards: PlayingCard[]; total: number };
  spots: {
    /** 0 = spot 1. */
    spot: number;
    player: AdminLogPlayer;
    insurance: number;
    insurancePayout: number;
    hands: { cards: PlayingCard[]; bet: number; doubled: boolean; split: boolean; result: HandResult; payout: number }[];
    /** Profit or loss for the round (all hands and insurance). */
    net: number;
  }[];
}

export interface LlmLog {
  bot: AdminLogPlayer;
  handId: number;
  /** "fold", "call", "raise to $60", ... */
  action: string;
  ms: number;
  costUsd: number | null;
  /** Why the script decided instead (null: the model decided). */
  fallback: string | null;
}

export type AdminActionType =
  | "create-table"
  | "update-table"
  | "close-table"
  | "bot-mode"
  | "kick"
  | "ban"
  | "unban"
  | "bankroll"
  | "rename"
  | "timeout"
  | "clear-timeout";

export const ADMIN_ACTION_LABEL: Record<AdminActionType, string> = {
  "create-table": "Create table",
  "update-table": "Table settings",
  "close-table": "Close table",
  "bot-mode": "Bot mode",
  kick: "Kick",
  ban: "Ban",
  unban: "Unban",
  bankroll: "Bankroll",
  rename: "Rename",
  timeout: "Timeout",
  "clear-timeout": "Remove timeout",
};

export interface AdminActionLog {
  action: AdminActionType;
  /** The player it was about, if any. */
  target: AdminLogPlayer | null;
  /** false: the server refused it (`error` says why). */
  ok: boolean;
  error: string | null;
}

export interface AdminLogEntry {
  /** Increases with every entry (use it to page: `before` / `after`). */
  id: number;
  at: number;
  kind: AdminLogKind;
  game: GameType | null;
  table: { id: string; name: string } | null;
  /** One line, e.g. "Hand #12 · pot $340 · Ada won $170 (Two Pair)". */
  summary: string;
  /** Everyone the entry mentions (clickable when they're human). */
  players: AdminLogPlayer[];
  hand?: PokerHandLog | BlackjackRoundLog;
  llm?: LlmLog;
  admin?: AdminActionLog;
}

export interface AdminLogQuery {
  kinds?: AdminLogKind[];
  game?: GameType;
  tableId?: string;
  playerId?: string;
  /** Case-insensitive match on the summary, table and player names. */
  q?: string;
  /** Hands only: skip hands no human played. */
  humansOnly?: boolean;
  /** Entries older than this id (paging back). */
  before?: number;
  /** Entries newer than this id (polling for new ones). */
  after?: number;
  /** Default 100, max 500. */
  limit?: number;
}

export interface AdminLogPage {
  /** Newest first. */
  entries: AdminLogEntry[];
  /** Older matching entries exist beyond this page. */
  more: boolean;
  /** Entries held right now, by kind (before filtering). */
  counts: Record<AdminLogKind, number>;
}
