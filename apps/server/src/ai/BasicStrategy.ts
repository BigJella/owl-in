import { handTotal, isPair, rankValue, type PlayingCard } from "@owl-in/game-engine";
import type { BlackjackAction, BlackjackLegal, BlackjackTableView } from "@owl-in/shared";
import type { BlackjackStrategy } from "./BlackjackStrategy";

type Move = "H" | "S" | "D" | "Ds" | "P" | "R";

/**
 * Textbook basic strategy for 6 decks, dealer stands on soft 17, double after split, late surrender.
 * `dealer` is the upcard value 2..11 (ace = 11). Returns H(it), S(tand), D(ouble else hit),
 * Ds (double else stand), P(split), R (surrender else hit).
 */
export function basicMove(cards: readonly PlayingCard[], dealer: number, legal: BlackjackLegal): BlackjackAction {
  const move = chartMove(cards, dealer, legal);
  switch (move) {
    case "P":
      return "split";
    case "R":
      return legal.surrender ? "surrender" : chartMove(cards, dealer, { ...legal, surrender: false, split: false }) === "S" ? "stand" : "hit";
    case "D":
      return legal.double ? "double" : "hit";
    case "Ds":
      return legal.double ? "double" : "stand";
    case "H":
      return "hit";
    case "S":
      return "stand";
  }
}

function chartMove(cards: readonly PlayingCard[], d: number, legal: BlackjackLegal): Move {
  const { total, soft } = handTotal(cards);
  const between = (lo: number, hi: number) => d >= lo && d <= hi;

  // Late surrender (S17): hard 16 vs 9/10/A, hard 15 vs 10. Never 8,8.
  if (legal.surrender && !soft && !(isPair(cards) && cards[0]!.rank === "8")) {
    if (total === 16 && d >= 9) return "R";
    if (total === 15 && d === 10) return "R";
  }

  if (legal.split && isPair(cards)) {
    const v = rankValue(cards[0]!.rank);
    if (v === 1 || v === 8) return "P";
    if (v === 9 && (between(2, 6) || d === 8 || d === 9)) return "P";
    if (v === 7 && between(2, 7)) return "P";
    if (v === 6 && between(2, 6)) return "P";
    if (v === 4 && between(5, 6)) return "P";
    if ((v === 2 || v === 3) && between(2, 7)) return "P";
  }

  if (soft) {
    if (total >= 19) return "S";
    if (total === 18) return between(3, 6) ? "Ds" : d <= 8 ? "S" : "H";
    if (total === 17) return between(3, 6) ? "D" : "H";
    if (total === 15 || total === 16) return between(4, 6) ? "D" : "H";
    return between(5, 6) ? "D" : "H"; // soft 13-14
  }

  if (total >= 17) return "S";
  if (total >= 13) return d <= 6 ? "S" : "H";
  if (total === 12) return between(4, 6) ? "S" : "H";
  if (total === 11) return d <= 10 ? "D" : "H";
  if (total === 10) return d <= 9 ? "D" : "H";
  if (total === 9) return between(3, 6) ? "D" : "H";
  return "H";
}

/** Plays basic strategy, flat-bets a fixed unit (1-3 × the minimum), never takes insurance. */
export class BasicStrategy implements BlackjackStrategy {
  readonly name = "basic";
  private readonly units: number;

  constructor(random: () => number = Math.random) {
    this.units = 1 + Math.floor(random() * 3);
  }

  bet(view: BlackjackTableView): number {
    return Math.min(view.maxBet, view.minBet * this.units);
  }

  insurance(): boolean {
    return false;
  }

  async decide(view: BlackjackTableView): Promise<BlackjackAction> {
    const legal = view.myLegal;
    const ref = view.toAct;
    const up = view.dealer.cards[0];
    const hand = ref ? view.spots[ref.spot]?.hands[ref.hand] : undefined;
    if (!legal || !hand || !up) return "stand";
    const dealer = up.rank === "A" ? 11 : rankValue(up.rank);
    return basicMove(hand.cards, dealer, legal);
  }
}
