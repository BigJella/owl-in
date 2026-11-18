import { randomUUID } from "node:crypto";
import { HumanPlayer } from "./HumanPlayer";

/** Humans keyed by the session token their browser keeps in localStorage. */
export class PlayerRegistry {
  private byToken = new Map<string, HumanPlayer>();

  get(token: string): HumanPlayer | undefined {
    return this.byToken.get(token);
  }

  /** Create or rename the player for this token. Fails if another online player has the name. */
  identify(token: string, name: string): HumanPlayer | { error: string } {
    const lower = name.toLowerCase();
    for (const player of this.byToken.values()) {
      if (player.token !== token && player.connected && player.name.toLowerCase() === lower) {
        return { error: `"${name}" is already playing. Pick another name.` };
      }
    }
    let player = this.byToken.get(token);
    if (!player) {
      player = new HumanPlayer(randomUUID(), token, name);
      this.byToken.set(token, player);
    }
    player.name = name;
    return player;
  }

  onlineCount(): number {
    let count = 0;
    for (const player of this.byToken.values()) if (player.connected) count += 1;
    return count;
  }
}
