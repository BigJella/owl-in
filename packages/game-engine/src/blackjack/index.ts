import type { PlayingCard } from "../cards/Deck";

/** Best blackjack total for a hand, counting aces as 11 when it doesn't bust. */
export function handValue(cards: readonly PlayingCard[]): number {
  let total = 0;
  let aces = 0;
  for (const { rank } of cards) {
    if (rank === "A") {
      aces += 1;
      total += 11;
    } else if (rank === "J" || rank === "Q" || rank === "K") {
      total += 10;
    } else {
      total += Number(rank);
    }
  }
  while (total > 21 && aces > 0) {
    total -= 10;
    aces -= 1;
  }
  return total;
}

// TODO: BlackjackGame state machine (betting -> dealing -> player turns -> dealer -> settle).
