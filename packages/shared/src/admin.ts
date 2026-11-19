import type { BotMode, PlayerKind } from "./poker";
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
