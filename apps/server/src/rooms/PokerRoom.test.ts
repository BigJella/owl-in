import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PokerStateMessage } from "@owl-in/shared";
import { HouseBank } from "../economy/HouseBank";
import { HumanPlayer } from "../players/HumanPlayer";
import type { GameSocket } from "../networking/types";
import { animationAllowanceMs, PokerRoom } from "./PokerRoom";
import { RoomManager } from "./RoomManager";

let humanCounter = 0;

/** A human with a fake connected socket that records what it was sent. */
function human(name = `human${++humanCounter}`) {
  const player = new HumanPlayer(`h-${name}`, `token-${name}`, name);
  const messages: PokerStateMessage[] = [];
  const socket = {
    connected: true,
    emit: (event: string, payload: unknown) => {
      if (event === "poker:state") messages.push(payload as PokerStateMessage);
    },
    disconnect() {},
  } as unknown as GameSocket;
  player.attach(socket);
  return { player, messages, socket };
}

function room(bigBlind = 10, bank = new HouseBank()) {
  const r = new PokerRoom({ id: "r1", name: "Test", bigBlind, bank });
  r.start();
  return r;
}

const kinds = (r: PokerRoom) => {
  const seats = r.viewFor(null).seats.filter((s) => s !== null);
  return { humans: seats.filter((s) => s.kind === "human").length, bots: seats.filter((s) => s.kind === "bot").length };
};

