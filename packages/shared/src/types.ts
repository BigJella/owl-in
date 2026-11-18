export type GameType = "poker" | "blackjack";

export interface LobbyState {
  playersOnline: number;
  /** Humans seated or waiting at any poker table. */
  pokerPlayers: number;
}

export interface Session {
  name: string;
  bankroll: number;
  roomId: string | null;
}

export type AckResult<T = object> = ({ ok: true } & T) | { ok: false; error: string };
export type Ack<T = object> = (result: AckResult<T>) => void;
