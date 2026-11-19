import type {
  LegalActions,
  PlayingCard,
  PokerAction,
  PokerEvent,
  PokerPhase,
  Pot,
} from "@owl-in/game-engine";

export type { LegalActions, PlayingCard, PokerAction, PokerEvent, PokerPhase, Pot };

export type PlayerKind = "human" | "bot";

/** How a bot decides: the deterministic rule-based script, or a Claude call (falls back to the script). */
export type BotMode = "script" | "llm";

/** One public betting action this hand, in order (blinds included). Same for every viewer. */
export interface HandActionEntry {
  street: Exclude<PokerPhase, "idle">;
  seat: number;
  name: string;
  action: "sb" | "bb" | "fold" | "check" | "call" | "bet" | "raise";
  /** Chips added by this action. */
  amount: number;
  /** The player's total bet on this street after the action. */
  betTo: number;
  allIn: boolean;
}

/** The currency: KSU Dining Dollars. Every amount in the UI goes through formatDD. */
export const CURRENCY_NAME = "Dining Dollars";
export const formatDD = (n: number) => `$${Math.round(n).toLocaleString("en-US")}`;

export const POKER_MAX_SEATS = 8;
export const BOT_FILL_TARGET = 4;
export const STARTING_BANKROLL = 10_000;
export const MIN_BUY_IN_BB = 20;
export const MAX_BUY_IN_BB = 100;
export const BOT_BUY_IN_BB = 60;
/** At tables with no humans, bot stacks above this are returned to the house between hands. */
export const BOT_MAX_STACK_BB = 200;
export const TIME_BANK_REFILL_MS = 20_000;
export const TIME_BANK_MAX_MS = 120_000;
export const ALLOWED_BIG_BLINDS = [10, 20, 50, 100, 200, 500] as const;
/** Tables at or above this big blind are badged "High Roller" (stakes, not chip count: bots never cash out). */
export const HIGH_ROLLER_MIN_BIG_BLIND = 100;

/** What the table is doing right now, for display. */
export type TableStage = "waiting" | "preflop" | "flop" | "turn" | "river" | "showdown" | "hand-over";

export const STAGE_LABEL: Record<TableStage, string> = {
  waiting: "Waiting for players",
  preflop: "Pre-flop",
  flop: "Flop",
  turn: "Turn",
  river: "River",
  showdown: "Showdown",
  "hand-over": "Hand over",
};

export interface PokerRoomSummary {
  id: string;
  name: string;
  smallBlind: number;
  bigBlind: number;
  maxSeats: number;
  humans: number;
  bots: number;
  /** Humans queued for the next hand. */
  waiting: number;
  /** Seated humans who are cashing out after this hand (their seats will be free next hand). */
  cashingOut: number;
  /** Every chip at the table: stacks, bets and pots. */
  chipsOnTable: number;
  highRoller: boolean;
  /** What the table is doing right now (shown as a column in the room list). */
  stage: TableStage;
}

export type SeatStatus = "waiting" | "active" | "folded" | "allIn";

export interface PokerSeatView {
  seat: number;
  playerId: string;
  name: string;
  kind: PlayerKind;
  /** Bots only: script or LLM (shown as a BOT / AI tag). */
  botMode: BotMode | null;
  stack: number;
  /** Chips in front of the player on this street. */
  bet: number;
  /** Total chips this player has put in the pot this hand (all streets). */
  contributed: number;
  /** Their most recent action this street, e.g. "Call 20" (folds and all-ins stick for the hand). */
  lastAction: string | null;
  isButton: boolean;
  blind: "SB" | "BB" | null;
  status: SeatStatus;
  connected: boolean;
  /** Holding face-down cards in the current hand. */
  hasCards: boolean;
  /** Face-up cards, only after a showdown. */
  revealedCards: PlayingCard[] | null;
  revealedHand: string | null;
  /** Remaining clock in ms (live value while it is this seat's turn). Always 0 for bots. */
  timeBankMs: number;
  /** Between hands at tables with humans: has this human readied up? null for bots / during hands. */
  ready: boolean | null;
  /** Busted between hands and deciding whether to buy back in. */
  rebuying: boolean;
  leaving: boolean;
  /** Cashing out: this is their last hand (shown to everyone; can't be undone). */
  cashingOut: boolean;
}

/** How the leave button behaves for you right now. */
export type LeaveMode = "now" | "after-hand" | "queued";

/** One player's view of a table. Never contains anyone else's hidden cards. */
export interface PokerTableView {
  roomId: string;
  name: string;
  smallBlind: number;
  bigBlind: number;
  handId: number;
  phase: PokerPhase;
  /** Like `phase`, but also says how the last hand ended while between hands. */
  stage: TableStage;
  button: number;
  toAct: number | null;
  /** Ms left on the acting human's clock when this view was sent (null on bot turns: bots have no clock). */
  turnRemainingMs: number | null;
  /** Between hands with humans: ms until un-ready players' clocks start draining. */
  readyGraceRemainingMs: number | null;
  /** "now" between hands, "after-hand" while you're in a hand, "queued" once you've asked to cash out. */
  leaveMode: LeaveMode;
  /** You're out of chips between hands: buy back in (min..max) or leave within remainingMs. */
  rebuy: { remainingMs: number; min: number; max: number } | null;
  /** Ms until the next hand starts, when between hands. */
  nextHandInMs: number | null;
  community: PlayingCard[];
  pots: Pot[];
  currentBet: number;
  /** Every betting action of the current (or just finished) hand. Public info only. */
  handActions: HandActionEntry[];
  seats: (PokerSeatView | null)[];
  mySeat: number | null;
  myHoleCards: PlayingCard[];
  myLegalActions: LegalActions | null;
  /** Names of humans waiting to be dealt in at the next hand. */
  waitingList: string[];
  amWaiting: boolean;
}

type ActedEvent = Extract<PokerEvent, { type: "playerActed" }>;

/** Human-readable label for an action, shared by server and client. */
export function describeAction(e: ActedEvent): string {
  if (e.allIn && e.amount > 0) return `All-in ${formatDD(e.bet)}`;
  switch (e.action) {
    case "fold":
      return "Fold";
    case "check":
      return "Check";
    case "call":
      return `Call ${formatDD(e.amount)}`;
    case "bet":
      return `Bet ${formatDD(e.bet)}`;
    case "raise":
      return `Raise to ${formatDD(e.bet)}`;
  }
}

export interface PokerStateMessage {
  view: PokerTableView;
  /** Events since the previous message, for animation. Empty for plain refreshes. */
  events: PokerEvent[];
  seq: number;
}
