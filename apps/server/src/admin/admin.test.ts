import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import type { AddressInfo } from "node:net";
import type { AckResult, Session } from "@owl-in/shared";
import { HouseBank } from "../economy/HouseBank";
import { LlmTelemetry } from "../ai/LlmTelemetry";
import { PlayerRegistry } from "../players/PlayerRegistry";
import type { HumanPlayer } from "../players/HumanPlayer";
import { BlackjackRoomManager } from "../rooms/BlackjackRoomManager";
import { RoomManager } from "../rooms/RoomManager";
import type { PokerRoom } from "../rooms/PokerRoom";
import { registerConnection } from "../networking/handlers/connectionHandler";
import { MemoryStatsStore } from "../stats/MemoryStatsStore";
import type { GameSocket } from "../networking/types";
import { AdminError, AdminService } from "./AdminService";
import { adminRoutes } from "./adminRoutes";
import { Moderation } from "./Moderation";
import { isLocalOrigin, isLoopback } from "./security";

let counter = 0;

function setup() {
  const registry = new PlayerRegistry();
  const bank = new HouseBank();
  const moderation = new Moderation();
  const stats = new MemoryStatsStore();
  const rooms = new RoomManager({ bank, moderation, stats });
  const blackjack = new BlackjackRoomManager({ bank, moderation, stats });
  rooms.seed();
  blackjack.seed();
  const admin = new AdminService({ registry, rooms, blackjack, bank, moderation, stats, telemetry: new LlmTelemetry(false, "test") });

  /** A signed-in human with a fake socket that records what it's sent. */
  const human = (name = `p${++counter}`) => {
    const token = `token-${name}-0123456789`;
    const player = registry.identify(token, name) as HumanPlayer;
    const sent: { event: string; payload: unknown }[] = [];
    const socket = {
      connected: true,
      emit: (event: string, payload: unknown) => sent.push({ event, payload }),
      disconnect() {
        socket.connected = false;
      },
    };
    player.attach(socket as unknown as GameSocket);
    return { player, sent, socket, token };
  };
  const poker = () => [...rooms.rooms.values()][0]!;
  const bj = () => [...blackjack.rooms.values()][0]!;
  return { registry, bank, moderation, rooms, blackjack, admin, human, poker, bj };
}

/** Seat a human and advance until a hand is under way with them dealt in. */
async function seatedMidHand(room: PokerRoom, player: HumanPlayer) {
  expect(room.join(player, 500)).toBeNull();
  for (let i = 0; i < 100 && !(room.table.phase !== "idle" && room.viewFor(player.id).myHoleCards.length > 0); i += 1) {
    room.setReady(player);
    await vi.advanceTimersByTimeAsync(250);
  }
  expect(room.viewFor(player.id).myHoleCards).toHaveLength(2);
}

