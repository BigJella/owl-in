import { describe, expect, it } from "vitest";
import type { AckResult, Session } from "@owl-in/shared";
import { HouseBank } from "../../economy/HouseBank";
import { PlayerRegistry } from "../../players/PlayerRegistry";
import { BlackjackRoomManager } from "../../rooms/BlackjackRoomManager";
import { RoomManager } from "../../rooms/RoomManager";
import { MemoryStatsStore } from "../../stats/MemoryStatsStore";
import type { GameSocket } from "../types";
import { registerConnection } from "./connectionHandler";

type Handler = (...args: unknown[]) => void;

/** A socket that records what it was sent and lets the test fire client events. */
function fakeSocket(token: unknown) {
  const handlers = new Map<string, Handler>();
  const sent: { event: string; payload: unknown }[] = [];
  const socket = {
    id: `sock-${Math.random()}`,
    connected: true,
    handshake: { auth: { token } },
    on: (event: string, handler: Handler) => handlers.set(event, handler),
    emit: (event: string, payload: unknown) => sent.push({ event, payload }),
    join() {},
    leave() {},
    disconnect() {},
  } as unknown as GameSocket;
  const identify = (request: unknown) =>
    new Promise<AckResult<{ session: Session }>>((resolve) => handlers.get("identify")!(request, resolve));
  const rename = (name: unknown) => new Promise<AckResult<{ session: Session }>>((resolve) => handlers.get("rename")!(name, resolve));
  const check = (name: unknown) =>
    new Promise<AckResult<{ available: boolean; reason: string | null }>>((resolve) => handlers.get("name:check")!(name, resolve));
  return { socket, sent, identify, rename, check };
}

function server() {
  const registry = new PlayerRegistry();
  const bank = new HouseBank();
  const context = {
    registry,
    rooms: new RoomManager({ bank }),
    blackjack: new BlackjackRoomManager({ bank }),
    stats: new MemoryStatsStore(),
    publishLobby() {},
  };
  const connect = (token: unknown) => {
    const client = fakeSocket(token);
    registerConnection(client.socket, context);
    return client;
  };
  return { registry, connect };
}

const TOKEN = "0123456789abcdef0123456789abcdef";
const OTHER = "fedcba9876543210fedcba9876543210";

describe("identify (verified on every load)", () => {
  it("doesn't log a returning browser in until it identifies", async () => {
    const { registry, connect } = server();
    registry.identify(TOKEN, "Alice");
    const client = connect(TOKEN);
    expect(client.sent.some((m) => m.event === "session")).toBe(false);

    const result = await client.identify({ name: "Alice", careerPublic: true });
    expect(result).toMatchObject({ ok: true, session: { name: "Alice", careerPublic: true } });
  });

  it("asks only for the privacy choice when the name checks out", async () => {
    const { connect } = server();
    const result = await connect(TOKEN).identify({ name: "Alice", careerPublic: null });
    expect(result).toMatchObject({ ok: false, code: "careerPublic" });
  });

  it("rejects a name that belongs to another browser, even offline", async () => {
    const { registry, connect } = server();
    registry.identify(OTHER, "Alice"); // never connected
    const result = await connect(TOKEN).identify({ name: "alice", careerPublic: true });
    expect(result).toMatchObject({ ok: false, code: "name" });
    expect(registry.all()).toHaveLength(1); // nothing registered for the rejected browser
  });

  it("checks the name before the privacy choice", async () => {
    const { connect } = server();
    const client = connect(TOKEN);
    expect(await client.identify({ name: "", careerPublic: null })).toMatchObject({ ok: false, code: "name" });
    expect(await client.identify({ name: "bad<name>", careerPublic: true })).toMatchObject({ ok: false, code: "name" });
  });

  it("rejects a missing or malformed browser token", async () => {
    const { connect } = server();
    expect(await connect(undefined).identify({ name: "Alice", careerPublic: true })).toMatchObject({ ok: false, code: "token" });
    expect(await connect("bad token!").identify({ name: "Alice", careerPublic: true })).toMatchObject({ ok: false, code: "token" });
  });
});

describe("renaming", () => {
  it("checks names live: free, taken (even offline) or invalid; your own name counts as free", async () => {
    const { registry, connect } = server();
    registry.identify(OTHER, "Bob");
    const me = connect(TOKEN);
    await me.identify({ name: "Alice", careerPublic: true });
    expect(await me.check("Alicia")).toEqual({ ok: true, available: true, reason: null });
    expect(await me.check("alice")).toEqual({ ok: true, available: true, reason: null });
    expect(await me.check("BOB")).toMatchObject({ ok: true, available: false, reason: expect.stringMatching(/belongs to another player/) });
    expect(await me.check("")).toMatchObject({ ok: true, available: false });
  });

  it("renames away from tables and frees the old name", async () => {
    const { registry, connect } = server();
    const me = connect(TOKEN);
    await me.identify({ name: "Alice", careerPublic: true });
    expect(await me.rename("Alicia")).toMatchObject({ ok: true, session: { name: "Alicia" } });
    expect(registry.nameTaken(OTHER, "Alice")).toBe(false);
    expect(registry.nameTaken(OTHER, "Alicia")).toBe(true);
  });

  it("refuses while you're at a table, or if the name is taken", async () => {
    const { registry, connect } = server();
    registry.identify(OTHER, "Bob");
    const me = connect(TOKEN);
    await me.identify({ name: "Alice", careerPublic: true });
    expect(await me.rename("bob")).toMatchObject({ ok: false, code: "name" });
    registry.get(TOKEN)!.roomId = "some-table";
    expect(await me.rename("Alicia")).toMatchObject({ ok: false, code: "seated" });
    expect(registry.get(TOKEN)!.name).toBe("Alice");
  });
});
