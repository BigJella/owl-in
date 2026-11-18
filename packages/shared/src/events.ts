import type { PokerAction, PokerRoomSummary, PokerStateMessage } from "./poker";
import type { BlackjackAction, BlackjackRoomSummary, BlackjackStateMessage } from "./blackjack";
import type { Ack, LobbyState, Session } from "./types";

/**
 * Events the client sends. Used as Socket.IO generics on both ends.
 * The client also sends `{ token }` in the handshake `auth` so a refresh reclaims its seat.
 */
export interface ClientToServerEvents {
  identify: (name: string, ack: Ack<{ session: Session }>) => void;
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
  "blackjack:clear-bet": (spot: number) => void;
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
}
