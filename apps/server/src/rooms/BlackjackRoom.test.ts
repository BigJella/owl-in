import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BlackjackTable, Shoe, type PlayingCard, type Rank } from "@owl-in/game-engine";
import { STARTING_BANKROLL, type BlackjackStateMessage } from "@owl-in/shared";
import { HouseBank } from "../economy/HouseBank";
import { HumanPlayer } from "../players/HumanPlayer";
import type { GameSocket } from "../networking/types";
import { BlackjackRoom } from "./BlackjackRoom";

let humanCounter = 0;

function human(name = `bj${++humanCounter}`) {
  const player = new HumanPlayer(`h-${name}`, `token-${name}`, name);
  const messages: BlackjackStateMessage[] = [];
  const socket = {
    connected: true,
    emit: (event: string, payload: unknown) => {
      if (event === "blackjack:state") messages.push(payload as BlackjackStateMessage);
    },
    disconnect() {},
  } as unknown as GameSocket;
  player.attach(socket);
  return { player, messages, socket };
}

function room(options: { minBet?: number; bank?: HouseBank; table?: BlackjackTable } = {}) {
  const r = new BlackjackRoom({ id: "bj1", name: "Test", minBet: options.minBet ?? 10, bank: options.bank ?? new HouseBank(), ...(options.table ? { table: options.table } : {}) });
  r.start();
  return r;
}

const rigged = (ranks: string) => {
  const suits = ["spades", "hearts", "diamonds", "clubs"] as const;
  const cards: PlayingCard[] = ranks.split(" ").map((rank, i) => ({ rank: rank as Rank, suit: suits[i % 4]! }));
  const filler: PlayingCard[] = Array.from({ length: 200 }, (_, i) => ({ rank: "2", suit: suits[i % 4]! }));
  return new BlackjackTable({ shoe: new Shoe({ decks: 6, penetration: 0.75, stacked: [...cards, ...filler] }) });
};

const owners = (r: BlackjackRoom) => r.viewFor(null).spots.map((s) => (s ? s.kind : null));

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("bots", () => {
  it("only ever sit in the first three spots", async () => {
    const r = room();
    await vi.advanceTimersByTimeAsync(r.timing.botOnlyRoundIntervalMs);
    expect(owners(r)).toEqual(["bot", "bot", "bot", null, null, null, null]);
    r.close();
  });

  it("give up a spot when a human bets on it", async () => {
    const r = room();
    const { player } = human();
    r.join(player);
    expect(r.stage()).toBe("betting");
    expect(owners(r).slice(0, 3)).toEqual(["bot", "bot", "bot"]);
    expect(r.bet(player, 1, 50)).toBeNull();
    expect(owners(r)).toEqual(["bot", "human", "bot", null, null, null, null]);
    expect(player.bankroll).toBe(STARTING_BANKROLL - 50);
    r.close();
  });
});

describe("betting", () => {
  it("limits a player to 3 spots and enforces the table limits", () => {
    const r = room();
    const { player } = human();
    r.join(player);
    expect(r.bet(player, 3, 5)).toMatch(/Bets are/);
    expect(r.bet(player, 3, 501)).toMatch(/Bets are/);
    expect(r.bet(player, 3, 10)).toBeNull();
    expect(r.bet(player, 4, 10)).toBeNull();
    expect(r.bet(player, 5, 10)).toBeNull();
    expect(r.bet(player, 6, 10)).toMatch(/at most 3/);
    expect(r.bet(player, 5, 40)).toBeNull(); // changing a bet on your own spot is fine
    expect(player.bankroll).toBe(STARTING_BANKROLL - 60);
    r.close();
  });

  it("won't let you take another human's spot", () => {
    const r = room();
    const a = human();
    const b = human();
    r.join(a.player);
    r.join(b.player);
    r.bet(a.player, 4, 10);
    expect(r.bet(b.player, 4, 10)).toMatch(/Someone else/);
    r.close();
  });

  it("closes early once everyone with a bet presses Deal", async () => {
    const r = room();
    const { player } = human();
    r.join(player);
    r.bet(player, 4, 10);
    r.setReady(player);
    await vi.advanceTimersByTimeAsync(r.timing.gapMs + 1);
    expect(r.stage()).not.toBe("betting");
    expect(r.table.roundId).toBe(1);
    r.close();
  });

  it("refunds bets when you leave before the deal", () => {
    const r = room();
    const { player } = human();
    r.join(player);
    r.bet(player, 4, 100);
    r.leave(player);
    expect(player.bankroll).toBe(STARTING_BANKROLL);
    expect(player.roomId).toBeNull();
    expect(owners(r)[4]).toBeNull();
    r.close();
  });
});

