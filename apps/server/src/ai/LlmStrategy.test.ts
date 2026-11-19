import { describe, expect, it, vi } from "vitest";
import type { PokerAction, PokerTableView } from "@owl-in/shared";
import { buildPrompt, LlmStrategy, parseAction, type LlmDecisionLog } from "./LlmStrategy";
import type { PokerStrategy } from "./PokerStrategy";
import { claudeArgs, claudeAvailable, parseCliOutput, ACTION_SCHEMA } from "./claudeCli";
import { readLlmConfig } from "./llmConfig";

const seat = (n: number, name: string, extra: object = {}) => ({
  seat: n, playerId: `p${n}`, name, kind: "bot" as const, botMode: "llm" as const, stack: 500, bet: 0, contributed: 0,
  lastAction: null, isButton: false, blind: null, status: "active" as const, connected: true, hasCards: true,
  revealedCards: null, revealedHand: null, timeBankMs: 0, ready: null, rebuying: false, leaving: false, cashingOut: false,
  ...extra,
});

function view(): PokerTableView {
  return {
    roomId: "r", name: "Test", smallBlind: 5, bigBlind: 10, handId: 7, phase: "flop", stage: "flop", button: 0,
    toAct: 1, turnRemainingMs: null, readyGraceRemainingMs: null, leaveMode: "after-hand", rebuy: null, nextHandInMs: null,
    community: [{ rank: "10", suit: "hearts" }, { rank: "7", suit: "clubs" }, { rank: "2", suit: "spades" }],
    pots: [{ amount: 60, eligibleSeats: [0, 1, 2] }],
    currentBet: 20,
    handActions: [
      { street: "preflop", seat: 1, name: "Ada", action: "sb", amount: 5, betTo: 5, allIn: false },
      { street: "preflop", seat: 2, name: "Turing", action: "bb", amount: 10, betTo: 10, allIn: false },
      { street: "preflop", seat: 0, name: "Sam", action: "call", amount: 10, betTo: 10, allIn: false },
      { street: "flop", seat: 0, name: "Sam", action: "bet", amount: 20, betTo: 20, allIn: false },
    ],
    seats: [seat(0, "Sam", { kind: "human", botMode: null, isButton: true, bet: 20, contributed: 30 }),
      seat(1, "Ada", { blind: "SB", contributed: 10 }), seat(2, "Turing", { blind: "BB", contributed: 10 }), null, null, null, null, null],
    mySeat: 1,
    myHoleCards: [{ rank: "A", suit: "hearts" }, { rank: "K", suit: "hearts" }],
    myLegalActions: { canFold: true, canCheck: false, canCall: true, callAmount: 20, canRaise: true, minRaiseTo: 40, maxRaiseTo: 500 },
    waitingList: [],
    amWaiting: false,
  } as unknown as PokerTableView;
}

const script: PokerStrategy = { name: "script", decide: async () => ({ type: "call" }) };

describe("buildPrompt", () => {
  it("describes the seat's own cards, board, players and the hand's action", () => {
    const p = buildPrompt(view());
    expect(p).toContain("Your cards: Ah Kh");
    expect(p).toContain("Board: Th 7c 2s");
    expect(p).toContain("Ada (you) [SB]");
    expect(p).toContain("Sam [button]: stack 500");
    expect(p).toMatch(/preflop:\n {2}Ada posts SB 5\n {2}Turing posts BB 10\n {2}Sam calls 10\nflop:\n {2}Sam bets 20/);
    expect(p).toContain("To call: 20.");
    expect(p).toContain("40 to 500");
  });
});

describe("parseAction", () => {
  it("reads structured replies and tolerates surrounding text", () => {
    expect(parseAction('{"type":"raise","to":120}')).toEqual({ type: "raise", to: 120 });
    expect(parseAction('Sure: {"type":"fold"}')).toEqual({ type: "fold" });
    expect(() => parseAction('{"type":"shove"}')).toThrow();
    expect(() => parseAction("nope")).toThrow();
  });
});

describe("LlmStrategy", () => {
  it("clamps an illegal raise into the legal range", async () => {
    const s = new LlmStrategy(script, async () => '{"type":"raise","to":99999}');
    expect(await s.decide(view(), new AbortController().signal)).toEqual({ type: "raise", to: 500 });
  });

  it("falls back to the script on a bad reply or a failed call, and logs the reason", async () => {
    const logs: LlmDecisionLog[] = [];
    const bad = new LlmStrategy(script, async () => "garbage", (d) => logs.push(d));
    const failing = new LlmStrategy(script, async () => Promise.reject(new Error("timeout")), (d) => logs.push(d));
    expect(await bad.decide(view(), new AbortController().signal)).toEqual({ type: "call" });
    expect(await failing.decide(view(), new AbortController().signal)).toEqual({ type: "call" });
    expect(logs.map((l) => l.fallback)).toEqual([expect.stringContaining("unrecognized"), "timeout"]);
    expect(logs[0]).toMatchObject({ table: "Test", bot: "Ada", handId: 7 });
  });

  it("uses the script when no model is available", async () => {
    const decide = vi.fn(async (): Promise<PokerAction> => ({ type: "call" }));
    const s = new LlmStrategy({ name: "s", decide }, null);
    await s.decide(view(), new AbortController().signal);
    expect(decide).toHaveBeenCalled();
  });

  it("gives up silently once the turn is aborted", async () => {
    const abort = new AbortController();
    const s = new LlmStrategy(script, async () => {
      abort.abort();
      throw new Error("aborted");
    });
    await expect(s.decide(view(), abort.signal)).rejects.toThrow("aborted");
  });
});

describe("claude CLI", () => {
  it("builds a stateless, tool-less, schema-constrained call", () => {
    const args = claudeArgs("claude-haiku-5-5");
    expect(args).toContain("-p");
    expect(args[args.indexOf("--model") + 1]).toBe("claude-haiku-5-5");
    expect(JSON.parse(args[args.indexOf("--json-schema") + 1]!)).toEqual(ACTION_SCHEMA);
    expect(args[args.indexOf("--tools") + 1]).toBe("");
    expect(args).toContain("--no-session-persistence");
  });

  it("parses the CLI's JSON output", () => {
    expect(parseCliOutput('{"is_error":false,"result":"x","structured_output":{"type":"check"}}')).toBe('{"type":"check"}');
    expect(parseCliOutput('{"is_error":false,"result":"{\\"type\\":\\"fold\\"}"}')).toBe('{"type":"fold"}');
    expect(() => parseCliOutput('{"is_error":true,"result":"rate limited"}')).toThrow("rate limited");
  });

  it("detects whether the binary runs", async () => {
    expect(await claudeAvailable(process.execPath)).toBe(true); // node --version
    expect(await claudeAvailable("definitely-not-a-real-binary-owl")).toBe(false);
  });
});

describe("readLlmConfig", () => {
  it("defaults to no LLM bots and Haiku", () => {
    expect(readLlmConfig({})).toEqual({ botsPerTable: 0, model: "claude-haiku-5-5", timeoutMs: 15_000, bin: "claude" });
  });

  it("accepts a count or 'all', clamped to the bot fill target", () => {
    expect(readLlmConfig({ OWL_LLM_BOTS: "2" }).botsPerTable).toBe(2);
    expect(readLlmConfig({ OWL_LLM_BOTS: "all" }).botsPerTable).toBe(4);
    expect(readLlmConfig({ OWL_LLM_BOTS: "9" }).botsPerTable).toBe(4);
    expect(readLlmConfig({ OWL_LLM_BOTS: "x" }).botsPerTable).toBe(0);
  });
});
