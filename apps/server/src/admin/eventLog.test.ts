import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BlackjackRoundLog, PokerHandLog } from "@owl-in/shared";
import { HouseBank } from "../economy/HouseBank";
import { LlmTelemetry } from "../ai/LlmTelemetry";
import { PlayerRegistry } from "../players/PlayerRegistry";
import type { HumanPlayer } from "../players/HumanPlayer";
import { BlackjackRoomManager } from "../rooms/BlackjackRoomManager";
import { RoomManager } from "../rooms/RoomManager";
import { MemoryStatsStore } from "../stats/MemoryStatsStore";
import type { GameSocket } from "../networking/types";
import { AdminService } from "./AdminService";
import { EventLog, type NewLogEntry } from "./EventLog";
import { Moderation } from "./Moderation";

let counter = 0;

function setup() {
  const registry = new PlayerRegistry();
  const bank = new HouseBank();
  const moderation = new Moderation();
  const stats = new MemoryStatsStore();
  const eventLog = new EventLog();
  const rooms = new RoomManager({ bank, moderation, stats, eventLog });
  const blackjack = new BlackjackRoomManager({ bank, moderation, stats, eventLog });
  rooms.seed();
  blackjack.seed();
  const admin = new AdminService({ registry, rooms, blackjack, bank, moderation, stats, eventLog, telemetry: new LlmTelemetry(false, "test") });
  const human = (name = `log${++counter}`) => {
    const player = registry.identify(`token-${name}-0123456789`, name) as HumanPlayer;
    const socket = { connected: true, emit() {}, disconnect() {} };
    player.attach(socket as unknown as GameSocket);
    return player;
  };
  return { admin, eventLog, rooms, blackjack, human };
}

const entry = (over: Partial<NewLogEntry> = {}): NewLogEntry => ({
  kind: "hand",
  game: "poker",
  table: { id: "t1", name: "Freshman Meal Plan" },
  summary: "Hand #1",
  players: [{ playerId: null, name: "Ada", kind: "bot" }],
  ...over,
});

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("EventLog", () => {
  it("keeps each kind separately, so busy tables never push out admin actions", () => {
    const log = new EventLog({ hand: 3, llm: 3, admin: 3 });
    log.add(entry({ kind: "admin", summary: "Banned Sam" }));
    for (let i = 0; i < 10; i += 1) log.add(entry({ summary: `Hand #${i}` }));
    expect(log.counts()).toEqual({ hand: 3, llm: 0, admin: 1 });
    const page = log.query();
    expect(page.entries.map((e) => e.summary)).toEqual(["Hand #9", "Hand #8", "Hand #7", "Banned Sam"]);
  });

  it("filters by kind, game, table, player, text and human hands", () => {
    const log = new EventLog();
    log.add(entry());
    log.add(entry({ game: "blackjack", table: { id: "t2", name: "Owl's Nest" }, players: [{ playerId: "p1", name: "Sam", kind: "human" }] }));
    log.add(entry({ kind: "llm", summary: "Ada: call" }));
    log.add(entry({ kind: "admin", game: null, table: null, summary: "Gave Sam $100", players: [{ playerId: "p1", name: "Sam", kind: "human" }] }));
    const summaries = (q: Parameters<EventLog["query"]>[0]) => log.query(q).entries.map((e) => e.id);
    expect(summaries({ kinds: ["llm", "admin"] })).toEqual([4, 3]);
    expect(summaries({ game: "blackjack" })).toEqual([2]);
    expect(summaries({ tableId: "t1" })).toEqual([3, 1]);
    expect(summaries({ playerId: "p1" })).toEqual([4, 2]);
    expect(summaries({ q: "owl's" })).toEqual([2]);
    expect(summaries({ q: "gave sam" })).toEqual([4]);
    expect(summaries({ kinds: ["hand"], humansOnly: true })).toEqual([2]);
  });

  it("pages back with before and polls forward with after", () => {
    const log = new EventLog();
    for (let i = 0; i < 7; i += 1) log.add(entry());
    const first = log.query({ limit: 3 });
    expect(first.entries.map((e) => e.id)).toEqual([7, 6, 5]);
    expect(first.more).toBe(true);
    const older = log.query({ limit: 3, before: 5 });
    expect(older.entries.map((e) => e.id)).toEqual([4, 3, 2]);
    expect(log.query({ limit: 3, before: 2 }).more).toBe(false);
    expect(log.query({ after: 5 }).entries.map((e) => e.id)).toEqual([7, 6]);
    expect(log.query({ limit: 0 }).entries).toHaveLength(1); // clamped to at least one
  });
});

