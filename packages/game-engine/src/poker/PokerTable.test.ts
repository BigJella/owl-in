import { describe, expect, it } from "vitest";
import { createDeck, type PlayingCard, type Suit } from "../cards/Deck";
import { PokerTable, type PokerAction } from "./PokerTable";
import { buildPots } from "./pots";

const SUITS: Record<string, Suit> = { h: "hearts", d: "diamonds", c: "clubs", s: "spades" };
const card = (code: string): PlayingCard =>
  ({ rank: code.slice(0, -1).toUpperCase(), suit: SUITS[code.slice(-1).toLowerCase()]! }) as PlayingCard;
const same = (a: PlayingCard, b: PlayingCard) => a.rank === b.rank && a.suit === b.suit;

/** Builds a deck in draw order: hole cards round-robin in `dealOrder`, then burn/flop/burn/turn/burn/river. */
function stackedDeck(dealOrder: number[], holes: Record<number, [string, string]>, board: string[]) {
  const wanted: PlayingCard[] = [];
  for (const round of [0, 1]) for (const seat of dealOrder) wanted.push(card(holes[seat]![round]!));
  const boardCards = board.map(card);
  const rest = createDeck().filter((c) => ![...wanted, ...boardCards].some((w) => same(w, c)));
  const burn = () => rest.shift()!;
  const order = [...wanted, burn(), ...boardCards.slice(0, 3), burn(), boardCards[3]!, burn(), boardCards[4]!, ...rest];
  return () => order.map((c) => ({ ...c }));
}

function table(stacks: Record<number, number>, options: Partial<ConstructorParameters<typeof PokerTable>[0]> = {}) {
  const t = new PokerTable({ smallBlind: 5, bigBlind: 10, ...options });
  for (const [seat, stack] of Object.entries(stacks)) t.seatPlayer(Number(seat), `p${seat}`, stack);
  return t;
}

const stackOf = (t: PokerTable, seat: number) => t.seats[seat]!.stack;

describe("buildPots", () => {
  it("layers side pots by all-in amount and counts folded money", () => {
    const pots = buildPots([
      { seat: 0, contributed: 100, folded: false },
      { seat: 1, contributed: 300, folded: false },
      { seat: 2, contributed: 300, folded: false },
      { seat: 3, contributed: 50, folded: true },
    ]);
    expect(pots).toEqual([
      { amount: 350, eligibleSeats: [0, 1, 2] },
      { amount: 400, eligibleSeats: [1, 2] },
    ]);
  });
});

describe("blinds and turn order", () => {
  it("rotates the button and blinds each hand", () => {
    const t = table({ 0: 1000, 1: 1000, 2: 1000 });
    const first = t.startHand()[0];
    expect(first).toMatchObject({ type: "handStarted", button: 0, smallBlindSeat: 1, bigBlindSeat: 2 });
    expect(t.toAct).toBe(0);
    t.act(0, { type: "fold" });
    t.act(1, { type: "fold" });
    expect(t.phase).toBe("idle");

    const second = t.startHand()[0];
    expect(second).toMatchObject({ button: 1, smallBlindSeat: 2, bigBlindSeat: 0 });
  });

  it("heads-up: button posts the small blind, acts first preflop and last after", () => {
    const t = table({ 0: 1000, 3: 1000 });
    expect(t.startHand()[0]).toMatchObject({ button: 0, smallBlindSeat: 0, bigBlindSeat: 3 });
    expect(t.toAct).toBe(0);
    t.act(0, { type: "call" });
    expect(t.toAct).toBe(3); // big blind option
    t.act(3, { type: "check" });
    expect(t.phase).toBe("flop");
    expect(t.toAct).toBe(3);
  });

  it("gives the big blind its option, then starts postflop left of the button", () => {
    const t = table({ 0: 1000, 1: 1000, 2: 1000 });
    t.startHand();
    t.act(0, { type: "call" });
    t.act(1, { type: "call" });
    expect(t.toAct).toBe(2);
    t.act(2, { type: "check" });
    expect(t.phase).toBe("flop");
    expect(t.community).toHaveLength(3);
    expect(t.toAct).toBe(1);
  });
});

