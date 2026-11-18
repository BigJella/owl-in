import type { BlackjackStrategy } from "../ai/BlackjackStrategy";

/** A bot occupying one blackjack spot. Its chips come from (and go back to) the HouseBank. */
export class BlackjackBot {
  readonly kind = "bot" as const;
  readonly connected = true;

  constructor(
    readonly id: string,
    readonly name: string,
    readonly strategy: BlackjackStrategy,
  ) {}
}
