/// <reference path="./pokersolver.d.ts" />
import pokersolver from "pokersolver";
import type { PlayingCard } from "../cards/Deck";

const { Hand } = pokersolver;
type SolvedHand = InstanceType<typeof Hand>;

const SUIT_CODE = { hearts: "h", diamonds: "d", clubs: "c", spades: "s" } as const;

export function toSolverCard(card: PlayingCard): string {
  return `${card.rank === "10" ? "T" : card.rank}${SUIT_CODE[card.suit]}`;
}

export interface HandStrength {
  /** 1 = high card ... 9 = straight flush. */
  rank: number;
  name: string;
  description: string;
}

export function evaluateHand(cards: readonly PlayingCard[]): HandStrength {
  const hand = Hand.solve(cards.map(toSolverCard));
  return { rank: hand.rank, name: hand.name, description: hand.descr };
}

/**
 * Given each contender's 5-7 cards, returns the keys of the winner(s).
 * More than one key means a split.
 */
export function findWinners<K>(contenders: ReadonlyArray<{ key: K; cards: readonly PlayingCard[] }>): K[] {
  const solved = contenders.map((c) => ({ key: c.key, hand: Hand.solve(c.cards.map(toSolverCard)) as SolvedHand }));
  const winningHands = new Set(Hand.winners(solved.map((s) => s.hand)));
  return solved.filter((s) => winningHands.has(s.hand)).map((s) => s.key);
}
