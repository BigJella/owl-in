import type { PokerAction, PokerTableView } from "@owl-in/shared";

/**
 * A bot's brain. Gets the same view a human in that seat would see (own hole cards
 * plus public information), so swapping in an LLM can't leak hidden cards.
 */
export interface PokerStrategy {
  readonly name: string;
  decide(view: PokerTableView, signal: AbortSignal): Promise<PokerAction>;
}

/** Clamp a desired raise into the legal range, or fall back to calling. */
export function legalize(view: PokerTableView, action: PokerAction): PokerAction {
  const legal = view.myLegalActions;
  if (!legal) return { type: "fold" };
  switch (action.type) {
    case "check":
      return legal.canCheck ? action : { type: "fold" };
    case "fold":
      return legal.canCheck ? { type: "check" } : action; // never fold for free
    case "call":
      return action;
    case "raise":
      if (!legal.canRaise) return { type: "call" };
      return { type: "raise", to: Math.min(legal.maxRaiseTo, Math.max(legal.minRaiseTo, Math.round(action.to))) };
  }
}

export function potSize(view: PokerTableView): number {
  return view.pots.reduce((sum, p) => sum + p.amount, 0) + view.seats.reduce((sum, s) => sum + (s?.bet ?? 0), 0);
}
