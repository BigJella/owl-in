import type { HandResult, PlayingCard } from "@owl-in/game-engine";
import type { GameType } from "./types";

/** Poker career totals. Every amount is in Dining Dollars. */
export interface PokerStats {
  hands: number;
  won: number;
  lost: number;
  /** Shared a pot (chopped) and lost none outright. */
  splitPot: number;
  folded: number;
  showdowns: number;
  showdownsWon: number;
  /** Chips put into pots. */
  wagered: number;
  /** Chips collected from pots (your own share back included). */
  returned: number;
  net: number;
  /** Net against other humans / against bots (they add up to `net`). */
  netVsPlayers: number;
  netVsBots: number;
}

/** Blackjack career totals. Outcome counts are per hand (a split makes two hands). All money is vs the house. */
export interface BlackjackStats {
  rounds: number;
  hands: number;
  wins: number;
  losses: number;
  pushes: number;
  blackjacks: number;
  busts: number;
  /** Rounds in which you split at least once (the Split rate is per round). */
  splits: number;
  doubles: number;
  surrenders: number;
  /** Rounds in which you took insurance on at least one spot. */
  insurances: number;
  wagered: number;
  returned: number;
  net: number;
}

export type SessionEndReason = "left" | "busted" | "removed" | "table closed";

/** One visit to one table, from joining to leaving. */
export interface TableSession {
  id: string;
  game: GameType;
  roomId: string;
  roomName: string;
  /** "$5/$10" or "$10–$500". */
  stakes: string;
  joinedAt: number;
  /** null while still at the table. */
  leftAt: number | null;
  /** Poker only: what you sat down with and walked away with. */
  buyIn: number | null;
  cashOut: number | null;
  hands: number;
  wagered: number;
  net: number;
  endReason: SessionEndReason | null;
}

export type PokerHandResult = "won" | "lost" | "split" | "folded";

export interface PokerHandRecord {
  game: "poker";
  sessionId: string;
  handId: number;
  at: number;
  /** null when someone else views your history and the cards were never shown at showdown. */
  holeCards: PlayingCard[] | null;
  board: PlayingCard[];
  /** "D", "SB", "BB" or null. */
  position: string | null;
  /** Your last action of the hand, e.g. "Call $20". */
  lastAction: string | null;
  /** Your hand at showdown ("Two Pair, K's & 8's"), if you went to one. */
  showdownHand: string | null;
  pot: number;
  wagered: number;
  returned: number;
  net: number;
  result: PokerHandResult;
  vsPlayers: number;
  vsBots: number;
}

export interface BlackjackRoundRecord {
  game: "blackjack";
  sessionId: string;
  roundId: number;
  at: number;
  dealer: { cards: PlayingCard[]; total: number };
  spots: {
    spot: number;
    insurance: number;
    insurancePayout: number;
    hands: { cards: PlayingCard[]; bet: number; doubled: boolean; split: boolean; result: HandResult; payout: number }[];
  }[];
  wagered: number;
  returned: number;
  net: number;
}

export type HandRecord = PokerHandRecord | BlackjackRoundRecord;

/** One point per finished hand / round: the player's total Dining Dollars right after it. */
export interface ChipPoint {
  /** 1 for the player's first hand (the line starts at 0 = the starting bankroll). */
  hand: number;
  at: number;
  game: GameType;
  net: number;
  total: number;
}

export interface CareerView {
  playerId: string;
  name: string;
  isPublic: boolean;
  /** You're looking at your own career. */
  isMe: boolean;
  bankroll: number;
  online: boolean;
  wagered: number;
  net: number;
  poker: PokerStats;
  blackjack: BlackjackStats;
  /** Newest first. */
  sessions: TableSession[];
  /** Total Dining Dollars after every hand, oldest first (the most recent 5,000). */
  chipHistory: ChipPoint[];
}

export interface LeaderboardRow {
  rank: number;
  playerId: string;
  name: string;
  bankroll: number;
  online: boolean;
  isPublic: boolean;
  isMe: boolean;
}

export const emptyPokerStats = (): PokerStats => ({
  hands: 0,
  won: 0,
  lost: 0,
  splitPot: 0,
  folded: 0,
  showdowns: 0,
  showdownsWon: 0,
  wagered: 0,
  returned: 0,
  net: 0,
  netVsPlayers: 0,
  netVsBots: 0,
});

export const emptyBlackjackStats = (): BlackjackStats => ({
  rounds: 0,
  hands: 0,
  wins: 0,
  losses: 0,
  pushes: 0,
  blackjacks: 0,
  busts: 0,
  splits: 0,
  doubles: 0,
  surrenders: 0,
  insurances: 0,
  wagered: 0,
  returned: 0,
  net: 0,
});
