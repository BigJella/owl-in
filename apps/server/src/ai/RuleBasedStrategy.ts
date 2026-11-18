import { evaluateHand, RANKS, type PlayingCard } from "@owl-in/game-engine";
import type { PokerAction, PokerTableView } from "@owl-in/shared";
import { legalize, potSize, type PokerStrategy } from "./PokerStrategy";

/** 2 = lowest ... 14 = ace. */
const value = (card: PlayingCard) => (card.rank === "A" ? 14 : RANKS.indexOf(card.rank) + 1);

/** Small deterministic PRNG so the same spot always produces the same decision. */
function seeded(...parts: number[]) {
  let h = 2166136261;
  for (const part of parts) h = Math.imul(h ^ part, 16777619);
  return () => {
    h = Math.imul(h ^ (h >>> 15), 2246822507);
    h = Math.imul(h ^ (h >>> 13), 3266489909);
    return ((h ^= h >>> 16) >>> 0) / 2 ** 32;
  };
}

/** 0..1 preflop strength from pair / high cards / suitedness / connectedness. */
export function preflopScore([a, b]: PlayingCard[]): number {
  if (!a || !b) return 0;
  const [hi, lo] = [Math.max(value(a), value(b)), Math.min(value(a), value(b))];
  let score = hi / 14;
  if (hi === lo) score = 0.55 + (hi / 14) * 0.45;
  if (a.suit === b.suit) score += 0.08;
  const gap = hi - lo;
  if (gap === 1) score += 0.06;
  else if (gap === 2) score += 0.03;
  score += (lo / 14) * 0.15;
  return Math.min(1, score);
}

/**
 * Deterministic tight-aggressive-ish bot. Good enough to keep chips moving
 * and be beatable; the LLM strategy will replace it.
 */
export class RuleBasedStrategy implements PokerStrategy {
  readonly name = "rule-based";

  constructor(private readonly aggression = 1) {}

  async decide(view: PokerTableView): Promise<PokerAction> {
    return legalize(view, this.choose(view));
  }

  private choose(view: PokerTableView): PokerAction {
    const legal = view.myLegalActions;
    if (!legal || view.mySeat === null) return { type: "fold" };
    const rng = seeded(view.handId, view.mySeat, view.community.length, view.currentBet);
    const pot = potSize(view);
    const toCall = legal.callAmount;
    const bb = view.bigBlind;
    const raiseTo = (amount: number) => ({ type: "raise", to: view.currentBet + amount }) as const;

    if (view.phase === "preflop") {
      const score = preflopScore(view.myHoleCards) * this.aggression;
      if (score > 0.85) return raiseTo(Math.max(bb * 3, view.currentBet * 2));
      if (score > 0.7) return toCall <= bb * 4 ? (rng() < 0.4 ? raiseTo(bb * 2) : { type: "call" }) : { type: "fold" };
      if (score > 0.55) return toCall <= bb * 2 ? { type: "call" } : { type: "fold" };
      return legal.canCheck ? { type: "check" } : rng() < 0.08 && toCall <= bb ? { type: "call" } : { type: "fold" };
    }

    const strength = evaluateHand([...view.myHoleCards, ...view.community]).rank;
    const potOdds = toCall / Math.max(1, pot + toCall);

    if (strength >= 4) return raiseTo(Math.max(bb, Math.round(pot * 0.75)));
    if (strength === 3) return legal.canCheck ? raiseTo(Math.max(bb, Math.round(pot * 0.5))) : { type: "call" };
    if (strength === 2) {
      if (legal.canCheck) return rng() < 0.5 ? raiseTo(Math.max(bb, Math.round(pot / 3))) : { type: "check" };
      return potOdds < 0.3 ? { type: "call" } : { type: "fold" };
    }
    // High card: occasional bluff when checked to, otherwise give up.
    if (legal.canCheck) return rng() < 0.12 * this.aggression ? raiseTo(Math.max(bb, Math.round(pot / 2))) : { type: "check" };
    return potOdds < 0.12 ? { type: "call" } : { type: "fold" };
  }
}