describe("playing", () => {
  it("hides the dealer's hole card from every view until it's turned over", async () => {
    // Bots in spots 0-2 are replaced: the human plays spot 0 alone. Player 10,6 vs dealer 9 + hole K.
    const r = room({ table: rigged("10 9 6 K") });
    const h = human();
    r.join(h.player);
    for (const spot of [0, 1, 2]) r.bet(h.player, spot, 10);
    r.clearBet(h.player, 1);
    r.clearBet(h.player, 2);
    r.setReady(h.player);
    await vi.advanceTimersByTimeAsync(r.timing.gapMs + 5);
    const dealt = h.messages.find((m) => m.events.some((e) => e.type === "roundStarted"))!;
    expect(dealt.view.dealer.cards[1]).toBeNull();
    expect(JSON.stringify(dealt)).not.toContain('"K"');
    r.close();
  });

  it("auto-stands when the time bank runs out", async () => {
    const r = room({ table: rigged("10 9 6 7") }); // 16 vs 9: the human would usually hit
    const { player } = human();
    r.join(player);
    r.bet(player, 0, 10);
    r.clearBet(player, 0);
    r.bet(player, 0, 10);
    // Bots in 1 and 2 also play; give everything time.
    r.setReady(player);
    await vi.advanceTimersByTimeAsync(r.timing.gapMs + 20_000 + 10_000);
    const hand = r.table.spots[0]!.hands[0];
    expect(hand?.cards).toHaveLength(2);
    expect(hand?.status).toBe("stood");
    r.close();
  });

  it("queues a mid-round leave until the round is over", async () => {
    const r = room();
    const { player } = human();
    r.join(player);
    r.bet(player, 4, 10);
    r.setReady(player);
    await vi.advanceTimersByTimeAsync(r.timing.gapMs + 5);
    expect(r.canLeaveNow(player)).toBe(false);
    r.leave(player);
    expect(player.roomId).toBe(r.id);
    expect(r.viewFor(player.id).leaveMode).toBe("queued");
    for (let i = 0; i < 200 && player.roomId !== null; i += 1) await vi.advanceTimersByTimeAsync(1_000);
    expect(player.roomId).toBeNull();
    r.close();
  });
});

describe("money", () => {
  it("is conserved over a long session (bankrolls + house + table)", async () => {
    const bank = new HouseBank();
    const r = room({ bank });
    const players = [human(), human()];
    for (const { player } of players) r.join(player);
    const total = () => bank.balance + r.onTable() + players.reduce((s, { player }) => s + player.bankroll, 0);
    const start = total();
    let rounds = 0;
    const seenShuffle = { value: false };
    for (const { messages } of players) void messages;

    for (let tick = 0; tick < 3_000 && rounds < 150; tick += 1) {
      const stage = r.stage();
      if (stage === "betting") {
        players.forEach(({ player }, i) => {
          if (r.ownedSpots(player).length === 0 || r.viewFor(player.id).amReady === false) {
            const spot = 3 + i * 2;
            if (r.table.spots[spot]!.bet === 0) r.bet(player, spot, 10 + 10 * (tick % 5));
            r.setReady(player);
          }
        });
      }
      if (stage === "insurance") for (const { player } of players) r.insurance(player, tick % 2 === 0);
      for (const { player } of players) {
        const view = r.viewFor(player.id);
        if (view.myLegal) {
          const options = (Object.keys(view.myLegal) as (keyof typeof view.myLegal)[]).filter((a) => view.myLegal![a]);
          r.submitAction(player, options[tick % options.length]!);
        }
      }
      if (r.table.roundId > rounds) rounds = r.table.roundId;
      if (r.table.shoe.discarded <= 1 && rounds > 1) seenShuffle.value = true;
      expect(total()).toBe(start);
      await vi.advanceTimersByTimeAsync(500);
    }
    expect(rounds).toBeGreaterThan(50);
    expect(owners(r).slice(0, 3).every((o) => o === "bot")).toBe(true);
    r.close();
  });
});
