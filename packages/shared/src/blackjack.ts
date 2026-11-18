import type {
  BlackjackAction,
  BlackjackEvent,
  BlackjackLegal,
  HandRef,
  HandResult,
  HandStatus,
  PlayingCard,
} from "@owl-in/game-engine";
import { formatDD, type LeaveMode, type PlayerKind } from "./poker";

export type { BlackjackAction, BlackjackEvent, BlackjackLegal, HandRef, HandResult, HandStatus };

export const BJ_SPOTS = 7;
export const BJ_MAX_SPOTS_PER_PLAYER = 3;
/** Bots only ever sit in the first spots (1-3), and only when no human wants them. */
export const BJ_BOT_SPOTS = 3;
export const BJ_DECKS = 6;
export const BJ_PENETRATION = 0.75;
/** Table max = this × the minimum: a wide spread, no questions asked. */
export const BJ_MAX_BET_MULT = 50;
export const BJ_ALLOWED_MIN_BETS = [10, 25, 50, 100, 500] as const;
/** Minimums at or above this are badged "High Roller". */
export const BJ_HIGH_ROLLER_MIN_BET = 100;
/** Time bank: +30s when the turn passes to you from someone else, +5s for each further decision of yours, max 60s. */
export const BJ_TURN_REFILL_MS = 30_000;
export const BJ_DECISION_REFILL_MS = 5_000;
export const BJ_TIME_BANK_MAX_MS = 60_000;

export type BlackjackStage = "waiting" | "betting" | "insurance" | "playing" | "settled";

export const BJ_STAGE_LABEL: Record<BlackjackStage, string> = {
  waiting: "Waiting",
  betting: "Place bets",
  insurance: "Insurance",
  playing: "Playing",
  settled: "Round over",
};

export const BJ_ACTION_LABEL: Record<BlackjackAction, string> = {
  hit: "Hit",
  stand: "Stand",
  double: "Double",
  split: "Split",
  surrender: "Surrender",
};

export const BJ_RESULT_LABEL: Record<HandResult, string> = {
  win: "Win",
  lose: "Lose",
  push: "Push",
  blackjack: "Blackjack",
  surrender: "Surrender",
};

export interface BlackjackHandView {
  cards: PlayingCard[];
  bet: number;
  doubled: boolean;
  total: number;
  soft: boolean;
  status: HandStatus;
  result: HandResult | null;
  payout: number;
}

export interface BlackjackSpotView {
  spot: number;
  playerId: string;
  name: string;
  kind: PlayerKind;
  /** The bet on this spot (placed during betting, or the round's original bet). */
  bet: number;
  hands: BlackjackHandView[];
  /** Insurance stake (null = not offered / undecided, 0 = declined). */
  insurance: number | null;
  /** During betting, has this human pressed Deal? null for bots / outside betting. */
  ready: boolean | null;
  connected: boolean;
  /** Leaving once this round ends. */
  leaving: boolean;
  /** The player is giving up this spot once this round ends. */
  releasing: boolean;
}

export interface BlackjackTableView {
  roomId: string;
  name: string;
  minBet: number;
  maxBet: number;
  roundId: number;
  stage: BlackjackStage;
  spots: (BlackjackSpotView | null)[];
  /** Hole card is null until the dealer turns it over. `total` counts only face-up cards. */
  dealer: { cards: (PlayingCard | null)[]; total: number | null; soft: boolean };
  toAct: HandRef | null;
  /** Ms left on the acting human's clock (null on bot turns). */
  turnRemainingMs: number | null;
  /** Ms left for betting or insurance, when that window is open. */
  phaseRemainingMs: number | null;
  /** Bot-only tables: ms until the next round. */
  nextRoundInMs: number | null;
  /**
   * How full the shoe and the discard tray are, as fractions of the whole shoe, rounded to the nearest
   * quarter deck (players estimate decks left from these, like reading a real discard tray).
   */
  shoe: { decks: number; level: number; tray: number };
  // ---- personal ----
  mySpots: number[];
  myBankroll: number;
  /** Live: drains while you hold up betting on your bank. */
  myTimeBankMs: number;
  /**
   * You had a bet last round and haven't pressed Deal: "window" while the betting window runs,
   * then "bank" while bets stay open on your time bank. null otherwise.
   */
  myBettingClock: "window" | "bank" | null;
  /** Betting window over: players whose time banks are keeping bets open. */
  waitingFor: string[];
  /** Your legal actions when one of your hands is up (double/split only if you can afford them). */
  myLegal: BlackjackLegal | null;
  /** Insurance decision for your hands: total cost to insure them all. */
  myInsurance: { spots: number[]; cost: number } | null;
  /** Last round's bets, for Rebet. */
  myLastBets: { spot: number; amount: number }[];
  amReady: boolean;
  leaveMode: LeaveMode;
  /** Humans at the table (playing or watching). */
  members: number;
}

export interface BlackjackRoomSummary {
  id: string;
  name: string;
  minBet: number;
  maxBet: number;
  /** Humans at the table (playing or watching). */
  humans: number;
  bots: number;
  /** Spot owners in spot order: "human" | "bot" | null. */
  spots: (PlayerKind | null)[];
  stage: BlackjackStage;
  highRoller: boolean;
}

export interface BlackjackStateMessage {
  view: BlackjackTableView;
  events: BlackjackEvent[];
  seq: number;
}

/** "Double $50", "Split", ... */
export function describeBlackjackAction(action: BlackjackAction, amount: number): string {
  return amount > 0 && (action === "double" || action === "split")
    ? `${BJ_ACTION_LABEL[action]} ${formatDD(amount)}`
    : BJ_ACTION_LABEL[action];
}
