import type { PlayingCard, PokerAction, PokerTableView } from "@owl-in/shared";
import { legalize, potSize, type PokerStrategy } from "./PokerStrategy";

/** Any text-in/text-out model call. Wire this to an LLM SDK later. */
export type CompleteFn = (prompt: string, signal: AbortSignal) => Promise<string>;

const cardText = (c: PlayingCard) => `${c.rank}${c.suit[0]}`;

/**
 * LLM-backed bot (not wired up yet). Serializes the seat's view to a prompt, asks for
 * a JSON action, and falls back to another strategy on any failure. The room's time
 * bank aborts `signal` if the model is too slow.
 */
export class LlmStrategy implements PokerStrategy {
  readonly name = "llm";

  constructor(
    private readonly fallback: PokerStrategy,
    private readonly complete?: CompleteFn,
  ) {}

  async decide(view: PokerTableView, signal: AbortSignal): Promise<PokerAction> {
    if (!this.complete) return this.fallback.decide(view, signal);
    try {
      const reply = await this.complete(buildPrompt(view), signal);
      return legalize(view, parseAction(reply));
    } catch {
      return this.fallback.decide(view, signal);
    }
  }
}

export function buildPrompt(view: PokerTableView): string {
  const legal = view.myLegalActions!;
  const others = view.seats
    .filter((s) => s && s.seat !== view.mySeat)
    .map((s) => `- ${s!.name}: stack ${s!.stack}, bet ${s!.bet}, ${s!.status}`)
    .join("\n");
  return [
    `You are playing No-Limit Texas Hold'em (blinds ${view.smallBlind}/${view.bigBlind}).`,
    `Street: ${view.phase}. Your cards: ${view.myHoleCards.map(cardText).join(" ")}.`,
    `Board: ${view.community.map(cardText).join(" ") || "(none)"}. Pot: ${potSize(view)}.`,
    `Opponents:\n${others}`,
    `To call: ${legal.callAmount}. ${legal.canCheck ? "You may check." : ""}`,
    legal.canRaise ? `You may raise to between ${legal.minRaiseTo} and ${legal.maxRaiseTo}.` : "You may not raise.",
    `Reply with JSON only: {"type":"fold"|"check"|"call"|"raise","to"?:number}`,
  ].join("\n");
}

export function parseAction(reply: string): PokerAction {
  const json = JSON.parse(reply.slice(reply.indexOf("{"), reply.lastIndexOf("}") + 1));
  if (json.type === "raise" && typeof json.to === "number") return { type: "raise", to: json.to };
  if (json.type === "fold" || json.type === "check" || json.type === "call") return { type: json.type };
  throw new Error(`Unrecognized action: ${reply}`);
}
