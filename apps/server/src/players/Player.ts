import type { PlayerKind, PokerAction, PokerStateMessage, PokerTableView } from "@owl-in/shared";

/**
 * Anything that can sit at a table. Rooms treat every seat the same way:
 * when it's your turn they call `requestAction` and race it against your clock.
 */
export abstract class Player {
  abstract readonly kind: PlayerKind;

  constructor(
    readonly id: string,
    public name: string,
  ) {}

  abstract get connected(): boolean;

  /**
   * Decide what to do. `view` is exactly what a human in this seat would see.
   * Must settle (or be safely ignorable) once `signal` aborts.
   */
  abstract requestAction(view: PokerTableView, signal: AbortSignal): Promise<PokerAction>;

  /** Push a state update to the player (no-op for bots). */
  notify(_message: PokerStateMessage): void {}
}
