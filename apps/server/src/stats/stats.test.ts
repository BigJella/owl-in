import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BlackjackTable, Shoe, type PlayingCard, type PokerEvent, type Rank } from "@owl-in/game-engine";
import { HouseBank } from "../economy/HouseBank";
import { HumanPlayer } from "../players/HumanPlayer";
import type { GameSocket } from "../networking/types";
import { BlackjackRoom } from "../rooms/BlackjackRoom";
import { PokerRoom } from "../rooms/PokerRoom";
import { canView, careerView, leaderboard, sessionHandsFor } from "./careerView";
import { MemoryStatsStore } from "./MemoryStatsStore";
import { attributePokerHand, type AttributionSeat } from "./pokerAttribution";

let counter = 0;
function human(name = `st${++counter}`) {
  const player = new HumanPlayer(`h-${name}`, `token-${name}`, name);
  player.attach({ connected: true, emit() {}, disconnect() {} } as unknown as GameSocket);
  return player;
}

const award = (potIndex: number, amount: number, winners: [number, number][]): PokerEvent => ({
  type: "potAwarded",
  potIndex,
  amount,
  winners: winners.map(([seat, amt]) => ({ seat, amount: amt })),
});

describe("attributePokerHand", () => {
  it("heads-up against a bot: all of it is vs bots", () => {
    const seats: AttributionSeat[] = [
      { seat: 0, kind: "human", contributed: 100, folded: false },
      { seat: 1, kind: "bot", contributed: 100, folded: false },
    ];
    const [me, bot] = attributePokerHand(seats, [award(0, 200, [[0, 200]])]);
    expect(me).toMatchObject({ net: 100, vsBots: 100, vsPlayers: 0, result: "won", returned: 200 });
    expect(bot).toMatchObject({ net: -100, vsBots: 0, vsPlayers: -100, result: "lost" });
  });

  it("splits a multiway pot's losses by who lost them", () => {
    // Human A wins 300: B (human) lost 100, a bot lost 100, A put in 100.
    const seats: AttributionSeat[] = [
      { seat: 0, kind: "human", contributed: 100, folded: false },
      { seat: 1, kind: "human", contributed: 100, folded: false },
      { seat: 2, kind: "bot", contributed: 100, folded: true },
    ];
    const out = attributePokerHand(seats, [award(0, 300, [[0, 300]])]);
    expect(out[0]).toMatchObject({ net: 200, vsPlayers: 100, vsBots: 100, result: "won" });
    expect(out[1]).toMatchObject({ net: -100, vsPlayers: -100, vsBots: 0, result: "lost" });
    expect(out[2]).toMatchObject({ net: -100, result: "folded" });
    expect(out.reduce((s, o) => s + o.net, 0)).toBe(0);
  });

  it("calls a chopped pot a split", () => {
    const seats: AttributionSeat[] = [
      { seat: 0, kind: "human", contributed: 50, folded: false },
      { seat: 1, kind: "bot", contributed: 50, folded: false },
    ];
    const out = attributePokerHand(seats, [award(0, 100, [[0, 50], [1, 50]])]);
    expect(out.map((o) => o.result)).toEqual(["split", "split"]);
    expect(out.map((o) => o.net)).toEqual([0, 0]);
  });

  it("handles side pots and keeps vs-players + vs-bots = net", () => {
    // Short human all-in for 50 wins the main pot (150); the bot wins the side pot against the other human.
    const seats: AttributionSeat[] = [
      { seat: 0, kind: "human", contributed: 50, folded: false },
      { seat: 1, kind: "human", contributed: 200, folded: false },
      { seat: 2, kind: "bot", contributed: 200, folded: false },
    ];
    const out = attributePokerHand(seats, [award(0, 150, [[0, 150]]), award(1, 300, [[2, 300]])]);
    expect(out.map((o) => o.net)).toEqual([100, -200, 100]);
    for (const o of out) expect(o.vsPlayers + o.vsBots).toBe(o.net);
    expect(out[0]!.result).toBe("won");
    expect(out[1]!.vsBots).toBe(-100);
    expect(out[1]!.vsPlayers).toBe(-100);
  });
});

