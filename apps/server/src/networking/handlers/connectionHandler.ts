import { z } from "zod";
import { ALLOWED_BIG_BLINDS, type Ack, type AckResult } from "@owl-in/shared";
import type { HumanPlayer } from "../../players/HumanPlayer";
import type { PlayerRegistry } from "../../players/PlayerRegistry";
import type { RoomManager } from "../../rooms/RoomManager";
import type { GameSocket } from "../types";

export const LOBBY_CHANNEL = "poker:lobby";

const tokenSchema = z.string().min(8).max(128);
const nameSchema = z
  .string()
  .trim()
  .min(1, "Enter a name.")
  .max(16, "Names are 16 characters max.")
  .regex(/^[\p{L}\p{N} _.'-]+$/u, "Letters, numbers, spaces and _ . ' - only.");
const createSchema = z.object({
  name: z.string().trim().min(1).max(24),
  bigBlind: z.number().refine((n) => (ALLOWED_BIG_BLINDS as readonly number[]).includes(n), "Unsupported blinds."),
  buyIn: z.number().int(),
});
const joinSchema = z.object({ roomId: z.string().min(1).max(64), buyIn: z.number().int() });
const actionSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("fold") }),
  z.object({ type: z.literal("check") }),
  z.object({ type: z.literal("call") }),
  z.object({ type: z.literal("raise"), to: z.number().int().positive() }),
]);

interface Context {
  registry: PlayerRegistry;
  rooms: RoomManager;
  publishLobby: () => void;
}

/** Clients can omit the ack callback; never crash on that. */
function reply<T>(ack: Ack<T> | undefined, result: AckResult<T>) {
  if (typeof ack === "function") ack(result);
}

export function registerConnection(socket: GameSocket, { registry, rooms, publishLobby }: Context) {
  // Same token from the same browser = same player, so a refresh reclaims the seat.
  const parsedToken = tokenSchema.safeParse(socket.handshake.auth?.token);
  const token = parsedToken.success ? parsedToken.data : `anon-${socket.id}`;
  let player: HumanPlayer | null = registry.get(token) ?? null;

  if (player) {
    player.attach(socket);
    socket.emit("session", player.session());
    rooms.roomOf(player)?.onReconnect(player);
  }
  publishLobby();

  const requirePlayer = (ack?: Ack<never>) => {
    if (!player) reply(ack, { ok: false, error: "Pick a name first." });
    return player;
  };

  socket.on("identify", (rawName, ack) => {
    const name = nameSchema.safeParse(rawName);
    if (!name.success) return reply(ack, { ok: false, error: name.error.issues[0]?.message ?? "Invalid name." });
    const result = registry.identify(token, name.data);
    if ("error" in result) return reply(ack, { ok: false, error: result.error });
    player = result;
    player.attach(socket);
    reply(ack, { ok: true, session: player.session() });
    rooms.roomOf(player)?.onReconnect(player);
    publishLobby();
  });

  socket.on("get-lobby", () => publishLobby());

  socket.on("poker:subscribe-rooms", () => {
    socket.join(LOBBY_CHANNEL);
    socket.emit("poker:rooms", rooms.list());
  });

  socket.on("poker:unsubscribe-rooms", () => {
    socket.leave(LOBBY_CHANNEL);
  });

  const joinRoom = (me: HumanPlayer, roomId: string, buyIn: number): AckResult<{ roomId: string }> => {
    const room = rooms.get(roomId);
    if (!room) return { ok: false, error: "That table no longer exists." };
    const current = rooms.roomOf(me);
    if (current && current !== room) {
      if (!current.canLeaveNow(me)) return { ok: false, error: `Finish your hand at ${current.name} first.` };
      current.leave(me);
    }
    const error = room.join(me, buyIn);
    if (error) return { ok: false, error };
    me.sendSession();
    publishLobby();
    return { ok: true, roomId: room.id };
  };

  socket.on("poker:create", (request, ack) => {
    const me = requirePlayer(ack);
    if (!me) return;
    const parsed = createSchema.safeParse(request);
    if (!parsed.success) return reply(ack, { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid table." });
    const room = rooms.create(parsed.data.name, parsed.data.bigBlind);
    reply(ack, joinRoom(me, room.id, parsed.data.buyIn));
  });

  socket.on("poker:join", (request, ack) => {
    const me = requirePlayer(ack);
    if (!me) return;
    const parsed = joinSchema.safeParse(request);
    if (!parsed.success) return reply(ack, { ok: false, error: "Invalid request." });
    reply(ack, joinRoom(me, parsed.data.roomId, parsed.data.buyIn));
  });

  socket.on("poker:leave", () => {
    if (!player) return;
    const room = rooms.roomOf(player);
    if (!room) return;
    const immediate = room.canLeaveNow(player);
    const error = room.leave(player);
    if (error) return player.sendError(error);
    player.sendSession();
    if (immediate) socket.emit("poker:left"); // queued cash-outs stay at the table until the hand ends
    publishLobby();
  });

  socket.on("poker:rebuy", (amount, ack) => {
    if (!player) return reply(ack, { ok: false, error: "Pick a name first." });
    const room = rooms.roomOf(player);
    const parsed = z.number().int().safeParse(amount);
    if (!room || !parsed.success) return reply(ack, { ok: false, error: "Invalid buy-in." });
    const error = room.rebuy(player, parsed.data);
    reply(ack, error ? { ok: false, error } : { ok: true });
    publishLobby();
  });

  socket.on("poker:ready", () => {
    if (!player) return;
    const error = rooms.roomOf(player)?.setReady(player) ?? null;
    if (error) player.sendError(error);
  });

  socket.on("poker:act", (rawAction) => {
    if (!player) return;
    const parsed = actionSchema.safeParse(rawAction);
    const room = rooms.roomOf(player);
    if (!parsed.success || !room) return player.sendError("Invalid action.");
    const error = room.submitAction(player, parsed.data);
    if (error) player.sendError(error);
  });

  socket.on("disconnect", () => {
    if (player) {
      player.detach(socket);
      if (!player.connected) rooms.roomOf(player)?.onDisconnect(player);
    }
    publishLobby();
  });
}
