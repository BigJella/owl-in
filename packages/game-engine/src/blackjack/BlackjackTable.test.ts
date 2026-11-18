import { describe, expect, it } from "vitest";
import type { PlayingCard, Rank } from "../cards/Deck";
import { BlackjackTable, type BlackjackAction } from "./BlackjackTable";
import { handTotal, isNatural, isPair } from "./hand";
import { Shoe } from "./Shoe";

const suits = ["spades", "hearts", "diamonds", "clubs"] as const;
let suitIndex = 0;
const c = (rank: Rank): PlayingCard => ({ rank, suit: suits[suitIndex++ % 4]! });
const cards = (ranks: string) => ranks.split(" ").map((r) => c(r as Rank));

/**
 * A table whose shoe deals exactly `ranks` (then 2s forever). One bet per spot in `spots`.
 * Deal order: each spot's first card, dealer up, each spot's second card, dealer hole, then hits.
 */
function rigged(ranks: string, spots: Record<number, number> = { 0: 100 }) {
  const stacked = [...cards(ranks), ...Array.from({ length: 60 }, () => c("2"))];
  const table = new BlackjackTable({ shoe: new Shoe({ decks: 6, penetration: 0.75, stacked }) });
  for (const [spot, bet] of Object.entries(spots)) table.placeBet(Number(spot), bet);
  return table;
}

const settled = (events: ReturnType<BlackjackTable["deal"]>) =>
  events.filter((e) => e.type === "handSettled").map((e) => (e.type === "handSettled" ? [e.result, e.payout] : null));

describe("hand helpers", () => {
  it("counts soft and hard totals", () => {
    expect(handTotal(cards("A 6"))).toEqual({ total: 17, soft: true });
    expect(handTotal(cards("A 6 10"))).toEqual({ total: 17, soft: false });
    expect(handTotal(cards("A A 9"))).toEqual({ total: 21, soft: true });
    expect(isNatural(cards("A K"))).toBe(true);
    expect(isPair(cards("10 K"))).toBe(true);
    expect(isPair(cards("9 K"))).toBe(false);
  });
});

describe("dealing and the dealer", () => {
  it("hides the hole card until it's revealed", () => {
    const t = rigged("10 9 7 8"); // player 10,7 = 17; dealer 9 + 8
    const events = t.deal();
    const dealerCards = events.filter((e) => e.type === "cardDealt" && e.target === "dealer");
    expect(dealerCards.map((e) => (e.type === "cardDealt" ? e.card?.rank ?? null : "x"))).toEqual(["9", null]);
    expect(t.visibleDealer()[1]).toBeNull();
    t.act("stand");
    expect(t.holeRevealed).toBe(true);
  });

  it("stands on soft 17", () => {
    const t = rigged("10 A 8 6"); // player 18 vs dealer A,6 (soft 17) -> insurance offered first
    t.deal();
    t.closeInsurance();
    const events = t.act("stand");
    expect(t.dealer).toHaveLength(2);
    expect(settled(events)).toEqual([["win", 200]]);
  });

  it("hits until 17 and busts", () => {
    const t = rigged("10 6 8 10 10"); // player 18; dealer 6,10 -> draws 10 -> 26
    t.deal();
    const events = t.act("stand");
    expect(handTotal(t.dealer).total).toBe(26);
    expect(settled(events)).toEqual([["win", 200]]);
  });

  it("pushes on equal totals", () => {
    const t = rigged("10 10 8 8");
    t.deal();
    expect(settled(t.act("stand"))).toEqual([["push", 100]]);
  });
});