describe("admin actions", () => {
  it("logs what was done and who it was about, and refusals with the reason", () => {
    const { admin, eventLog, rooms, human } = setup();
    const sam = human("Sam");
    admin.adjustBankroll(sam.id, 250);
    expect(() => admin.kick(sam.id)).toThrow(/isn't at a table/);
    const room = [...rooms.rooms.values()][0]!;
    room.join(sam, 500);
    admin.kick(sam.id, 10);

    const [kick, refused, gave] = eventLog.query({ kinds: ["admin"] }).entries;
    expect(gave!.summary).toBe("Gave Sam $250 (bankroll now $10,250)");
    expect(gave!.admin).toMatchObject({ action: "bankroll", ok: true, target: { playerId: sam.id, name: "Sam", kind: "human" } });
    expect(refused!.admin).toMatchObject({ action: "kick", ok: false, error: "Sam isn't at a table." });
    expect(refused!.summary).toMatch(/^Refused: Kick Sam/);
    expect(kick!.summary).toBe(`Kicked Sam from ${room.name} with a 10-minute timeout`);
    expect(kick!.table).toEqual({ id: room.id, name: room.name });
    expect(kick!.game).toBe("poker");
    expect(kick!.players).toEqual([{ playerId: sam.id, name: "Sam", kind: "human" }]);
  });

  it("logs table changes and bot pins by name", () => {
    const { admin, eventLog } = setup();
    const table = admin.createTable({ game: "poker", name: "Late Night", bigBlind: 20, maxBots: 3, maxAi: 1 });
    admin.updateTable(table.id, { maxBots: 5 });
    const bot = admin.table(table.id).seats.find((s) => s.kind === "bot")!;
    admin.setBotMode(bot.playerId, "llm");
    admin.setBotMode(bot.playerId, "auto");
    const lines = eventLog
      .query({ kinds: ["admin"] })
      .entries.map((e) => e.summary)
      .reverse();
    expect(lines).toEqual([
      "Created poker table Late Night ($10/$20, max bots 3, max AI 1)",
      "Late Night: max bots 5",
      `Pinned ${bot.name} to AI`,
      `Set ${bot.name} back to Auto`,
    ]);
  });
});

describe("hands", () => {
  it("logs every poker hand, bot-only tables included, without hidden cards", async () => {
    const { eventLog } = setup();
    await vi.advanceTimersByTimeAsync(150_000);
    const hands = eventLog.query({ kinds: ["hand"], game: "poker" }).entries;
    expect(hands.length).toBeGreaterThan(0);
    for (const e of hands) {
      const hand = e.hand as PokerHandLog;
      expect(hand.game).toBe("poker");
      expect(e.summary).toMatch(new RegExp(`^Hand #${hand.handId} · pot \\$`));
      expect(hand.seats.reduce((sum, s) => sum + s.net, 0)).toBe(0); // chips only move between seats
      for (const seat of hand.seats) {
        expect(seat.player.kind).toBe("bot");
        // Cards appear only for players who showed them at a showdown.
        if (seat.shown) expect(seat.showdownHand).not.toBeNull();
        else expect(seat.showdownHand).toBeNull();
      }
    }
  });

  it("logs a human's poker hand with their id, so the panel can open their career", async () => {
    const { eventLog, rooms, human } = setup();
    const ada = human("Ada");
    const room = [...rooms.rooms.values()][0]!;
    expect(room.join(ada, 500)).toBeNull();
    for (let i = 0; i < 600 && eventLog.query({ kinds: ["hand"], humansOnly: true }).entries.length === 0; i += 1) {
      room.setReady(ada);
      if (room.viewFor(ada.id).myLegalActions) room.submitAction(ada, { type: "fold" });
      await vi.advanceTimersByTimeAsync(250);
    }
    const [hand] = eventLog.query({ kinds: ["hand"], humansOnly: true }).entries;
    expect(hand!.players).toContainEqual({ playerId: ada.id, name: "Ada", kind: "human" });
    expect(eventLog.query({ playerId: ada.id }).entries[0]!.id).toBe(hand!.id);
  });

  it("logs every blackjack round with the dealer and each spot's net", async () => {
    const { eventLog } = setup();
    await vi.advanceTimersByTimeAsync(60_000);
    const rounds = eventLog.query({ kinds: ["hand"], game: "blackjack" }).entries;
    expect(rounds.length).toBeGreaterThan(0);
    const round = rounds[0]!.hand as BlackjackRoundLog;
    expect(round.dealer.cards.length).toBeGreaterThanOrEqual(2);
    expect(round.spots.length).toBeGreaterThan(0);
    for (const spot of round.spots) {
      const net = spot.insurancePayout - spot.insurance + spot.hands.reduce((sum, h) => sum + h.payout - h.bet, 0);
      expect(spot.net).toBe(net);
    }
    expect(rounds[0]!.summary).toMatch(new RegExp(`^Round #${round.roundId} · dealer `));
  });
});
