import type { BotMode, PokerAction, PokerTableView } from "@owl-in/shared";
import type { PokerStrategy } from "../ai/PokerStrategy";
import { Player } from "./Player";

/**
 * A bot seat. One class for both kinds of bot: `mode` picks the brain for each decision,
 * so a bot can be switched between script and LLM without losing its seat, stack or name.
 */
export class BotPlayer extends Player {
  readonly kind = "bot" as const;
  /** Set by the room before each turn: false at tables with no humans (LLM bots play by script there). */
  llmAllowed = true;
  /** An admin pinned this bot's mode; null = the room balances it against the table's AI count. */
  override: BotMode | null = null;

  constructor(
    id: string,
    name: string,
    readonly script: PokerStrategy,
    readonly llm: PokerStrategy,
    public mode: BotMode = "script",
  ) {
    super(id, name);
  }

  get connected() {
    return true;
  }

  /** The strategy the next decision will use. */
  get strategy(): PokerStrategy {
    return this.mode === "llm" && this.llmAllowed ? this.llm : this.script;
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
