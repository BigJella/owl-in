import type { PlayingCard, Rank } from "../cards/Deck";

/** Blackjack value of a rank, with aces as 1 (soft totals add 10 when that doesn't bust). */
export function rankValue(rank: Rank): number {
  if (rank === "A") return 1;
  if (rank === "J" || rank === "Q" || rank === "K") return 10;
  return Number(rank);
}

/** Best total, and whether an ace is being counted as 11 ("soft"). */
export function handTotal(cards: readonly PlayingCard[]): { total: number; soft: boolean } {
  let total = 0;
  let aces = 0;
  for (const { rank } of cards) {
    total += rankValue(rank);
    if (rank === "A") aces += 1;
  }
  if (aces > 0 && total + 10 <= 21) return { total: total + 10, soft: true };
  return { total, soft: false };
}

/** Best blackjack total for a hand, counting aces as 11 when it doesn't bust. */
export function handValue(cards: readonly PlayingCard[]): number {
  return handTotal(cards).total;
}

/** A two-card 21. (After a split, 21 is just 21: the table tracks that separately.) */
export function isNatural(cards: readonly PlayingCard[]): boolean {
  return cards.length === 2 && handTotal(cards).total === 21;
}

/** Two cards of equal value (10-J-Q-K all count as tens). */
export function isPair(cards: readonly PlayingCard[]): boolean {
  return cards.length === 2 && rankValue(cards[0]!.rank) === rankValue(cards[1]!.rank);
}