describe("blackjack", () => {
  it("pays 3:2", () => {
    const t = rigged("A 9 K 7");
    const events = t.deal();
    expect(t.phase).toBe("done");
    expect(settled(events)).toEqual([["blackjack", 250]]);
  });

  it("pushes against a dealer blackjack and the dealer peeks before anyone plays", () => {
    const t2 = rigged("A 9 K K 9 A", { 0: 100, 1: 50 }); // s0 A,K (BJ); s1 9,9; dealer K + A (BJ)
    const events = t2.deal();
    expect(events.some((e) => e.type === "dealerPeeked" && e.blackjack)).toBe(true);
    expect(settled(events)).toEqual([
      ["push", 100],
      ["lose", 0],
    ]);
  });

  it("insurance pays 2:1 when the dealer has blackjack", () => {
    const t = rigged("10 A 9 K"); // player 19; dealer A + K
    t.deal();
    expect(t.phase).toBe("insurance");
    expect(t.setInsurance(0, true)).toEqual([{ type: "insuranceDecided", spot: 0, amount: 50 }]);
    const events = t.closeInsurance();
    const insurance = events.find((e) => e.type === "insuranceSettled");
    expect(insurance).toEqual({ type: "insuranceSettled", results: [{ spot: 0, stake: 50, payout: 150 }] });
    expect(settled(events)).toEqual([["lose", 0]]);
  });

  it("insurance is lost when the dealer doesn't have it, then play continues", () => {
    const t = rigged("10 A 9 7");
    t.deal();
    t.setInsurance(0, true);
    const events = t.closeInsurance();
    expect(events.find((e) => e.type === "insuranceSettled")).toEqual({
      type: "insuranceSettled",
      results: [{ spot: 0, stake: 50, payout: 0 }],
    });
    expect(t.phase).toBe("playing");
  });
});

describe("player options", () => {
  it("doubles: one card, twice the bet", () => {
    const t = rigged("6 9 5 7 10"); // player 6,5 = 11 -> doubles into 10 = 21; dealer 9,7 -> draws 2s
    t.deal();
    expect(t.actionCost("double")).toBe(100);
    t.act("double");
    const hand = t.spots[0]!.hands[0]!;
    expect(hand.cards).toHaveLength(3);
    expect(hand.bet).toBe(200);
    expect(hand.result).toBe("win");
    expect(hand.payout).toBe(400);
  });

  it("late surrender returns half, only as the first decision", () => {
    const t = rigged("10 10 6 7");
    t.deal();
    expect(t.legal()?.surrender).toBe(true);
    expect(settled(t.act("surrender"))).toEqual([["surrender", 50]]);

    const t2 = rigged("10 10 2 7 2");
    t2.deal();
    t2.act("hit");
    expect(t2.legal()?.surrender).toBe(false);
  });

  it("splits into separate hands, deals the second card when each hand comes up, and allows double after split", () => {
    const t = rigged("8 10 8 7 3 10 9"); // 8,8 vs 10 (hole 7). Split: hand0 gets 3 (11), hand1 gets later
    t.deal();
    expect(t.legal()?.split).toBe(true);
    t.act("split");
    const spot = t.spots[0]!;
    expect(spot.hands).toHaveLength(2);
    expect(spot.hands[0]!.cards.map((x) => x.rank)).toEqual(["8", "3"]);
    expect(spot.hands[1]!.cards).toHaveLength(1);
    expect(t.legal()?.double).toBe(true);
    expect(t.legal()?.surrender).toBe(false);
    t.act("double"); // 8,3,10 = 21
    expect(t.active).toEqual({ spot: 0, hand: 1 });
    expect(spot.hands[1]!.cards.map((x) => x.rank)).toEqual(["8", "9"]);
    t.act("stand");
    expect(spot.hands[0]!.payout).toBe(400);
    expect(spot.hands[1]!.result).toBe("push"); // 17 vs the dealer's 17
  });

  it("splits aces once, one card each, and 21 after a split is not blackjack", () => {
    const t = rigged("A 9 A 7 K A"); // A,A vs 9; hole 7 -> 16 draws 2 -> 18
    t.deal();
    t.act("split");
    const spot = t.spots[0]!;
    expect(spot.hands.map((h) => h.cards.map((x) => x.rank))).toEqual([
      ["A", "K"],
      ["A", "A"],
    ]);
    expect(t.phase).toBe("done"); // both stood automatically
    expect(spot.hands[0]!.result).toBe("win");
    expect(spot.hands[0]!.payout).toBe(200); // even money, not 3:2
  });

  it("allows at most 4 hands", () => {
    const t = rigged("8 10 8 7 8 8 8 8 8 8");
    t.deal();
    t.act("split");
    t.act("split");
    t.act("split");
    expect(t.spots[0]!.hands).toHaveLength(4);
    expect(t.legal()?.split).toBe(false);
  });

  it("acts in spot order, first base first", () => {
    const t = rigged("10 10 9 10 7 7", { 2: 10, 5: 10 });
    t.deal();
    expect(t.active).toEqual({ spot: 2, hand: 0 });
    t.act("stand");
    expect(t.active).toEqual({ spot: 5, hand: 0 });
  });
});

