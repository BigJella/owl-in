import { randomUUID } from "node:crypto";
import { HumanPlayer } from "./HumanPlayer";

/** Humans keyed by the session token their browser keeps in localStorage. */
export class PlayerRegistry {
  private byToken = new Map<string, HumanPlayer>();
  private byId = new Map<string, HumanPlayer>();

  get(token: string): HumanPlayer | undefined {
    return this.byToken.get(token);
  }

  /**
   * Is `name` (case-insensitive) held by a different browser? A name belongs to the first token that claims it for the
   * whole server run, online or not, so the leaderboard never shows two players with the same name.
   */
  nameTaken(token: string, name: string): boolean {
    const lower = name.toLowerCase();
    for (const player of this.byToken.values()) {
      if (player.token !== token && player.name.toLowerCase() === lower) return true;
    }
    return false;
  }

  /** Create or rename the player for this token. Renaming frees the old name. Fails if another browser has the name. */
  identify(token: string, name: string): HumanPlayer | { error: string } {
    if (this.nameTaken(token, name)) return { error: `"${name}" belongs to another player. Pick another name.` };
    let player = this.byToken.get(token);
    if (!player) {
      player = new HumanPlayer(randomUUID(), token, name);
      this.byToken.set(token, player);
      this.byId.set(player.id, player);
    }
    player.name = name;
    return player;
  }

  byPlayerId(playerId: string): HumanPlayer | undefined {
    return this.byId.get(playerId);
  }

  /** Everyone who has picked a name since the server started. */
  all(): HumanPlayer[] {
    return [...this.byToken.values()];
  }

  onlineCount(): number {
    let count = 0;
    for (const player of this.byToken.values()) if (player.connected) count += 1;
    return count;
  }
}
