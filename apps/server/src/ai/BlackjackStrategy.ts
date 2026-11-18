import type { BlackjackAction, BlackjackTableView } from "@owl-in/shared";

/**
 * A blackjack bot's brain. Gets exactly the view a human in its spot would see
 * (never the dealer's hole card or the shoe order).
 */
export interface BlackjackStrategy {
  readonly name: string;
  /** Bet for the coming round, for one spot. */
  bet(view: BlackjackTableView): number;
  /** Take insurance on this spot's hand? */
  insurance(view: BlackjackTableView): boolean;
  /** Decide for the hand that is up (view.toAct is one of this bot's spots). */
  decide(view: BlackjackTableView, signal: AbortSignal): Promise<BlackjackAction>;
}
