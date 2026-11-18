import type { PokerAction, PokerRoomSummary, PokerStateMessage } from "./poker";
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
}

/** Events the server sends. */
export interface ServerToClientEvents {
  "lobby-updated": (lobby: LobbyState) => void;
  session: (session: Session) => void;
  "poker:rooms": (rooms: PokerRoomSummary[]) => void;
  "poker:state": (message: PokerStateMessage) => void;
  "poker:left": () => void;
  "error-message": (message: string) => void;
}