describe("recording from rooms", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("poker: records each hand, and career net matches the stack change", async () => {
    const stats = new MemoryStatsStore();
    const room = new PokerRoom({ id: "p1", name: "Stats Poker", bigBlind: 10, bank: new HouseBank(), stats });
    room.start();
    const me = human();
    room.join(me, 1_000);
    const seated = () => stats.career(me.id).sessions[0]?.leftAt === null;
    for (let i = 0; i < 400 && stats.career(me.id).poker.hands < 3 && seated(); i += 1) {
      const view = room.viewFor(me.id);
      if (view.myLegalActions) room.submitAction(me, view.myLegalActions.canCheck ? { type: "check" } : { type: "call" });
      if (view.readyGraceRemainingMs !== null) room.setReady(me);
      await vi.advanceTimersByTimeAsync(500);
    }
    const career = stats.career(me.id);
    expect(career.poker.hands).toBeGreaterThanOrEqual(1);
    expect(career.poker.won + career.poker.lost + career.poker.splitPot + career.poker.folded).toBe(career.poker.hands);
    expect(career.poker.netVsPlayers).toBe(0); // only bots at the table
    expect(career.poker.netVsBots).toBe(career.poker.net);

    const session = career.sessions[0]!;
    expect(session).toMatchObject({ game: "poker", roomName: "Stats Poker", stakes: "$5/$10", buyIn: 1_000 });
    // What you walk away with (or still hold, between hands) is the buy-in plus every recorded hand's net.
    for (let i = 0; i < 40 && room.table.phase !== "idle"; i += 1) await vi.advanceTimersByTimeAsync(500);
    const now = stats.career(me.id).sessions[0]!;
    const stack = now.leftAt === null ? room.chipsOf(me) : now.cashOut!;
    const hands = stats.sessionHands(me.id, session.id);
    expect(stack - 1_000).toBe(hands.reduce((s, h) => s + h.net, 0));
    expect(now.net).toBe(stack - 1_000);
    // The chart's running total ends at the starting bankroll plus every recorded hand.
    const history = stats.career(me.id).chipHistory;
    expect(history.map((p) => p.hand)).toEqual(history.map((_, i) => i + 1));
    expect(history.at(-1)!.total).toBe(10_000 + stats.career(me.id).poker.net);
    const first = hands[0]!;
    expect(first.game === "poker" && first.holeCards?.length).toBe(2);

    if (now.leftAt === null) {
      room.leave(me);
      const closed = stats.career(me.id).sessions[0]!;
      expect(closed.leftAt).not.toBeNull();
      expect(closed.endReason).toBe("left");
    } else {
      expect(now).toMatchObject({ endReason: "busted", cashOut: 0 });
    }
    room.close();
  });

  it("blackjack: records splits, doubles and the round's net", async () => {
    const suits = ["spades", "hearts", "diamonds", "clubs"] as const;
    const ranks = "8 9 8 7 3 10 9".split(" ");
    const cards: PlayingCard[] = [...ranks, ...Array(200).fill("2")].map((rank, i) => ({ rank: rank as Rank, suit: suits[i % 4]! }));
    const stats = new MemoryStatsStore();
    const room = new BlackjackRoom({
      id: "b1",
      name: "Stats BJ",
      minBet: 10,
      bank: new HouseBank(),
      stats,
      table: new BlackjackTable({ shoe: new Shoe({ decks: 6, penetration: 0.75, stacked: cards }) }),
    });
    room.start();
    const me = human();
    room.join(me);
    for (const spot of [0, 1, 2]) room.bet(me, spot, 10);
    room.leaveSpot(me, 1);
    room.leaveSpot(me, 2);
    room.setReady(me);
    const before = me.bankroll + 10; // the bet on spot 0 already left the bankroll
    // 8,8 vs 9 (hole 7): split; first hand 8+3 = 11, double into a 10 = 21; second 8+9 = 17. Dealer 16 draws a 2 = 18.
    for (const action of ["split", "double", "stand"] as const) {
      for (let i = 0; i < 40 && !room.viewFor(me.id).myLegal; i += 1) await vi.advanceTimersByTimeAsync(100);
      expect(room.submitAction(me, action)).toBeNull();
      await vi.advanceTimersByTimeAsync(1);
    }
    for (let i = 0; i < 40 && stats.career(me.id).blackjack.rounds === 0; i += 1) await vi.advanceTimersByTimeAsync(100);
    const bj = stats.career(me.id).blackjack;
    expect(bj).toMatchObject({ rounds: 1, hands: 2, wins: 1, losses: 1, splits: 1, doubles: 1, wagered: 30, returned: 40, net: 10 });
    expect(me.bankroll - before).toBe(10);
    const [round] = stats.sessionHands(me.id, stats.career(me.id).sessions[0]!.id);
    expect(round).toMatchObject({ game: "blackjack", net: 10, dealer: { total: 18 } });
    expect(stats.career(me.id).chipHistory).toEqual([{ hand: 1, at: expect.any(Number), game: "blackjack", net: 10, total: 10_010 }]);
    room.close();
    expect(stats.career(me.id).sessions[0]!.endReason).toBe("table closed");
  });
});

describe("privacy and the leaderboard", () => {
  it("hides private careers and unshown hole cards from other players", () => {
    const stats = new MemoryStatsStore();
    const owner = human();
    const other = human();
    const sessionId = stats.openSession(owner.id, { game: "poker", roomId: "r", roomName: "R", stakes: "$5/$10", buyIn: 500 });
    const hand = {
      game: "poker" as const,
      sessionId,
      handId: 1,
      at: 0,
      holeCards: [
        { rank: "A" as const, suit: "spades" as const },
        { rank: "K" as const, suit: "hearts" as const },
      ],
      board: [],
      position: null,
      lastAction: "Fold",
      showdownHand: null,
      pot: 30,
      wagered: 10,
      returned: 0,
      net: -10,
      result: "folded" as const,
      vsPlayers: 0,
      vsBots: -10,
    };
    stats.recordPokerHand(owner.id, hand, { reached: false, won: false });

    expect(sessionHandsFor(stats, owner, owner, sessionId)[0]).toMatchObject({ holeCards: hand.holeCards });
    expect(sessionHandsFor(stats, owner, other, sessionId)[0]).toMatchObject({ holeCards: null });
    expect(careerView(stats, owner, other, 0)).toMatchObject({ isMe: false, net: -10 });

    owner.careerPublic = false;
    expect(canView(owner, owner)).toBe(true);
    expect(canView(owner, other)).toBe(false);
  });

  it("ranks by Dining Dollars including chips at a table", () => {
    const a = human();
    const b = human();
    a.bankroll = 9_000;
    b.bankroll = 9_500;
    const rows = leaderboard([a, b], a, (p) => (p === a ? 1_000 : 0));
    expect(rows.map((r) => [r.rank, r.name, r.bankroll, r.isMe])).toEqual([
      [1, a.name, 10_000, true],
      [2, b.name, 9_500, false],
    ]);
  });
});
