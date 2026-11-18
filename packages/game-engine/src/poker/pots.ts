export interface Pot {
  amount: number;
  /** Seats that can win this pot (did not fold). */
  eligibleSeats: number[];
}

export interface Contribution {
  seat: number;
  contributed: number;
  folded: boolean;
}

/**
 * Split total contributions into a main pot and side pots, layered by the
 * all-in amounts of players still in the hand. Pots with identical eligibility are merged.
 */
export function buildPots(contributions: readonly Contribution[]): Pot[] {
  const live = contributions.filter((c) => !c.folded && c.contributed > 0);
  const levels = [...new Set(live.map((c) => c.contributed))].sort((a, b) => a - b);

  const pots: Pot[] = [];
  let previous = 0;
  for (const level of levels) {
    const amount = contributions.reduce(
      (sum, c) => sum + Math.max(0, Math.min(c.contributed, level) - previous),
      0,
    );
    const eligibleSeats = live.filter((c) => c.contributed >= level).map((c) => c.seat);
    const last = pots.at(-1);
    if (last && sameSeats(last.eligibleSeats, eligibleSeats)) last.amount += amount;
    else if (amount > 0) pots.push({ amount, eligibleSeats });
    previous = level;
  }

  // Folded money above the highest live level (should not happen once uncalled bets are returned).
  const leftover = contributions.reduce((sum, c) => sum + Math.max(0, c.contributed - previous), 0);
  if (leftover > 0) {
    const last = pots.at(-1);
    if (last) last.amount += leftover;
  }
  return pots;
}

function sameSeats(a: number[], b: number[]) {
  return a.length === b.length && a.every((seat, i) => seat === b[i]);
}
