import type { PokerAction, PokerTableView } from "@owl-in/shared";
import type { PokerStrategy } from "../ai/PokerStrategy";
import { Player } from "./Player";

export class BotPlayer extends Player {
  readonly kind = "bot" as const;

  constructor(
    id: string,
    name: string,
    readonly strategy: PokerStrategy,
  ) {
    super(id, name);
  }

  get connected() {
    return true;
  }

  requestAction(view: PokerTableView, signal: AbortSignal): Promise<PokerAction> {
    return this.strategy.decide(view, signal);
  }
}

const BOT_NAMES = [
  "Hootbot", "Owlgorithm", "Turing", "Ada", "Deep Bluff", "Neural Ned",
  "GPTina", "Byte Me", "Clippy", "HAL 9001", "Botzilla", "Overfit Olly",
];

/** First bot name not already used at the table. */
export function pickBotName(taken: Iterable<string>): string {
  const used = new Set(taken);
  return BOT_NAMES.find((name) => !used.has(name)) ?? `Bot ${used.size + 1}`;
}