describe("the shoe", () => {
  it("persists across rounds and only reshuffles after the cut card", () => {
    const t = new BlackjackTable({ decks: 6, penetration: 0.75, random: mulberry(7) });
    const size = t.shoe.size;
    let shuffles = 0;
    let rounds = 0;
    let lastRemaining = size;
    while (shuffles < 2 && rounds < 500) {
      t.placeBet(0, 10);
      t.placeBet(3, 10);
      t.deal();
      t.closeInsurance();
      while (t.phase === "playing") t.act("stand");
      const before = t.shoe.cardsRemaining;
      expect(before).toBeLessThan(lastRemaining);
      const events = t.clearTable();
      if (events.some((e) => e.type === "shuffled")) {
        shuffles += 1;
        // Cut card at 70-80% penetration: plenty of cards were left when we shuffled.
        expect(size - before).toBeGreaterThanOrEqual(Math.floor(size * 0.7));
        expect(t.shoe.cardsRemaining).toBe(size - 1); // one burned
        expect(t.shoe.discarded).toBe(1);
      } else {
        expect(t.shoe.discarded + t.shoe.cardsRemaining).toBe(size);
      }
      lastRemaining = t.shoe.cardsRemaining;
      rounds += 1;
    }
    expect(shuffles).toBe(2);
  });

  it("random play never creates or loses money (stakes in = payouts out + house result)", () => {
    const random = mulberry(42);
    const t = new BlackjackTable({ decks: 6, penetration: 0.75, random });
    let staked = 0;
    let paid = 0;
    for (let round = 0; round < 2000; round += 1) {
      for (let spot = 0; spot < 7; spot += 1) if (random() < 0.6) t.placeBet(spot, 10 + Math.floor(random() * 10) * 10);
      if (t.bettingSpots().length === 0) t.placeBet(0, 10);
      for (const spot of t.bettingSpots()) staked += t.spots[spot]!.bet;
      const events = t.deal();
      if (t.phase === "insurance") {
        for (const spot of t.pendingInsurance()) {
          const take = random() < 0.3;
          if (take) staked += t.insuranceCost(spot);
          events.push(...t.setInsurance(spot, take));
        }
        events.push(...t.closeInsurance());
      }
      while (t.phase === "playing") {
        const legal = t.legal()!;
        const options = (Object.keys(legal) as BlackjackAction[]).filter((a) => legal[a]);
        const action = options[Math.floor(random() * options.length)]!;
        staked += t.actionCost(action);
        events.push(...t.act(action));
      }
      for (const e of events) {
        if (e.type === "handSettled") paid += e.payout;
        if (e.type === "insuranceSettled") for (const r of e.results) paid += r.payout;
      }
      // Every hand settled with a stake that matches what went in.
      const handStakes = t.spots.reduce((s, spot) => s + spot.hands.reduce((m, h) => m + h.bet, 0) + (spot.insurance ?? 0), 0);
      const settledStakes = events.reduce(
        (s, e) => s + (e.type === "handSettled" ? e.bet : e.type === "insuranceSettled" ? e.results.reduce((m, r) => m + r.stake, 0) : 0),
        0,
      );
      expect(settledStakes).toBe(handStakes);
      t.clearTable();
    }
    // House edge exists, but random play over 2000 rounds just has to be sane and finite.
    expect(Number.isFinite(staked - paid)).toBe(true);
    expect(paid).toBeGreaterThan(0);
  });
});

function mulberry(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let r = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    r = (r + Math.imul(r ^ (r >>> 7), 61 | r)) ^ r;
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}