/** Advance until the room is between hands (or give up). */
async function runUntilIdle(r: PokerRoom) {
  for (let i = 0; i < 400 && r.table.phase !== "idle"; i += 1) await vi.advanceTimersByTimeAsync(500);
  expect(r.table.phase).toBe("idle");
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("bot fill", () => {
  it("fills an empty room with 4 bots at 60 big blinds", () => {
    const r = room();
    expect(kinds(r)).toEqual({ humans: 0, bots: 4 });
    expect(r.viewFor(null).seats.every((s) => s === null || s.stack === 600)).toBe(true);
    r.close();
  });

  it.each([
    [1, 3],
    [3, 1],
    [5, 0],
  ])("%i humans leave %i bots after the gap", async (humans, bots) => {
    const r = room();
    for (let i = 0; i < humans; i += 1) expect(r.join(human().player, 500)).toBeNull();
    expect(kinds(r)).toEqual({ humans: 0, bots: 4 }); // nothing changes until the gap
    await vi.advanceTimersByTimeAsync(r.timing.gapMs);
    expect(kinds(r)).toEqual({ humans, bots });
    r.close();
  });
});

describe("replacement", () => {
  it("replaces the bot whose stack is closest to the buy-in", async () => {
    const r = room();
    const botStacks = [200, 600, 1000, 400];
    r.viewFor(null).seats.forEach((s, i) => {
      if (s) r.table.seats[i]!.stack = botStacks[i]!;
    });
    const { player } = human();
    r.join(player, 950);
    await vi.advanceTimersByTimeAsync(r.timing.gapMs);
    const view = r.viewFor(player.id);
    expect(view.mySeat).toBe(2);
    expect(view.seats[2]!.kind).toBe("human");
    expect(view.seats[2]!.stack + view.seats[2]!.bet).toBe(950); // a hand may have started and taken a blind
    r.close();
  });

  it("makes a human who joins mid-hand wait for the next gap", async () => {
    const r = room();
    const first = human();
    r.join(first.player, 500);
    await vi.advanceTimersByTimeAsync(r.timing.gapMs); // hand 1 starts
    expect(r.table.phase).not.toBe("idle");

    const late = human();
    r.join(late.player, 500);
    expect(r.viewFor(late.player.id)).toMatchObject({ mySeat: null, amWaiting: true });

    // First human just times out / checks; bots play on.
    await runUntilIdle(r);
    expect(r.viewFor(late.player.id).mySeat).toBeNull();
    r.setReady(first.player);
    await vi.advanceTimersByTimeAsync(r.timing.gapMs);
    expect(r.viewFor(late.player.id).mySeat).not.toBeNull();
    expect(kinds(r)).toEqual({ humans: 2, bots: 2 });
    r.close();
  });
});

describe("turns", () => {
  it("auto check/folds a human whose clock runs out, then refills 20s next turn", async () => {
    const r = room();
    const { player } = human();
    r.join(player, 500);
    await vi.advanceTimersByTimeAsync(r.timing.gapMs);

    for (let i = 0; i < 200 && r.viewFor(player.id).myLegalActions === null && r.table.phase !== "idle"; i += 1) {
      await vi.advanceTimersByTimeAsync(250);
    }
    const view = r.viewFor(player.id);
    if (view.myLegalActions === null) return r.close(); // folded out before acting; nothing to check
    expect(view.turnRemainingMs).toBeLessThanOrEqual(20_000);
    await vi.advanceTimersByTimeAsync(20_001);
    expect(r.table.toAct).not.toBe(view.mySeat);
    expect(r.viewFor(player.id).seats[view.mySeat!]!.timeBankMs).toBe(0);
    r.close();
  });

  it("never sends a player anyone else's hole cards during a hand", async () => {
    const r = room();
    const a = human();
    r.join(a.player, 500);
    await vi.advanceTimersByTimeAsync(r.timing.gapMs);
    await runUntilIdle(r);
    for (const { view } of a.messages) {
      if (view.phase === "idle") continue;
      for (const seat of view.seats) expect(seat?.revealedCards ?? null).toBeNull();
      if (view.mySeat !== null) expect(view.myHoleCards.length).toBeLessThanOrEqual(2);
    }
    r.close();
  });
});

/** Seat one human, play a hand out, and stop at the between-hands ready phase. */
async function seatedAtReadyPhase() {
  const r = room();
  const h = human();
  r.join(h.player, 500);
  await vi.advanceTimersByTimeAsync(r.timing.gapMs);
  // Fold quickly whenever it's our turn so we keep most of our clock.
  for (let i = 0; i < 400 && r.table.phase !== "idle"; i += 1) {
    if (r.viewFor(h.player.id).myLegalActions) r.submitAction(h.player, { type: "fold" });
    await vi.advanceTimersByTimeAsync(250);
  }
  expect(r.table.phase).toBe("idle");
  return { r, h, handId: r.table.handId };
}

describe("ready-up between hands", () => {
  it("waits for the human to ready, then deals", async () => {
    const { r, h, handId } = await seatedAtReadyPhase();
    const view = r.viewFor(h.player.id);
    expect(view.seats[view.mySeat!]!.ready).toBe(false);
    await vi.advanceTimersByTimeAsync(r.timing.readyGraceMs - 500);
    expect(r.table.handId).toBe(handId); // still waiting

    r.setReady(h.player);
    await vi.advanceTimersByTimeAsync(r.timing.gapMs);
    expect(r.table.handId).toBe(handId + 1);
    r.close();
  });

  it("drains the clock after the grace period and auto-readies at zero", async () => {
    const { r, h, handId } = await seatedAtReadyPhase();
    const seat = r.viewFor(h.player.id).mySeat!;
    const bank = r.viewFor(h.player.id).seats[seat]!.timeBankMs;
    const grace = r.viewFor(h.player.id).readyGraceRemainingMs!;
    expect(grace).toBeGreaterThan(r.timing.readyGraceMs); // includes the end-of-hand animation allowance

    await vi.advanceTimersByTimeAsync(grace - 300);
    expect(r.viewFor(h.player.id).seats[seat]!.timeBankMs).toBe(bank); // grace: no drain yet
    await vi.advanceTimersByTimeAsync(300);
    if (bank > 0) {
      await vi.advanceTimersByTimeAsync(Math.min(1_000, bank));
      expect(r.viewFor(h.player.id).seats[seat]!.timeBankMs).toBeLessThan(bank);
    }
    await vi.advanceTimersByTimeAsync(bank + r.timing.gapMs + 10);
    expect(r.table.handId).toBe(handId + 1);
    r.close();
  });

  it("bot turns expose no clock", async () => {
    const r = room();
    r.join(human().player, 500);
    await vi.advanceTimersByTimeAsync(r.timing.gapMs);
    for (let i = 0; i < 100; i += 1) {
      const view = r.viewFor(null);
      if (view.toAct !== null && view.seats[view.toAct]!.kind === "bot") {
        expect(view.turnRemainingMs).toBeNull();
        expect(view.seats[view.toAct]!.timeBankMs).toBe(0);
        return r.close();
      }
      await vi.advanceTimersByTimeAsync(200);
    }
    r.close();
  });
});

describe("busting", () => {
  /** Ready phase with our human forced to 0 chips. */
  async function bustedAtReadyPhase() {
    const ctx = await seatedAtReadyPhase();
    const seat = ctx.r.viewFor(ctx.h.player.id).mySeat!;
    ctx.r.table.seats[seat]!.stack = 0;
    (ctx.r as unknown as { checkReady(): void }).checkReady();
    return { ...ctx, seat };
  }

  it("can't ready up with no chips; rebuying readies you and the hand deals", async () => {
    const { r, h, handId, seat } = await bustedAtReadyPhase();
    expect(r.setReady(h.player)).toMatch(/meal plan is empty/i);
    const view = r.viewFor(h.player.id);
    expect(view.rebuy).toMatchObject({ min: 200, max: 1_000 });
    expect(view.rebuy!.remainingMs).toBeLessThanOrEqual(r.timing.rebuyDecisionMs);

    await vi.advanceTimersByTimeAsync(r.timing.readyGraceMs + 10_000); // clock isn't touched while deciding
    expect(r.table.handId).toBe(handId);
    const bankroll = h.player.bankroll;
    expect(r.rebuy(h.player, 400)).toBeNull();
    expect(h.player.bankroll).toBe(bankroll - 400);
    await vi.advanceTimersByTimeAsync(r.timing.gapMs);
    expect(r.table.handId).toBe(handId + 1);
    expect(r.table.seats[seat]!.stack + r.table.seats[seat]!.bet).toBe(400);
    r.close();
  });

  it("removes a busted player who doesn't decide within 30s, with the rejoin penalty", async () => {
    const { r, h, handId } = await bustedAtReadyPhase();
    await vi.advanceTimersByTimeAsync(r.timing.rebuyDecisionMs + r.timing.gapMs + 10);
    expect(r.table.handId).toBe(handId + 1);
    expect(r.viewFor(h.player.id).mySeat).toBeNull();
    expect(h.player.roomId).toBeNull();
    expect(r.join(h.player, 500)).toMatch(/rejoin it in/);
    r.close();
  });

  it("cashing out after busting also carries the penalty", async () => {
    const { r, h } = await bustedAtReadyPhase();
    expect(r.leave(h.player)).toBeNull();
    expect(r.join(h.player, 500)).toMatch(/rejoin it in/);
    r.close();
  });

  it("gives the showdown animation time before clocks start", () => {
    const quiet = animationAllowanceMs([]);
    const showdown = animationAllowanceMs([
      { type: "communityDealt", street: "river", cards: [{ rank: "A", suit: "spades" }] },
      { type: "showdown", reveals: [] },
      { type: "potAwarded", potIndex: 0, amount: 100, winners: [{ seat: 0, amount: 100 }] },
    ]);
    expect(showdown - quiet).toBeGreaterThanOrEqual(2_500);
  });
});

describe("bot stack cap", () => {
  it("returns runaway bot winnings to the house only at tables with no humans", async () => {
    const bank = new HouseBank(1_000_000);
    const r = new PokerRoom({ id: "cap", name: "Cap", bigBlind: 10, bank });
    r.start();
    const botSeat = r.table.occupiedSeats()[0]!.seat;
    r.table.seats[botSeat]!.stack = 50_000;
    const total = () => bank.balance + r.table.totalChips();
    const before = total();
    (r as unknown as { maintainSeats(): void }).maintainSeats();
    expect(r.table.seats[botSeat]!.stack).toBe(2_000); // 200 big blinds
    expect(total()).toBe(before); // moved to the house, not destroyed

    const h = human();
    r.join(h.player, 500);
    r.table.seats[botSeat]!.stack = 50_000;
    (r as unknown as { maintainSeats(): void }).maintainSeats();
    expect(r.table.seats[botSeat]?.stack ?? 50_000).toBe(50_000); // a human is here: hands off
    r.close();
  });
});

describe("display info", () => {
  it("badges High Roller by stakes, not by how many chips bots have piled up", () => {
    const low = room(10);
    for (const seat of low.table.occupiedSeats()) seat.stack = 50_000; // huge bot stacks
    expect(low.summary().highRoller).toBe(false);
    const high = room(100);
    expect(high.summary().highRoller).toBe(true);
    low.close();
    high.close();
  });

  it("reports the stage: waiting, then each street, then how the hand ended", async () => {
    const r = room();
    expect(r.viewFor(null).stage).toBe("waiting");
    const { player } = human();
    r.join(player, 500);
    await vi.advanceTimersByTimeAsync(r.timing.gapMs);
    const seen = new Set<string>();
    for (let i = 0; i < 400 && r.table.phase !== "idle"; i += 1) {
      seen.add(r.viewFor(null).stage);
      if (r.viewFor(player.id).myLegalActions) r.submitAction(player, { type: "fold" });
      await vi.advanceTimersByTimeAsync(250);
    }
    expect(seen.has("preflop")).toBe(true);
    expect(["showdown", "hand-over"]).toContain(r.viewFor(null).stage);
    expect(r.summary().stage).toBe(r.viewFor(null).stage); // room list shows the same stage
    r.close();
  });
});

describe("leaving", () => {
  it("leaving between hands is immediate and blocks rejoining for 30 minutes", async () => {
    const { r, h } = await seatedAtReadyPhase();
    expect(r.viewFor(h.player.id).leaveMode).toBe("now");
    expect(r.leave(h.player)).toBeNull();
    expect(h.player.roomId).toBeNull();
    expect(h.player.bankroll).toBeGreaterThan(9_000);
    expect(r.join(h.player, 500)).toMatch(/rejoin it in 30 min/);
    await vi.advanceTimersByTimeAsync(r.timing.rejoinPenaltyMs);
    expect(r.join(h.player, 500)).toBeNull();
    r.close();
  });

  it("mid-hand cash-out is queued: shown to everyone, irreversible, removed when the hand ends", async () => {
    const r = room();
    const a = human();
    const b = human();
    r.join(a.player, 500);
    r.join(b.player, 500);
    await vi.advanceTimersByTimeAsync(r.timing.gapMs);
    expect(r.table.phase).not.toBe("idle");
    const seat = r.viewFor(a.player.id).mySeat!;
    expect(r.viewFor(a.player.id).leaveMode).toBe("after-hand");

    expect(r.leave(a.player)).toBeNull();
    expect(r.viewFor(a.player.id).leaveMode).toBe("queued");
    expect(r.viewFor(b.player.id).seats[seat]!.cashingOut).toBe(true); // others see it's their last hand
    expect(a.player.roomId).toBe(r.id); // still playing this hand
    expect(r.join(a.player, 500)).toMatch(/cashing out/); // can't undo

    for (let i = 0; i < 400 && r.table.phase !== "idle"; i += 1) {
      for (const p of [a.player, b.player]) if (r.viewFor(p.id).myLegalActions) r.submitAction(p, { type: "fold" });
      await vi.advanceTimersByTimeAsync(250);
    }
    expect(r.viewFor(b.player.id).seats[seat]?.playerId ?? null).not.toBe(a.player.id);
    expect(a.player.roomId).toBeNull();
    expect(r.join(a.player, 500)).toMatch(/rejoin it in/);
    r.close();
  });

  it("a table full of humans accepts a new player when someone is cashing out", async () => {
    const r = room();
    const seated = Array.from({ length: 8 }, () => human());
    for (const h of seated) r.join(h.player, 500);
    await vi.advanceTimersByTimeAsync(r.timing.gapMs);
    expect(r.table.phase).not.toBe("idle");
    const outsider = human();
    expect(r.join(outsider.player, 500)).toMatch(/full/);

    const leaver = seated.find((h) => !r.canLeaveNow(h.player))!;
    r.leave(leaver.player);
    expect(r.summary().cashingOut).toBe(1);
    expect(r.join(outsider.player, 500)).toBeNull();
    r.close();
  });

  it("cancelling a spot on the waiting list is free", () => {
    const r = room();
    const { player } = human();
    r.join(player, 500);
    expect(r.leave(player)).toBeNull();
    expect(player.bankroll).toBe(10_000);
    expect(r.join(player, 500)).toBeNull();
    r.close();
  });
});

describe("RoomManager", () => {
  it("keeps at least two rooms open", async () => {
    const manager = new RoomManager({ bank: new HouseBank() });
    manager.seed();
    manager.create("Empty one", 20);
    expect(manager.rooms.size).toBe(3);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(manager.rooms.size).toBe(2);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(manager.rooms.size).toBe(2);
    manager.shutdown();
  });

  it("bot-only rooms play about one hand a minute and conserve chips", async () => {
    const bank = new HouseBank(1_000_000);
    const manager = new RoomManager({ bank });
    manager.seed();
    const total = () => bank.balance + [...manager.rooms.values()].reduce((sum, r) => sum + r.table.totalChips(), 0);
    expect(total()).toBe(1_000_000);

    await vi.advanceTimersByTimeAsync(30 * 60_000);

    for (const r of manager.rooms.values()) {
      expect(r.table.handId).toBeGreaterThanOrEqual(28);
      expect(r.table.handId).toBeLessThanOrEqual(31);
    }
    expect(total()).toBe(1_000_000);
    manager.shutdown();
  });
});
