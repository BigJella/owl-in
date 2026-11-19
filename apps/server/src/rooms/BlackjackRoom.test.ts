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

  it("lets you give up a spot: now while betting, else after the round", async () => {
    const r = room();
    const a = human();
    const b = human();
    r.join(a.player);
    r.join(b.player);
    for (const spot of [3, 4, 5]) r.bet(a.player, spot, 10);
    expect(r.bet(b.player, 6, 10)).toBeNull();
    // During betting: freed at once, bet refunded.
    expect(r.leaveSpot(a.player, 5)).toBeNull();
    expect(r.ownedSpots(a.player)).toEqual([3, 4]);
    expect(a.player.bankroll).toBe(STARTING_BANKROLL - 20);
    r.setReady(a.player);
    r.setReady(b.player);
    await vi.advanceTimersByTimeAsync(r.timing.gapMs + 5);
    expect(r.stage()).not.toBe("betting");
    // Mid-round: the spot plays out and is freed when the round ends.
    expect(r.leaveSpot(a.player, 4)).toBeNull();
    expect(r.ownedSpots(a.player)).toEqual([3, 4]);
    expect(r.viewFor(b.player.id).spots[4]!.releasing).toBe(true);
    for (let i = 0; i < 200 && r.stage() !== "betting"; i += 1) {
      for (const p of [a.player, b.player]) if (r.viewFor(p.id).myLegal) r.submitAction(p, "stand");
      await vi.advanceTimersByTimeAsync(250);
    }
    expect(r.ownedSpots(a.player)).toEqual([3]);
    // The one who gave it up sits it out for this betting round (Rebet skips it too)...
    expect(r.viewFor(a.player.id).myBlockedSpots).toEqual([4]);
    expect(r.bet(a.player, 4, 10)).toMatch(/gave up spot 5/);
    expect(r.rebet(a.player)).toBeNull();
    expect(r.ownedSpots(a.player)).toEqual([3]);
    // ...while someone else can sit there now.
    expect(r.bet(b.player, 4, 10)).toBeNull();
    // Next betting round the block is gone.
    r.setReady(a.player);
    r.setReady(b.player);
    for (let i = 0; i < 40 && r.stage() === "betting"; i += 1) await vi.advanceTimersByTimeAsync(250);
    for (let i = 0; i < 200 && r.stage() !== "betting"; i += 1) {
      for (const p of [a.player, b.player]) if (r.viewFor(p.id).myLegal) r.submitAction(p, "stand");
      await vi.advanceTimersByTimeAsync(250);
    }
    expect(r.viewFor(a.player.id).myBlockedSpots).toEqual([]);
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
    r.leaveSpot(h.player, 1);
    r.leaveSpot(h.player, 2);
    r.setReady(h.player);
    await vi.advanceTimersByTimeAsync(r.timing.gapMs + 5);
    const dealt = h.messages.find((m) => m.events.some((e) => e.type === "roundStarted"))!;
    expect(dealt.view.dealer.cards[1]).toBeNull();
    expect(JSON.stringify(dealt)).not.toContain('"K"');
    r.close();
  });

  it("auto-stands when the clock runs out", async () => {
    const r = room({ table: rigged("10 9 6 7") }); // 16 vs 9: the human would usually hit
    const { player, messages } = human();
    r.join(player);
    for (const spot of [0, 1, 2]) r.bet(player, spot, 10);
    r.leaveSpot(player, 1);
    r.leaveSpot(player, 2);
    r.setReady(player);
    await vi.advanceTimersByTimeAsync(r.timing.gapMs + 30_000 + 10_000);
    const acted = messages.flatMap((m) => m.events).filter((e) => e.type === "playerActed" && e.spot === 0);
    expect(acted).toEqual([{ type: "playerActed", spot: 0, hand: 0, action: "stand", amount: 0 }]);
    r.close();
  });

  it("adds 30s when the turn passes to you, 5s per further decision, up to 60s", async () => {
    // Human alone on spot 0: 10,2 vs dealer 9 (hole 7), then 2s from the shoe.
    const r = room({ table: rigged("10 9 2 7") });
    const { player } = human();
    r.join(player);
    for (const spot of [0, 1, 2]) r.bet(player, spot, 10);
    r.leaveSpot(player, 1);
    r.leaveSpot(player, 2);
    r.setReady(player);
    const turnBank = async () => {
      await vi.advanceTimersByTimeAsync(1); // let the previous action land
      for (let i = 0; i < 40 && !r.viewFor(player.id).myLegal; i += 1) await vi.advanceTimersByTimeAsync(100);
      return r.viewFor(player.id).myTimeBankMs;
    };
    // The clock is live, so allow for the polling steps.
    const near = (ms: number, target: number) => {
      expect(ms).toBeLessThanOrEqual(target);
      expect(ms).toBeGreaterThan(target - 500);
    };
    near(await turnBank(), 30_000); // the turn came to us
    r.submitAction(player, "hit");
    near(await turnBank(), 35_000); // same player again: +5s
    r.submitAction(player, "hit");
    near(await turnBank(), 40_000);
    r.submitAction(player, "stand");

    // Next round: 40s left on the clock + 30s, capped at 60s.
    for (let i = 0; i < 100 && r.stage() !== "betting"; i += 1) await vi.advanceTimersByTimeAsync(250);
    r.bet(player, 0, 10);
    r.setReady(player);
    near(await turnBank(), 60_000);
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

describe("betting on the clock", () => {
  /** Play one round on spot 4 (standing), then return once the next betting window is open. */
  async function playOneRound(r: BlackjackRoom, player: HumanPlayer) {
    r.bet(player, 4, 10);
    r.setReady(player);
    for (let i = 0; i < 20 && r.stage() === "betting"; i += 1) await vi.advanceTimersByTimeAsync(250);
    for (let i = 0; i < 200 && r.stage() !== "betting"; i += 1) {
      if (r.viewFor(player.id).myLegal) r.submitAction(player, "stand");
      await vi.advanceTimersByTimeAsync(250);
    }
    expect(r.stage()).toBe("betting");
  }

  it("keeps bets open past the window while last round's players spend their clock", async () => {
    const r = room({ table: rigged("10 10 10 10 7 7 7 7 7 7") }); // everyone 17: no blackjacks, so we always get a turn
    const { player } = human();
    r.join(player);
    await playOneRound(r, player);
    const bank = r.viewFor(player.id).myTimeBankMs;
    expect(bank).toBeGreaterThan(5_000); // +20s for the hand, minus what we used
    expect(r.viewFor(player.id).myBettingClock).toBe("window");

    await vi.advanceTimersByTimeAsync(r.viewFor(player.id).phaseRemainingMs! + 2_000);
    const view = r.viewFor(player.id);
    expect(r.stage()).toBe("betting"); // window over, still open
    expect(view.myBettingClock).toBe("bank");
    expect(view.waitingFor).toEqual([player.name]);
    expect(view.phaseRemainingMs).toBeNull();
    expect(view.myTimeBankMs).toBeLessThanOrEqual(bank - 1_900);

    r.bet(player, 4, 10);
    expect(r.setReady(player)).toBeNull(); // Deal stops the drain and closes bets
    const kept = r.viewFor(player.id).myTimeBankMs;
    await vi.advanceTimersByTimeAsync(r.timing.gapMs + 5);
    expect(r.stage()).not.toBe("betting");
    expect(r.viewFor(player.id).myTimeBankMs).toBe(kept);
    r.close();
  });

  it("closes once the clock runs out (and the spot is given up if there's no bet)", async () => {
    const r = room({ table: rigged("10 10 10 10 7 7 7 7 7 7") });
    const { player } = human();
    r.join(player);
    await playOneRound(r, player);
    const window = r.viewFor(player.id).phaseRemainingMs!;
    const bank = r.viewFor(player.id).myTimeBankMs;
    await vi.advanceTimersByTimeAsync(window + bank + 50);
    expect(r.stage()).not.toBe("betting");
    expect(r.viewFor(player.id).myTimeBankMs).toBe(0);
    expect(r.ownedSpots(player)).toEqual([]);
    r.close();
  });

  it("doesn't hold bets for someone who didn't play last round", async () => {
    const r = room();
    const a = human();
    r.join(a.player);
    await playOneRound(r, a.player);
    const b = human(); // joins now: no betting on the clock for them
    r.join(b.player);
    r.bet(b.player, 6, 10);
    r.bet(a.player, 4, 10);
    expect(r.setReady(a.player)).toBeNull(); // a done; b holds spot 6 but isn't ready
    await vi.advanceTimersByTimeAsync(r.viewFor(b.player.id).phaseRemainingMs! + 5);
    expect(r.viewFor(b.player.id).myBettingClock).toBeNull();
    expect(r.stage()).not.toBe("betting");
    r.close();
  });
});

describe("payouts and the shoe", () => {
  it("pays a blackjack 3:2", async () => {
    const r = room({ table: rigged("A 9 K 7") });
    const { player } = human();
    r.join(player);
    for (const spot of [0, 1, 2]) r.bet(player, spot, 100);
    r.leaveSpot(player, 1);
    r.leaveSpot(player, 2);
    r.setReady(player);
    const afterBet = player.bankroll;
    await vi.advanceTimersByTimeAsync(r.timing.gapMs + 5);
    expect(r.table.spots[0]!.hands[0]!.result).toBe("blackjack");
    expect(player.bankroll - afterBet).toBe(250); // stake back + 150
    r.close();
  });

  it("only reveals the shoe to the nearest quarter deck", () => {
    const r = room();
    const { shoe } = r.viewFor(null);
    const quarters = (shoe.level * shoe.decks * 52) / 13;
    expect(Math.abs(quarters - Math.round(quarters))).toBeLessThan(1e-9);
    expect(shoe).not.toHaveProperty("cardsRemaining");
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

    for (let tick = 0; tick < 3_000 && rounds < 150; tick += 1) {
      const stage = r.stage();
      if (stage === "betting") {
        players.forEach(({ player }, i) => {
          const spot = 3 + i * 2;
          if (r.table.spots[spot]!.bet === 0) r.bet(player, spot, 10 + 10 * (tick % 5));
          r.setReady(player);
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
      expect(total()).toBe(start);
      await vi.advanceTimersByTimeAsync(500);
    }
    expect(rounds).toBeGreaterThan(50);
    expect(owners(r).slice(0, 3).every((o) => o === "bot")).toBe(true);
    r.close();
  });
});
