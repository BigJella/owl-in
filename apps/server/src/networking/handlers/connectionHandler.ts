import { z } from "zod";
import { ALLOWED_BIG_BLINDS, BJ_ALLOWED_MIN_BETS, type Ack, type AckResult } from "@owl-in/shared";
import { Moderation } from "../../admin/Moderation";
import type { HumanPlayer } from "../../players/HumanPlayer";
import { nameSchema } from "../../players/names";
import type { PlayerRegistry } from "../../players/PlayerRegistry";
import type { BlackjackRoomManager } from "../../rooms/BlackjackRoomManager";
import type { RoomManager } from "../../rooms/RoomManager";
import { canView, careerView, leaderboard, sessionHandsFor } from "../../stats/careerView";
import type { StatsStore } from "../../stats/StatsStore";
import type { GameSocket } from "../types";

export const LOBBY_CHANNEL = "poker:lobby";
export const BLACKJACK_LOBBY_CHANNEL = "blackjack:lobby";

const tokenSchema = z.string().regex(/^[\w-]{8,128}$/);
const createSchema = z.object({
  name: z.string().trim().min(1).max(24),
  bigBlind: z.number().refine((n) => (ALLOWED_BIG_BLINDS as readonly number[]).includes(n), "Unsupported blinds."),
  buyIn: z.number().int(),
});
const joinSchema = z.object({ roomId: z.string().min(1).max(64), buyIn: z.number().int() });
const bjCreateSchema = z.object({
  name: z.string().trim().min(1).max(24),
  minBet: z.number().refine((n) => (BJ_ALLOWED_MIN_BETS as readonly number[]).includes(n), "Unsupported limits."),
});
const bjJoinSchema = z.object({ roomId: z.string().min(1).max(64) });
const bjBetSchema = z.object({ spot: z.number().int().min(0).max(6), amount: z.number().int().positive() });
const bjActionSchema = z.enum(["hit", "stand", "double", "split", "surrender"]);
const actionSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("fold") }),
  z.object({ type: z.literal("check") }),
  z.object({ type: z.literal("call") }),
  z.object({ type: z.literal("raise"), to: z.number().int().positive() }),
]);

interface Context {
  registry: PlayerRegistry;
  rooms: RoomManager;
  blackjack: BlackjackRoomManager;
  stats: StatsStore;
  /** Bans: a banned browser is refused at connect and at identify. */
  moderation?: Moderation;
  publishLobby: () => void;
}

/** Clients can omit the ack callback; never crash on that. */
function reply<T>(ack: Ack<T> | undefined, result: AckResult<T>) {
  if (typeof ack === "function") ack(result);
}

