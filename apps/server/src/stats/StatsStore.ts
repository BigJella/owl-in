import type {
  BlackjackRoundRecord,
  BlackjackStats,
  GameType,
  HandRecord,
  PokerHandRecord,
  PokerStats,
  SessionEndReason,
  TableSession,
} from "@owl-in/shared";

export interface SessionStart {
  game: GameType;
  roomId: string;
  roomName: string;
  stakes: string;
  /** Poker buy-in (null for blackjack, which bets straight from the bankroll). */
  buyIn: number | null;
}

export interface CareerTotals {
  poker: PokerStats;
  blackjack: BlackjackStats;
  sessions: TableSession[];
}

/**
 * Where career stats and hand history live. Rooms report sessions and finished hands; the career page reads them back.
 * The only implementation today keeps everything in memory (like bankrolls); a SQLite one can replace it later.
 */
export interface StatsStore {
  /** A player sat down at (or queued for) a table. Returns the session id. */
  openSession(playerId: string, start: SessionStart): string;
  /** Poker rebuy: more chips brought to the same table. */
  addBuyIn(sessionId: string, amount: number): void;
  closeSession(sessionId: string, end: { cashOut: number | null; reason: SessionEndReason }): void;
  /** `showdown.reached`: went to showdown; `showdown.won`: and won (or shared) a pot there. */
  recordPokerHand(playerId: string, record: PokerHandRecord, showdown: { reached: boolean; won: boolean }): void;
  recordBlackjackRound(playerId: string, record: BlackjackRoundRecord): void;
  career(playerId: string): CareerTotals;
  sessionHands(playerId: string, sessionId: string): HandRecord[];
}