/** Fold and ready-up until the hand in progress is over. */
async function finishHand(room: PokerRoom, player: HumanPlayer) {
  for (let i = 0; i < 400 && room.table.phase !== "idle"; i += 1) {
    if (room.viewFor(player.id).myLegalActions) room.submitAction(player, { type: "fold" });
    await vi.advanceTimersByTimeAsync(250);
  }
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("snapshot", () => {
  it("adds up every Dining Dollar and never carries cards or tokens", async () => {
    const { admin, human, poker } = setup();
    const a = human();
    await seatedMidHand(poker(), a.player);
    const snapshot = admin.snapshot();
    expect(snapshot.totals.conserved).toBe(true);
    expect(snapshot.totals.playersKnown).toBe(1);
    expect(snapshot.tables).toHaveLength(4);
    const json = JSON.stringify(snapshot);
    expect(json).not.toContain('"suit"');
    expect(json).not.toContain(a.token);
    expect(snapshot.players[0]).toMatchObject({ name: a.player.name, atTable: 500, table: { game: "poker" } });
  });
});

describe("career", () => {
  it("returns the same career the game shows, private ones included, with no cards", async () => {
    const { admin, human, poker } = setup();
    const a = human();
    a.player.careerPublic = false;
    const room = poker();
    await seatedMidHand(room, a.player);
    await finishHand(room, a.player);
    const career = admin.career(a.player.id);
    expect(career).toMatchObject({ name: a.player.name, isMe: false, isPublic: false });
    expect(career.poker.hands).toBeGreaterThanOrEqual(1);
    expect(career.chipHistory.length).toBe(career.poker.hands + career.blackjack.hands);
    expect(JSON.stringify(career)).not.toContain('"suit"');
    expect(() => admin.career("nobody")).toThrow(/No player/);
  });
});

describe("tables", () => {
  it("creates tables with their own bot settings, and validates them", () => {
    const { admin } = setup();
    const t = admin.createTable({ game: "poker", name: "AI Night", bigBlind: 20, maxBots: 6, maxAi: 6 });
    expect(t).toMatchObject({ name: "AI Night", settings: { maxBots: 6, maxAi: 6 }, bots: 6, aiBots: 6 });
    expect(() => admin.createTable({ game: "poker", name: "X", bigBlind: 7 })).toThrow(AdminError);
    expect(() => admin.updateTable(t.id, { maxAi: 7 })).toThrow(/Max AI/);
    const b = admin.createTable({ game: "blackjack", name: "Solo", minBet: 10, maxBots: 0 });
    expect(b).toMatchObject({ bots: 0, settings: { maxBots: 0, maxAi: null } });
    expect(() => admin.updateTable(b.id, { maxBots: 4 })).toThrow(/spots 1/);
  });

  it("keeps two tables of each game open", () => {
    const { admin, poker } = setup();
    expect(() => admin.closeTable(poker().id)).toThrow(/At least 2/);
    const extra = admin.createTable({ game: "poker", name: "Extra", bigBlind: 10 });
    admin.closeTable(extra.id);
    expect(admin.tables().some((t) => t.id === extra.id)).toBe(false);
  });

  it("closes after the current hand, cashing everyone out with chips conserved", async () => {
    const { admin, human, rooms, poker } = setup();
    const room = poker();
    const a = human();
    await seatedMidHand(room, a.player);
    rooms.create("Extra", 10); // a third table, so this one may close
    admin.closeTable(room.id);
    expect(rooms.get(room.id)).toBeDefined(); // still playing the hand
    expect(room.join(human().player, 500)).toMatch(/closing/);
    await finishHand(room, a.player);
    expect(rooms.get(room.id)).toBeUndefined();
    expect(a.player.roomId).toBeNull();
    expect(a.sent.some((m) => m.event === "error-message" && String(m.payload).includes("closed by an admin"))).toBe(true);
    expect(admin.snapshot().totals.conserved).toBe(true);
  });

  it("switches bots between auto, script and AI", () => {
    const { admin, poker } = setup();
    const bot = poker().admin().seats.find((s) => s.botMode === "script")!;
    admin.setBotMode(bot.playerId, "llm");
    expect(poker().admin().seats.find((s) => s.playerId === bot.playerId)).toMatchObject({ botMode: "llm", botOverride: "llm" });
    admin.setBotMode(bot.playerId, "auto");
    expect(poker().admin().seats.find((s) => s.playerId === bot.playerId)!.botOverride).toBeNull();
    expect(() => admin.setBotMode("bjbot-1", "llm")).toThrow(/blackjack/);
  });

  it("fills only as many blackjack bot spots as the table allows", async () => {
    const { admin, bj, human } = setup();
    const room = bj();
    admin.updateTable(room.id, { maxBots: 1 });
    room.join(human().player); // a human opens betting, which reseats bots
    await vi.advanceTimersByTimeAsync(0);
    expect(room.admin().bots).toBe(1);
  });
});

describe("players", () => {
  it("kicks mid-hand at the end of the hand, with the given timeout", async () => {
    const { admin, human, poker, moderation } = setup();
    const a = human();
    const room = poker();
    await seatedMidHand(room, a.player);
    admin.kick(a.player.id, 10);
    expect(room.viewFor(a.player.id).leaveMode).toBe("queued");
    await finishHand(room, a.player);
    expect(a.player.roomId).toBeNull();
    expect(room.join(a.player, 500)).toMatch(/removed from this table.*10 min/);
    expect(moderation.tableTimeout(room.id, a.player.id)!.reason).toBe("Removed by an admin");
  });

  it("kicks with no timeout when asked", () => {
    const { admin, human, poker } = setup();
    const a = human();
    poker().join(a.player, 500); // waiting for the next hand
    admin.kick(a.player.id, 0);
    expect(a.player.roomId).toBeNull();
    expect(poker().join(a.player, 500)).toBeNull();
  });

  it("bans: removed, disconnected, refused at every table, and unbanned", () => {
    const { admin, human, poker, bj } = setup();
    const a = human();
    poker().join(a.player, 500);
    admin.ban(a.player.id, "spam");
    expect(a.sent.some((m) => m.event === "banned")).toBe(true);
    expect(a.socket.connected).toBe(false);
    expect(a.player.roomId).toBeNull();
    expect(a.player.bankroll).toBe(10_000); // buy-in refunded
    expect(poker().join(a.player, 500)).toMatch(/banned/);
    expect(bj().join(a.player)).toMatch(/banned/);
    expect(admin.snapshot().totals.banned).toBe(1);
    admin.unban(a.player.id);
    expect(poker().join(a.player, 500)).toBeNull();
  });

  it("adjusts bankrolls against the house, never below zero", () => {
    const { admin, human, bank } = setup();
    const a = human();
    const house = bank.balance;
    admin.adjustBankroll(a.player.id, 2_500);
    expect(a.player.bankroll).toBe(12_500);
    expect(bank.balance).toBe(house - 2_500);
    expect(() => admin.adjustBankroll(a.player.id, -20_000)).toThrow(/only has/);
    expect(admin.snapshot().totals.conserved).toBe(true);
  });

  it("renames, even while seated, and frees the old name", async () => {
    const { admin, human, poker, registry } = setup();
    const a = human("Rude");
    await seatedMidHand(poker(), a.player);
    admin.rename(a.player.id, "Polite");
    expect(poker().viewFor(null).seats.some((s) => s?.name === "Polite")).toBe(true);
    expect(registry.nameTaken("someone-else-token", "Rude")).toBe(false);
    const last = a.sent.filter((m) => m.event === "session").at(-1)!.payload as Session;
    expect(last.name).toBe("Polite");
    human("Taken");
    expect(() => admin.rename(a.player.id, "taken")).toThrow(/belongs to another/);
  });
});

describe("timeouts", () => {
  it("sitewide: off their table, refused everywhere, then over by itself", () => {
    const { admin, human, poker, bj } = setup();
    const a = human();
    poker().join(a.player, 500);
    admin.setTimeout({ playerId: a.player.id, scope: "site", minutes: 5, reason: "cool off" });
    expect(a.player.roomId).toBeNull();
    expect(poker().join(a.player, 500)).toMatch(/timed out from every table for 5 more min/);
    expect(bj().join(a.player)).toMatch(/timed out/);
    expect(admin.players()[0]!.timeout).toMatchObject({ reason: "cool off" });
    vi.advanceTimersByTime(5 * 60_000);
    expect(poker().join(a.player, 500)).toBeNull();
  });

  it("lists, edits and removes per-table timeouts, including the automatic rejoin lockout", async () => {
    const { admin, human, poker } = setup();
    const a = human();
    const room = poker();
    await seatedMidHand(room, a.player);
    room.leave(a.player); // queued cash-out, then the 30-min lockout
    await finishHand(room, a.player);
    expect(admin.timeouts()).toMatchObject([{ scope: "table", roomId: room.id, playerName: a.player.name }]);
    admin.setTimeout({ playerId: a.player.id, scope: "table", roomId: room.id, minutes: 90 });
    expect(admin.timeouts()[0]!.remainingMs).toBe(90 * 60_000);
    admin.clearTimeout({ playerId: a.player.id, scope: "table", roomId: room.id });
    expect(admin.timeouts()).toEqual([]);
    expect(room.join(a.player, 500)).toBeNull();
    expect(() => admin.clearTimeout({ playerId: a.player.id, scope: "site" })).toThrow(/No such/);
  });
});

describe("bans at the door", () => {
  it("refuses a banned browser at connect and at identify", async () => {
    const { registry, rooms, blackjack, moderation } = setup();
    const token = "0123456789abcdef0123456789abcdef";
    const player = registry.identify(token, "Banned") as HumanPlayer;
    moderation.ban(player.id, null);
    const sent: string[] = [];
    let handlers = 0;
    let disconnected = false;
    const socket = {
      handshake: { auth: { token } },
      emit: (event: string) => sent.push(event),
      on: () => (handlers += 1),
      disconnect: () => (disconnected = true),
    } as unknown as GameSocket;
    registerConnection(socket, { registry, rooms, blackjack, stats: new MemoryStatsStore(), moderation, publishLobby() {} });
    expect(sent).toContain("banned");
    expect(disconnected).toBe(true);
    expect(handlers).toBe(0);
  });

  it("answers identify with code banned if the ban lands after connect", async () => {
    const { registry, rooms, blackjack, moderation } = setup();
    const token = "fedcba9876543210fedcba9876543210";
    const handlers = new Map<string, (...args: unknown[]) => void>();
    const socket = {
      connected: true,
      handshake: { auth: { token } },
      emit() {},
      on: (event: string, handler: (...args: unknown[]) => void) => handlers.set(event, handler),
      join() {},
      leave() {},
      disconnect() {},
    } as unknown as GameSocket;
    registerConnection(socket, { registry, rooms, blackjack, stats: new MemoryStatsStore(), moderation, publishLobby() {} });
    const identify = () => new Promise<AckResult<{ session: Session }>>((resolve) => handlers.get("identify")!({ name: "Late", careerPublic: true }, resolve));
    expect(await identify()).toMatchObject({ ok: true });
    moderation.ban(registry.get(token)!.id, null);
    expect(await identify()).toMatchObject({ ok: false, code: "banned" });
  });
});

describe("security", () => {
  it("knows loopback addresses and local origins", () => {
    expect(["127.0.0.1", "::1", "::ffff:127.0.0.1"].every(isLoopback)).toBe(true);
    expect(["192.168.1.20", "::ffff:192.168.1.20", undefined].some(isLoopback)).toBe(false);
    expect(isLocalOrigin("http://localhost:5173")).toBe(true);
    expect(isLocalOrigin("http://127.0.0.1:3000")).toBe(true);
    expect(isLocalOrigin("https://evil.example")).toBe(false);
    expect(isLocalOrigin("http://localhost.evil.example")).toBe(false);
    expect(isLocalOrigin("null")).toBe(false);
  });

  it("serves curl and local pages, refuses other websites and header-less writes", async () => {
    vi.useRealTimers();
    const { admin, human } = setup();
    const a = human();
    const app = express();
    app.use("/api/admin", adminRoutes(admin));
    const server = app.listen(0, "127.0.0.1");
    await new Promise((resolve) => server.once("listening", resolve));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/admin`;
    try {
      const plain = await fetch(`${base}/snapshot`);
      expect(plain.status).toBe(200);
      expect(((await plain.json()) as { totals: { conserved: boolean } }).totals.conserved).toBe(true);

      const evil = await fetch(`${base}/snapshot`, { headers: { Origin: "https://evil.example" } });
      expect(evil.status).toBe(403);

      const post = (headers: Record<string, string>) =>
        fetch(`${base}/players/${a.player.id}/bankroll`, {
          method: "POST",
          headers: { "Content-Type": "application/json", ...headers },
          body: JSON.stringify({ delta: 100 }),
        });
      expect((await post({})).status).toBe(403);
      expect((await post({ "X-Owl-Admin": "1", Origin: "https://evil.example" })).status).toBe(403);
      const ok = await post({ "X-Owl-Admin": "1", Origin: "http://localhost:5173" });
      expect(ok.status).toBe(200);
      expect(ok.headers.get("access-control-allow-origin")).toBe("http://localhost:5173");
      expect(a.player.bankroll).toBe(10_100);

      const preflight = await fetch(`${base}/players/x/ban`, { method: "OPTIONS", headers: { Origin: "http://localhost:5173" } });
      expect(preflight.status).toBe(204);
      expect(preflight.headers.get("access-control-allow-headers")).toMatch(/x-owl-admin/i);

      const bad = await fetch(`${base}/players/${a.player.id}/bankroll`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Owl-Admin": "1" },
        body: JSON.stringify({ delta: "lots" }),
      });
      expect(bad.status).toBe(400);
      expect((await fetch(`${base}/nope`)).status).toBe(404);
    } finally {
      server.close();
    }
  });
});
