import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PlayingCard } from "@owl-in/shared";
import { HouseBank } from "../economy/HouseBank";
import { HumanPlayer } from "../players/HumanPlayer";
import type { GameSocket } from "../networking/types";
import type { CompleteFn, LlmDecisionLog } from "../ai/LlmStrategy";
import { PokerRoom, type RoomTiming } from "./PokerRoom";

let humanCounter = 0;

function human(name = `llmh${++humanCounter}`) {
  const player = new HumanPlayer(`h-${name}`, `token-${name}`, name);
  const socket = { connected: true, emit() {}, disconnect() {} } as unknown as GameSocket;
  player.attach(socket);
  return player;
}

const TIMING: Partial<RoomTiming> = { botDelayMs: [2_000, 2_000], botOnlyDelayMs: 2_000, streetPauseMs: 0, botSafetyMs: 5_000 };

function room(complete: CompleteFn | null, botsPerTable = 4, log?: (d: LlmDecisionLog) => void) {
  const r = new PokerRoom({
    id: "llm",
    name: "LLM test",
    bigBlind: 10,
    bank: new HouseBank(),
    timing: TIMING,
    llm: { botsPerTable, complete, ...(log ? { log } : {}) },
  });
  r.start();
  return r;
}

const modes = (r: PokerRoom) => r.viewFor(null).seats.flatMap((s) => (s ? [s.botMode] : []));
const actingBot = (r: PokerRoom) => {
  const seat = r.table.toAct;
  return seat !== null && r.viewFor(null).seats[seat]?.kind === "bot" ? seat : null;
};

/** Seat a human (who folds whenever asked) and advance until a bot is to act. */
async function untilBotTurn(r: PokerRoom, player: HumanPlayer) {
  for (let i = 0; i < 200; i += 1) {
    if (r.viewFor(player.id).myLegalActions) r.submitAction(player, { type: "fold" });
    if (actingBot(r) !== null) return actingBot(r)!;
    await vi.advanceTimersByTimeAsync(50);
  }
  throw new Error("no bot turn");
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("LLM bots", () => {
  it("seats OWL_LLM_BOTS bots in LLM mode and the rest as script", () => {
    const r = room(null, 2);
    expect(modes(r).sort()).toEqual(["llm", "llm", "script", "script"]);
    r.close();
  });

  it("never calls the model at a table with no humans", async () => {
    const complete = vi.fn<CompleteFn>(async () => '{"type":"call"}');
    const r = room(complete);
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(r.table.handId).toBeGreaterThan(1);
    expect(complete).not.toHaveBeenCalled();
    r.close();
  });

  it("asks at turn start but applies the answer only after the thinking pause", async () => {
    const complete = vi.fn<CompleteFn>(async () => '{"type":"call"}');
    const r = room(complete);
    const h = human();
    r.join(h, 500);
    const seat = await untilBotTurn(r, h);
    const turnId = (r as unknown as { turnCounter: number }).turnCounter;
    await vi.advanceTimersByTimeAsync(0);
    expect(complete).toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1_500);
    expect(r.table.toAct).toBe(seat); // answer is in, but the bot is still "thinking"
    await vi.advanceTimersByTimeAsync(600);
    expect((r as unknown as { turnCounter: number }).turnCounter > turnId || r.table.toAct !== seat).toBe(true);
    r.close();
  });

  it("only sends the bot its own hole cards", async () => {
    const prompts: string[] = [];
    const r = room(async (prompt) => {
      prompts.push(prompt);
      return '{"type":"call"}';
    });
    const h = human();
    r.join(h, 500);
    const seat = await untilBotTurn(r, h);
    await vi.advanceTimersByTimeAsync(0);
    const text = (c: PlayingCard) => `${c.rank === "10" ? "T" : c.rank}${c.suit[0]!.toLowerCase()}`;
    const prompt = prompts.at(-1)!;
    for (const card of r.table.seats[seat]!.holeCards) expect(prompt).toContain(text(card));
    r.table.seats.forEach((s, i) => {
      if (!s || i === seat) return;
      for (const card of s.holeCards) expect(prompt).not.toMatch(new RegExp(`\\b${text(card)}\\b`));
    });
    expect(prompt).toContain("posts SB");
    expect(prompt).toContain("posts BB");
    r.close();
  });

  it("falls back to the script when the model call fails, and logs why", async () => {
    const logs: LlmDecisionLog[] = [];
    const r = room(async () => "no json here", 4, (d) => logs.push(d));
    const h = human();
    r.join(h, 500);
    await untilBotTurn(r, h);
    await vi.advanceTimersByTimeAsync(2_100);
    expect(logs.length).toBeGreaterThan(0);
    expect(logs[0]!.fallback).toBeTruthy();
    r.close();
  });

  it("takes the default action when the model hangs past the safety cap", async () => {
    const complete: CompleteFn = (_p, signal) =>
      new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(new Error("aborted"))));
    const r = room(complete);
    const h = human();
    r.join(h, 500);
    const seat = await untilBotTurn(r, h);
    const turnId = (r as unknown as { turnCounter: number }).turnCounter;
    await vi.advanceTimersByTimeAsync(6_000);
    expect(r.table.toAct).toBe(seat); // within think + safety (7s)
    await vi.advanceTimersByTimeAsync(1_100);
    expect((r as unknown as { turnCounter: number }).turnCounter > turnId || r.table.toAct !== seat).toBe(true);
    r.close();
  });

  it("setBotMode switches a bot and shows it in the view", () => {
    const r = room(null, 0);
    const bot = r.viewFor(null).seats.find((s) => s?.kind === "bot")!;
    expect(bot.botMode).toBe("script");
    expect(r.setBotMode(bot.playerId, "llm")).toBe(true);
    expect(r.viewFor(null).seats[bot.seat]!.botMode).toBe("llm");
    expect(r.setBotMode("nobody", "llm")).toBe(false);
    r.close();
  });

  it("logs every betting action of the hand and resets it each hand", async () => {
    const r = room(null, 0);
    const h = human();
    r.join(h, 500);
    await untilBotTurn(r, h);
    const view = r.viewFor(h.id);
    expect(view.handActions.slice(0, 2).map((a) => a.action)).toEqual(["sb", "bb"]);
    expect(view.handActions[1]).toMatchObject({ street: "preflop", amount: 10, betTo: 10 });
    expect(view.handActions[1]!.name).toBe(view.seats.find((s) => s?.blind === "BB")!.name);
    const hand = r.table.handId;
    for (let i = 0; i < 400 && r.table.handId === hand; i += 1) {
      if (r.viewFor(h.id).myLegalActions) r.submitAction(h, { type: "fold" });
      if (r.table.phase === "idle") r.setReady(h);
      await vi.advanceTimersByTimeAsync(250);
    }
    expect(r.table.handId).toBe(hand + 1);
    expect(r.viewFor(h.id).handActions.slice(0, 2).map((a) => a.action)).toEqual(["sb", "bb"]);
    r.close();
  });
});
