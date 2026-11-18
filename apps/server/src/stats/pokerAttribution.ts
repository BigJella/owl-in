import type { PlayerKind, PokerEvent, PokerHandResult } from "@owl-in/shared";

export interface AttributionSeat {
  seat: number;
  kind: PlayerKind;
  /** Chips put in this hand (uncalled bets already returned). */
  contributed: number;
  folded: boolean;
}

export interface SeatOutcome {
  seat: number;
  /** Chips collected from pots. */
  returned: number;
  net: number;
  /** Net against humans / bots; they add up to `net`. */
  vsPlayers: number;
  vsBots: number;
  result: PokerHandResult;
}

/**
 * Who won what from whom in one finished poker hand. Each seat's net is what it collected minus what it put in.
 * Poker is zero-sum, so every loser's loss is spread over the winners in proportion to their profit; summing those
 * transfers by the other side's kind gives each seat's net against players and against bots.
 */
export function attributePokerHand(seats: AttributionSeat[], events: PokerEvent[]): SeatOutcome[] {
  const returned = new Map<number, number>();
  const alone = new Set<number>();
  const shared = new Set<number>();
  for (const e of events) {
    if (e.type !== "potAwarded") continue;
    for (const w of e.winners) {
      returned.set(w.seat, (returned.get(w.seat) ?? 0) + w.amount);
      (e.winners.length === 1 ? alone : shared).add(w.seat);
    }
  }

  const net = new Map(seats.map((s) => [s.seat, (returned.get(s.seat) ?? 0) - s.contributed]));
  const profit = seats.reduce((sum, s) => sum + Math.max(0, net.get(s.seat)!), 0);
  const kind = new Map(seats.map((s) => [s.seat, s.kind]));
  const vs = new Map(seats.map((s) => [s.seat, { players: 0, bots: 0 }]));

  if (profit > 0) {
    for (const loser of seats) {
      const loss = -Math.min(0, net.get(loser.seat)!);
      if (loss === 0) continue;
      for (const winner of seats) {
        const gain = Math.max(0, net.get(winner.seat)!);
        if (gain === 0) continue;
        const amount = (loss * gain) / profit;
        const w = vs.get(winner.seat)!;
        const l = vs.get(loser.seat)!;
        if (kind.get(loser.seat) === "bot") w.bots += amount;
        else w.players += amount;
        if (kind.get(winner.seat) === "bot") l.bots -= amount;
        else l.players -= amount;
      }
    }
  }

  return seats.map((s) => {
    const n = net.get(s.seat)!;
    const vsBots = Math.round(vs.get(s.seat)!.bots);
    const result: PokerHandResult = s.folded ? "folded" : alone.has(s.seat) ? "won" : shared.has(s.seat) ? "split" : "lost";
    return { seat: s.seat, returned: returned.get(s.seat) ?? 0, net: n, vsBots, vsPlayers: n - vsBots, result };
  });
}