describe("raising", () => {
  it("enforces the minimum raise", () => {
    const t = table({ 0: 1000, 1: 1000, 2: 1000 });
    t.startHand();
    t.act(0, { type: "raise", to: 30 }); // raise of 20
    expect(t.legalActions(1).minRaiseTo).toBe(50);
    expect(() => t.act(1, { type: "raise", to: 40 })).toThrow();
    t.act(1, { type: "raise", to: 50 });
    expect(t.currentBet).toBe(50);
  });

  it("a short all-in does not re-open raising for players who already acted", () => {
    const t = table({ 0: 1000, 1: 1000, 2: 45 });
    t.startHand(); // button 0, sb 1, bb 2
    t.act(0, { type: "raise", to: 30 });
    t.act(1, { type: "fold" });
    t.act(2, { type: "raise", to: 45 }); // all-in, only +15
    expect(t.toAct).toBe(0);
    const legal = t.legalActions(0);
    expect(legal.canRaise).toBe(false);
    expect(legal.callAmount).toBe(15);
  });
});

describe("hand endings", () => {
  it("awards blinds when everyone folds and returns the uncalled bet", () => {
    const t = table({ 0: 1000, 1: 1000, 2: 1000 });
    t.startHand();
    t.act(0, { type: "fold" });
    const events = t.act(1, { type: "fold" });
    expect(events).toContainEqual({ type: "uncalledReturned", seat: 2, amount: 5 });
    expect(stackOf(t, 2)).toBe(1005);
    expect(stackOf(t, 1)).toBe(995);
  });

  it("splits main and side pots at showdown", () => {
    const t = table(
      { 0: 100, 1: 300, 2: 300 },
      {
        deckFactory: stackedDeck(
          [1, 2, 0],
          { 0: ["Ah", "Ad"], 1: ["Kh", "Kd"], 2: ["Qh", "Qd"] },
          ["2c", "7d", "9s", "4s", "Jc"],
        ),
      },
    );
    t.startHand();
    t.act(0, { type: "raise", to: 100 }); // all-in
    t.act(1, { type: "raise", to: 300 }); // all-in
    const events = t.act(2, { type: "call" });
    expect(t.phase).toBe("idle");
    expect(t.community).toHaveLength(5);
    const awards = events.filter((e) => e.type === "potAwarded");
    expect(awards).toEqual([
      { type: "potAwarded", potIndex: 0, amount: 300, winners: [{ seat: 0, amount: 300 }] },
      { type: "potAwarded", potIndex: 1, amount: 400, winners: [{ seat: 1, amount: 400 }] },
    ]);
    expect([stackOf(t, 0), stackOf(t, 1), stackOf(t, 2)]).toEqual([300, 400, 0]);
  });

  it("gives the odd chip of a split pot to the first winner left of the button", () => {
    const t = table(
      { 0: 1000, 1: 1000, 2: 1000 },
      {
        deckFactory: stackedDeck(
          [1, 2, 0],
          { 0: ["2c", "3d"], 1: ["6c", "7d"], 2: ["4c", "5d"] },
          ["Ah", "Kd", "Qs", "Jc", "Th"],
        ),
      },
    );
    t.startHand();
    t.act(0, { type: "call" });
    t.act(1, { type: "fold" });
    t.act(2, { type: "check" });
    for (let street = 0; street < 3; street += 1) {
      t.act(2, { type: "check" });
      t.act(0, { type: "check" });
    }
    expect(t.phase).toBe("idle");
    expect([stackOf(t, 0), stackOf(t, 1), stackOf(t, 2)]).toEqual([1002, 995, 1003]);
  });
});

describe("seating", () => {
  it("does not deal in players seated mid-hand, and blocks removal mid-hand", () => {
    const t = table({ 0: 1000, 1: 1000 });
    t.startHand();
    t.seatPlayer(5, "late", 500);
    expect(t.seats[5]).toMatchObject({ inHand: false, holeCards: [] });
    expect(() => t.removePlayer(0)).toThrow();
  });
});

describe("random play", () => {
  it("conserves chips over many hands", () => {
    let seed = 42;
    const rng = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
    const t = table({ 0: 500, 2: 800, 3: 200, 6: 1500 }, { random: rng });
    const total = t.totalChips();

    for (let hand = 0; hand < 300 && t.canStartHand(); hand += 1) {
      t.startHand();
      let guard = 0;
      while (t.phase !== "idle") {
        const seat = t.toAct!;
        const legal = t.legalActions(seat);
        const roll = rng();
        let action: PokerAction;
        if (roll < 0.15 && !legal.canCheck) action = { type: "fold" };
        else if (roll < 0.35 && legal.canRaise) {
          action = { type: "raise", to: legal.minRaiseTo + Math.floor(rng() * (legal.maxRaiseTo - legal.minRaiseTo + 1)) };
        } else action = { type: "call" };
        t.act(seat, action);
        expect(t.totalChips()).toBe(total);
        if ((guard += 1) > 500) throw new Error("hand did not terminate");
      }
    }
    expect(t.totalChips()).toBe(total);
  });
});
