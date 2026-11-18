export type GameType = "poker" | "blackjack";

export interface LobbyState {
  playersOnline: number;
  /** Humans seated or waiting at any poker table. */
  pokerPlayers: number;
  /** Humans at any blackjack table. */
  blackjackPlayers: number;
}

export interface Session {
  playerId: string;
  name: string;
  /** Others can open your career page from the leaderboard. */
  careerPublic: boolean;
  bankroll: number;
  roomId: string | null;
  /** Which game `roomId` belongs to. */
  game: GameType | null;
}

/** `code` says which input was wrong when the client needs to react differently (e.g. identify: "token" | "name" | "careerPublic"). */
export type AckResult<T = object> = ({ ok: true } & T) | { ok: false; error: string; code?: string };
export type Ack<T = object> = (result: AckResult<T>) => void;
