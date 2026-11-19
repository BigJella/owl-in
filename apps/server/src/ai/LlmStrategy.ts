import type { HandActionEntry, PlayingCard, PokerAction, PokerTableView } from "@owl-in/shared";
import { legalize, potSize, type PokerStrategy } from "./PokerStrategy";

/** What a model call returns: its text, plus what it cost when the backend reports that. */
export interface Completion {
  text: string;
  costUsd: number | null;
}

/** Any text-in/text-out model call. Must reject once `signal` aborts. */
export type CompleteFn = (prompt: string, signal: AbortSignal) => Promise<Completion | string>;

/** One LLM decision, for the server log. `fallback` is set when the script decided instead. */
export interface LlmDecisionLog {
  at: number;
  table: string;
  bot: string;
  handId: number;
  action: PokerAction;
  ms: number;
  costUsd: number | null;
  fallback: string | null;
}

const cardText = (c: PlayingCard) => `${c.rank === "10" ? "T" : c.rank}${c.suit[0]!.toLowerCase()}`;
const cards = (list: PlayingCard[]) => list.map(cardText).join(" ");

/**
 * LLM-backed bot. Serializes the seat's view (nothing more) to a prompt, asks for
 * an action, and falls back to another strategy on any failure. The room aborts
 * `signal` when the turn ends.
 */
export class LlmStrategy implements PokerStrategy {
  readonly name = "llm";

  constructor(
    private readonly fallback: PokerStrategy,
    private readonly complete: CompleteFn | null,
    private readonly log?: (entry: LlmDecisionLog) => void,
  ) {}

  async decide(view: PokerTableView, signal: AbortSignal): Promise<PokerAction> {
    const started = Date.now();
    let action: PokerAction;
    let fallback: string | null = null;
    let costUsd: number | null = null;
    if (!this.complete) {
      fallback = "unavailable";
      action = await this.fallback.decide(view, signal);
    } else {
      try {
        const reply = await this.complete(buildPrompt(view), signal);
        const completion = typeof reply === "string" ? { text: reply, costUsd: null } : reply;
        costUsd = completion.costUsd;
        action = legalize(view, parseAction(completion.text));
      } catch (error) {
        if (signal.aborted) throw error; // the turn is over; nobody is waiting for an answer
        fallback = error instanceof Error ? error.message.slice(0, 80) : "error";
        action = await this.fallback.decide(view, signal);
      }
    }
    const me = view.mySeat === null ? null : view.seats[view.mySeat];
    this.log?.({ at: Date.now(), table: view.name, bot: me?.name ?? "?", handId: view.handId, action, ms: Date.now() - started, costUsd, fallback });
    return action;
  }
}

const ACTION_TEXT: Record<HandActionEntry["action"], string> = {
  sb: "posts SB",
  bb: "posts BB",
  fold: "folds",
  check: "checks",
  call: "calls",
  bet: "bets",
  raise: "raises to",
};

function describe(a: HandActionEntry): string {
  const verb = ACTION_TEXT[a.action];
  const amount = a.action === "fold" || a.action === "check" ? "" : ` ${a.action === "raise" || a.action === "bet" ? a.betTo : a.amount}`;
  return `${a.name} ${verb}${amount}${a.allIn ? " (all-in)" : ""}`;
}

/** Compact, deterministic description of the seat's view. Never includes other players' hidden cards. */
export function buildPrompt(view: PokerTableView): string {
  const legal = view.myLegalActions;
  const mySeat = view.mySeat;
  const lines: string[] = [];
  lines.push(`No-Limit Hold'em, blinds ${view.smallBlind}/${view.bigBlind}. Hand #${view.handId}. Street: ${view.phase}.`);
  lines.push(`Your cards: ${cards(view.myHoleCards)}`);
  lines.push(`Board: ${cards(view.community) || "(none)"}`);

  lines.push("", "Players (seat order):");
  for (const s of view.seats) {
    if (!s || s.status === "waiting") continue;
    const tags = [s.isButton ? "button" : null, s.blind].filter(Boolean).join(", ");
    const status = s.status === "allIn" ? "all-in" : s.status;
    lines.push(
      `- ${s.name}${s.seat === mySeat ? " (you)" : ""}${tags ? ` [${tags}]` : ""}: stack ${s.stack}, ` +
        `bet this street ${s.bet}, in pot this hand ${s.contributed}, ${status}`,
    );
  }

  lines.push("", "Action this hand:");
  let street: string | null = null;
  for (const a of view.handActions) {
    if (a.street !== street) {
      street = a.street;
      lines.push(`${street}:`);
    }
    lines.push(`  ${describe(a)}`);
  }

  lines.push("", `Pot: ${potSize(view)}. Current bet: ${view.currentBet}.`);
  if (legal) {
    lines.push(legal.canCheck ? "You may check." : `To call: ${legal.callAmount}.`);
    lines.push(
      legal.canRaise
        ? `You may raise: "to" is your total bet this street, ${legal.minRaiseTo} to ${legal.maxRaiseTo} (${legal.maxRaiseTo} = all-in).`
        : "You may not raise.",
    );
  }
  lines.push("", "Your action?");
  return lines.join("\n");
}

export function parseAction(reply: string): PokerAction {
  let json: { type?: unknown; to?: unknown };
  try {
    json = JSON.parse(reply.slice(reply.indexOf("{"), reply.lastIndexOf("}") + 1));
  } catch {
    throw new Error(`unrecognized action: ${reply.slice(0, 80)}`);
  }
  if (json.type === "raise" && typeof json.to === "number" && Number.isFinite(json.to)) return { type: "raise", to: json.to };
  if (json.type === "fold" || json.type === "check" || json.type === "call") return { type: json.type };
  throw new Error(`unrecognized action: ${reply.slice(0, 80)}`);
}