export function registerConnection(socket: GameSocket, { registry, rooms, blackjack, stats, moderation = new Moderation(), publishLobby }: Context) {
  // Same token from the same browser = same player, so a refresh reclaims the seat.
  const parsedToken = tokenSchema.safeParse(socket.handshake.auth?.token);
  const token = parsedToken.success ? parsedToken.data : null;
  /** Set once this connection has passed `identify`; every other action needs it. */
  let player: HumanPlayer | null = null;
  /** The token's player, attached straight away so a refresh doesn't drop their seat, but not logged in yet. */
  const known = token ? (registry.get(token) ?? null) : null;
  const ban = known ? moderation.banOf(known.id) : null;
  if (ban) {
    socket.emit("banned", { reason: ban.reason });
    socket.disconnect(true);
    return;
  }
  const returning = known;

  if (returning) {
    returning.attach(socket);
    rooms.roomOf(returning)?.onReconnect(returning);
    blackjack.roomOf(returning)?.onReconnect(returning);
  }
  publishLobby();

  const requirePlayer = (ack?: Ack<never>) => {
    if (!player) reply(ack, { ok: false, error: "Pick a name first." });
    return player;
  };

  // Verified on every page load: token, then name, then privacy. Nothing changes unless all three pass.
  socket.on("identify", (request, ack) => {
    if (!token) return reply(ack, { ok: false, code: "token", error: "Your browser session is invalid. Starting a new one." });
    const existing = registry.get(token);
    if (existing && moderation.banOf(existing.id)) return reply(ack, { ok: false, code: "banned", error: "You've been banned." });
    const name = nameSchema.safeParse(request?.name);
    if (!name.success) return reply(ack, { ok: false, code: "name", error: name.error.issues[0]?.message ?? "Invalid name." });
    if (registry.nameTaken(token, name.data)) {
      return reply(ack, { ok: false, code: "name", error: `"${name.data}" belongs to another player. Pick another name.` });
    }
    const careerPublic = request?.careerPublic;
    if (typeof careerPublic !== "boolean") {
      return reply(ack, { ok: false, code: "careerPublic", error: "Choose whether your career is public or private." });
    }
    const result = registry.identify(token, name.data);
    if ("error" in result) return reply(ack, { ok: false, code: "name", error: result.error });
    player = result;
    player.careerPublic = careerPublic;
    player.attach(socket);
    reply(ack, { ok: true, session: player.session() });
    rooms.roomOf(player)?.onReconnect(player);
    blackjack.roomOf(player)?.onReconnect(player);
    publishLobby();
  });

  /** The cleaned-up name, or why this browser can't use it. */
  const nameProblem = (raw: unknown): { name: string } | { reason: string } => {
    const name = nameSchema.safeParse(raw);
    if (!name.success) return { reason: name.error.issues[0]?.message ?? "Invalid name." };
    if (token && registry.nameTaken(token, name.data)) return { reason: "That name belongs to another player." };
    return { name: name.data };
  };

  socket.on("name:check", (raw, ack) => {
    const me = requirePlayer(ack);
    if (!me) return;
    const result = nameProblem(raw);
    reply(ack, "reason" in result ? { ok: true, available: false, reason: result.reason } : { ok: true, available: true, reason: null });
  });

  socket.on("rename", (raw, ack) => {
    const me = requirePlayer(ack);
    if (!me || !token) return;
    // Names show on seats, waiting lists and table history: change them only away from tables.
    if (me.roomId) return reply(ack, { ok: false, code: "seated", error: "You must leave your current table first." });
    const result = nameProblem(raw);
    if ("reason" in result) return reply(ack, { ok: false, code: "name", error: result.reason });
    const renamed = registry.identify(token, result.name);
    if ("error" in renamed) return reply(ack, { ok: false, code: "name", error: renamed.error });
    reply(ack, { ok: true, session: renamed.session() });
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

  /** One table at a time across both games: leave the current one first (if you're free to). */
  const leaveOtherTable = (me: HumanPlayer, target: object): string | null => {
    const current = rooms.roomOf(me) ?? blackjack.roomOf(me);
    if (!current || current === target) return null;
    if (!current.canLeaveNow(me)) return `Finish your hand at ${current.name} first.`;
    current.leave(me);
    return null;
  };

  const joinRoom = (me: HumanPlayer, roomId: string, buyIn: number): AckResult<{ roomId: string }> => {
    const room = rooms.get(roomId);
    if (!room) return { ok: false, error: "That table no longer exists." };
    const busy = leaveOtherTable(me, room);
    if (busy) return { ok: false, error: busy };
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

  // ---------- career & leaderboard ----------

  const chipsOf = (p: HumanPlayer) => rooms.chipsOf(p);
  /** The player whose career is asked for (null = me), if the asker may see it. */
  const careerTarget = (me: HumanPlayer, playerId: unknown): HumanPlayer | string => {
    if (playerId === null || playerId === undefined) return me;
    const parsed = z.string().min(1).max(64).safeParse(playerId);
    const target = parsed.success ? registry.byPlayerId(parsed.data) : undefined;
    if (!target) return "No such player.";
    return canView(target, me) ? target : "This career is private.";
  };

  socket.on("career:get", (playerId, ack) => {
    const me = requirePlayer(ack);
    if (!me) return;
    const target = careerTarget(me, playerId);
    if (typeof target === "string") return reply(ack, { ok: false, error: target });
    reply(ack, { ok: true, career: careerView(stats, target, me, chipsOf(target)) });
  });

  socket.on("career:session", (request, ack) => {
    const me = requirePlayer(ack);
    if (!me) return;
    const target = careerTarget(me, request?.playerId ?? null);
    if (typeof target === "string") return reply(ack, { ok: false, error: target });
    const sessionId = z.string().min(1).max(64).safeParse(request?.sessionId);
    if (!sessionId.success) return reply(ack, { ok: false, error: "Invalid request." });
    reply(ack, { ok: true, hands: sessionHandsFor(stats, target, me, sessionId.data) });
  });

  socket.on("career:set-privacy", (careerPublic, ack) => {
    const me = requirePlayer(ack);
    if (!me) return;
    if (typeof careerPublic !== "boolean") return reply(ack, { ok: false, error: "Invalid request." });
    me.careerPublic = careerPublic;
    me.sendSession();
    reply(ack, { ok: true });
  });

  socket.on("leaderboard:get", (ack) => {
    reply(ack, { ok: true, rows: leaderboard(registry.all(), player, chipsOf) });
  });

  // ---------- blackjack ----------

  socket.on("blackjack:subscribe-rooms", () => {
    socket.join(BLACKJACK_LOBBY_CHANNEL);
    socket.emit("blackjack:rooms", blackjack.list());
  });

  socket.on("blackjack:unsubscribe-rooms", () => {
    socket.leave(BLACKJACK_LOBBY_CHANNEL);
  });

  const joinBlackjack = (me: HumanPlayer, roomId: string): AckResult<{ roomId: string }> => {
    const room = blackjack.get(roomId);
    if (!room) return { ok: false, error: "That table no longer exists." };
    const busy = leaveOtherTable(me, room);
    if (busy) return { ok: false, error: busy };
    const error = room.join(me);
    if (error) return { ok: false, error };
    me.sendSession();
    publishLobby();
    return { ok: true, roomId: room.id };
  };

  socket.on("blackjack:create", (request, ack) => {
    const me = requirePlayer(ack);
    if (!me) return;
    const parsed = bjCreateSchema.safeParse(request);
    if (!parsed.success) return reply(ack, { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid table." });
    const current = rooms.roomOf(me) ?? blackjack.roomOf(me);
    if (current && !current.canLeaveNow(me)) return reply(ack, { ok: false, error: `Finish your hand at ${current.name} first.` });
    const room = blackjack.create(parsed.data.name, parsed.data.minBet);
    reply(ack, joinBlackjack(me, room.id));
  });

  socket.on("blackjack:join", (request, ack) => {
    const me = requirePlayer(ack);
    if (!me) return;
    const parsed = bjJoinSchema.safeParse(request);
    if (!parsed.success) return reply(ack, { ok: false, error: "Invalid request." });
    reply(ack, joinBlackjack(me, parsed.data.roomId));
  });

  socket.on("blackjack:leave", () => {
    if (!player) return;
    const room = blackjack.roomOf(player);
    if (!room) return;
    const immediate = room.canLeaveNow(player);
    const error = room.leave(player);
    if (error) return player.sendError(error);
    player.sendSession();
    if (immediate) socket.emit("blackjack:left");
    publishLobby();
  });

  socket.on("blackjack:bet", (request, ack) => {
    if (!player) return reply(ack, { ok: false, error: "Pick a name first." });
    const room = blackjack.roomOf(player);
    const parsed = bjBetSchema.safeParse(request);
    if (!room || !parsed.success) return reply(ack, { ok: false, error: "Invalid bet." });
    const error = room.bet(player, parsed.data.spot, parsed.data.amount);
    reply(ack, error ? { ok: false, error } : { ok: true });
  });

  socket.on("blackjack:leave-spot", (spot) => {
    if (!player) return;
    const parsed = z.number().int().min(0).max(6).safeParse(spot);
    const room = blackjack.roomOf(player);
    if (!room || !parsed.success) return;
    const error = room.leaveSpot(player, parsed.data);
    if (error) player.sendError(error);
  });

  socket.on("blackjack:rebet", (ack) => {
    if (!player) return reply(ack, { ok: false, error: "Pick a name first." });
    const room = blackjack.roomOf(player);
    if (!room) return reply(ack, { ok: false, error: "You're not at a table." });
    const error = room.rebet(player);
    reply(ack, error ? { ok: false, error } : { ok: true });
  });

  socket.on("blackjack:ready", () => {
    if (!player) return;
    const error = blackjack.roomOf(player)?.setReady(player) ?? null;
    if (error) player.sendError(error);
  });

  socket.on("blackjack:insurance", (take) => {
    if (!player || typeof take !== "boolean") return;
    const error = blackjack.roomOf(player)?.insurance(player, take) ?? null;
    if (error) player.sendError(error);
  });

  socket.on("blackjack:act", (rawAction) => {
    if (!player) return;
    const parsed = bjActionSchema.safeParse(rawAction);
    const room = blackjack.roomOf(player);
    if (!parsed.success || !room) return player.sendError("Invalid action.");
    const error = room.submitAction(player, parsed.data);
    if (error) player.sendError(error);
  });

  socket.on("disconnect", () => {
    const attached = player ?? returning;
    if (attached) {
      attached.detach(socket);
      if (!attached.connected) {
        rooms.roomOf(attached)?.onDisconnect(attached);
        blackjack.roomOf(attached)?.onDisconnect(attached);
      }
    }
    publishLobby();
  });
}
