import type { PokerAction, PokerRoomSummary, PokerStateMessage } from "./poker";
import type { BlackjackAction, BlackjackRoomSummary, BlackjackStateMessage } from "./blackjack";
import type { CareerView, HandRecord, LeaderboardRow } from "./career";
import type { Ack, LobbyState, Session } from "./types";

/**
 * Events the client sends. Used as Socket.IO generics on both ends.
 * The client also sends `{ token }` in the handshake `auth` so a refresh reclaims its seat.
 */
export interface ClientToServerEvents {
  /**
   * Log in (on every page load / reconnect) or pick a new name. The server checks the browser token, the name (valid and not
   * another browser's) and the privacy choice; failures carry `code` "token" | "name" | "careerPublic" | "banned". `careerPublic: null`
   * means the browser has no saved choice yet.
   */
  identify: (request: { name: string; careerPublic: boolean | null }, ack: Ack<{ session: Session }>) => void;
  /** Live check while typing a new name: is it valid and free (your own current name counts as free)? */
  "name:check": (name: string, ack: Ack<{ available: boolean; reason: string | null }>) => void;
  /** Change your name. Only away from tables (`code: "seated"`); `code: "name"` if invalid or taken. */
  rename: (name: string, ack: Ack<{ session: Session }>) => void;
  /** null = your own career. */
  "career:get": (playerId: string | null, ack: Ack<{ career: CareerView }>) => void;
  /** Every hand / round of one table session. */
  "career:session": (request: { playerId: string | null; sessionId: string }, ack: Ack<{ hands: HandRecord[] }>) => void;
  "career:set-privacy": (careerPublic: boolean, ack: Ack) => void;
  "leaderboard:get": (ack: Ack<{ rows: LeaderboardRow[] }>) => void;
  "get-lobby": () => void;
  "poker:subscribe-rooms": () => void;
  "poker:unsubscribe-rooms": () => void;
  "poker:create": (request: { name: string; bigBlind: number; buyIn: number }, ack: Ack<{ roomId: string }>) => void;
  "poker:join": (request: { roomId: string; buyIn: number }, ack: Ack<{ roomId: string }>) => void;
  "poker:leave": () => void;
  "poker:ready": () => void;
  "poker:rebuy": (amount: number, ack: Ack) => void;
  "poker:act": (action: PokerAction) => void;
  "blackjack:subscribe-rooms": () => void;
  "blackjack:unsubscribe-rooms": () => void;
  "blackjack:create": (request: { name: string; minBet: number }, ack: Ack<{ roomId: string }>) => void;
  "blackjack:join": (request: { roomId: string }, ack: Ack<{ roomId: string }>) => void;
  "blackjack:leave": () => void;
  "blackjack:bet": (request: { spot: number; amount: number }, ack: Ack) => void;
  /** Give up a spot: now during betting (bet refunded), else once the round ends. */
  "blackjack:leave-spot": (spot: number) => void;
  "blackjack:rebet": (ack: Ack) => void;
  "blackjack:ready": () => void;
  "blackjack:insurance": (take: boolean) => void;
  "blackjack:act": (action: BlackjackAction) => void;
}

/** Events the server sends. */
export interface ServerToClientEvents {
  "lobby-updated": (lobby: LobbyState) => void;
  session: (session: Session) => void;
  "poker:rooms": (rooms: PokerRoomSummary[]) => void;
  "poker:state": (message: PokerStateMessage) => void;
  "poker:left": () => void;
  "blackjack:rooms": (rooms: BlackjackRoomSummary[]) => void;
  "blackjack:state": (message: BlackjackStateMessage) => void;
  "blackjack:left": () => void;
  "error-message": (message: string) => void;
  /** An admin banned this browser's identity: the connection is closed right after. */
  banned: (info: { reason: string | null }) => void;
}
