import { PokerTable, type PokerAction, type PokerEvent } from "@owl-in/game-engine";
import {
  describeAction,
  formatDD,
  BOT_BUY_IN_BB,
  BOT_FILL_TARGET,
  BOT_MAX_STACK_BB,
  HIGH_ROLLER_MIN_BIG_BLIND,
  MAX_BUY_IN_BB,
  MIN_BUY_IN_BB,
  POKER_MAX_SEATS,
  TIME_BANK_MAX_MS,
  TIME_BANK_REFILL_MS,
  type PokerRoomSummary,
  type SessionEndReason,
  type PokerSeatView,
  type PokerTableView,
  type TableStage,
} from "@owl-in/shared";
import { RuleBasedStrategy } from "../ai/RuleBasedStrategy";
import type { HouseBank } from "../economy/HouseBank";
import { BotPlayer, pickBotName } from "../players/BotPlayer";
import { HumanPlayer } from "../players/HumanPlayer";
import type { Player } from "../players/Player";
import { attributePokerHand } from "../stats/pokerAttribution";
import type { StatsStore } from "../stats/StatsStore";

export interface RoomTiming {
  /** Short pause before dealing once everyone is ready (also the minimum gap in bot-only rooms). */
  gapMs: number;
  /** After a hand, humans get this long to ready up before their clock starts draining. */
  readyGraceMs: number;
  /** Bot-only rooms start at most one hand per this interval. */
  botOnlyHandIntervalMs: number;
  /** Bot "thinking" time range when humans are watching. */
  botDelayMs: [number, number];
  /** Bot thinking time in bot-only rooms. */
  botOnlyDelayMs: number;
  /** Extra bot pause right after cards are dealt, so the deal animation finishes first. */
  streetPauseMs: number;
  /** Hard cap on a bot's (future LLM's) decision time. Not shown to players. */
  botSafetyMs: number;
  /** How quickly an away player is auto-checked/folded. */
  awayActionDelayMs: number;
  /** After cashing out or being kicked, how long before you may rejoin the same table. */
  rejoinPenaltyMs: number;
  /** A busted human gets this long (independent of their clock) to rebuy or leave. */
  rebuyDecisionMs: number;
}

export const DEFAULT_TIMING: RoomTiming = {
  gapMs: 1_000,
  readyGraceMs: 5_000,
  botOnlyHandIntervalMs: 60_000,
  botDelayMs: [1_500, 3_000],
  botOnlyDelayMs: 1_500,
  streetPauseMs: 1_500,
  botSafetyMs: 30_000,
  awayActionDelayMs: 500,
  rejoinPenaltyMs: 30 * 60_000,
  rebuyDecisionMs: 30_000,
};

/**
 * Rough length of the client's animation for a batch of events, so between-hand
 * timers start after players have actually seen the result.
 */
export function animationAllowanceMs(events: PokerEvent[]): number {
  let ms = 300;
  for (const e of events) {
    if (e.type === "communityDealt") ms += 500 * e.cards.length;
    else if (e.type === "showdown") ms += 1_500;
    else if (e.type === "potAwarded") ms += 600 * e.winners.length;
    else if (e.type === "betsCollected") ms += 500;
    else if (e.type === "uncalledReturned") ms += 300;
  }
  return ms;
}

export interface PokerRoomOptions {
  id: string;
  name: string;
  bigBlind: number;
  bank: HouseBank;
  timing?: Partial<RoomTiming>;
  /** Career stats: sessions and finished hands are reported here. */
  stats?: StatsStore;
  /** Summary-level change (seats, chips). */
  onChange?: (room: PokerRoom) => void;
  /** Asked when the room has no humans at a hand boundary. */
  canClose?: (room: PokerRoom) => boolean;
  onClose?: (room: PokerRoom) => void;
}

interface Occupant {
  player: Player;
  timeBankMs: number;
  /** Will be removed at the next gap; auto-folds until then. */
  leaving: boolean;
  /** When a human lost connection; their clock runs in real time from here. */
  disconnectedAt: number | null;
  dropTimer: ReturnType<typeof setTimeout> | null;
  /** Ready for the next hand (humans only; bots are always ready). */
  ready: boolean;
  /** While not ready after the grace period, the clock runs from this moment. */
  drainSince: number | null;
  /** Busted between hands: must rebuy or leave by this time (not tied to the clock). */
  rebuyDeadline: number | null;
  /** Asked to cash out mid-hand: plays it out, then is removed when the hand ends. Irreversible. */
  cashingOut: boolean;
}

interface Turn {
  id: number;
  seat: number;
  startedAt: number;
  budgetMs: number;
  abort: AbortController;
  timers: ReturnType<typeof setTimeout>[];
}

let botCounter = 0;

export class PokerRoom {
  readonly id: string;
  readonly name: string;
  readonly table: PokerTable;
  readonly timing: RoomTiming;
  closed = false;

  private readonly occupants: (Occupant | null)[] = Array.from({ length: POKER_MAX_SEATS }, () => null);
  private waiting: { player: HumanPlayer; buyIn: number }[] = [];
  private turn: Turn | null = null;
  private turnCounter = 0;
  private seq = 0;
  private lastActions: (string | null)[] = Array.from({ length: POKER_MAX_SEATS }, () => null);
  private gapTimer: ReturnType<typeof setTimeout> | null = null;
  private nextHandAt: number | null = null;
  private lastHandStartedAt = -Infinity;
  /** Set between hands at tables with humans: when un-ready players' clocks start running. */
  private readyGraceEndsAt: number | null = null;
  /** playerId -> time they may rejoin this table. */
  private readonly penalties = new Map<string, number>();
  private readonly bank: HouseBank;
  /** playerId -> open career session at this table. */
  private readonly sessionIds = new Map<string, string>();
  /** Every event of the hand in progress (for the career record when it ends). */
  private handLog: PokerEvent[] = [];

  constructor(private readonly options: PokerRoomOptions) {
    this.id = options.id;
    this.name = options.name;
    this.bank = options.bank;
    this.timing = { ...DEFAULT_TIMING, ...options.timing };
    this.table = new PokerTable({
      smallBlind: Math.floor(options.bigBlind / 2),
      bigBlind: options.bigBlind,
      maxSeats: POKER_MAX_SEATS,
    });
  }

  get bigBlind() {
    return this.table.bigBlind;
  }

  start() {
    this.maintainSeats();
    this.scheduleNextHand();
    this.changed();
  }

  // ---------- membership ----------

  /** Queue a human to be dealt in at the next hand. Returns an error message or null. */
  join(player: HumanPlayer, buyIn: number): string | null {
    if (this.closed) return "That table just closed.";
    const existing = this.seatOf(player);
    if (existing !== null) {
      if (this.occupants[existing]!.cashingOut) return "You're cashing out at the end of this hand.";
      // Kicked for being away but came back before the gap: keep the seat.
      this.occupants[existing]!.leaving = false;
      player.roomId = this.id;
      player.game = "poker";
      this.hurryNextHand();
      this.onReconnect(player);
      this.changed();
      return null;
    }
    if (this.waiting.some((w) => w.player === player)) return null;
    const blockedUntil = this.penalties.get(player.id) ?? 0;
    if (blockedUntil > Date.now()) {
      const minutes = Math.ceil((blockedUntil - Date.now()) / 60_000);
      return `You left this table recently. You can rejoin it in ${minutes} min.`;
    }
    const min = this.bigBlind * MIN_BUY_IN_BB;
    const max = this.bigBlind * MAX_BUY_IN_BB;
    if (!Number.isInteger(buyIn) || buyIn < min || buyIn > max) return `Buy-in must be between ${formatDD(min)} and ${formatDD(max)}.`;
    if (buyIn > player.bankroll) return "Not enough Dining Dollars for that buy-in.";
    // Seats of players cashing out after this hand count as free: they're guaranteed to open up.
    if (this.committedHumans() + this.waiting.length >= POKER_MAX_SEATS) return "Table is full.";

    player.bankroll -= buyIn;
    player.roomId = this.id;
    player.game = "poker";
    this.waiting.push({ player, buyIn });
    this.openSession(player, buyIn);

    this.hurryNextHand();
    this.broadcast([]);
    this.changed();
    return null;
  }

  /**
   * Cash out. Between hands (or if you weren't dealt in) you leave immediately; mid-hand the
   * cash-out is queued: you play the hand out and are removed when it ends. Irreversible either way.
   */
  leave(player: HumanPlayer): string | null {
    const seat = this.seatOf(player);
    if (seat !== null && !this.canLeave(seat)) {
      const occ = this.occupants[seat]!;
      occ.cashingOut = true;
      this.broadcast([]);
      this.changed();
      return null;
    }

    const queued = this.waiting.findIndex((w) => w.player === player);
    if (queued >= 0) {
      // Never sat down: just a refund, no penalty.
      player.bankroll += this.waiting[queued]!.buyIn;
      this.closeSession(player, this.waiting[queued]!.buyIn, "left");
      this.waiting.splice(queued, 1);
    }
    if (seat !== null) {
      this.removeOccupant(seat);
      this.penalize(player);
    }
    if (player.roomId === this.id) player.roomId = null;
    if (this.table.phase === "idle") this.scheduleNextHand();
    this.broadcast([]);
    this.changed();
    return null;
  }

  /** Ready up for the next hand. */
  setReady(player: HumanPlayer): string | null {
    const seat = this.seatOf(player);
    if (seat === null) return null; // waiting-list players are ready by joining
    if (this.readyGraceEndsAt === null || this.table.phase !== "idle") return null;
    const occ = this.occupants[seat]!;
    if (occ.ready) return null;
    if (this.table.seats[seat]!.stack === 0) return "Your meal plan is empty. Reload or cash out.";
    this.commitDrain(occ);
    occ.ready = true;
    occ.drainSince = null;
    this.checkReady();
    this.broadcast([]);
    return null;
  }

  /** Busted between hands: top back up (counts as readying). Returns an error or null. */
  rebuy(player: HumanPlayer, amount: number): string | null {
    const seat = this.seatOf(player);
    if (seat === null || this.table.phase !== "idle") return "You can only buy back in between hands.";
    const occ = this.occupants[seat]!;
    if (this.table.seats[seat]!.stack > 0 || occ.rebuyDeadline === null) return "You still have chips.";
    const { min, max } = this.buyInRange(player);
    if (max < min) return "Not enough Dining Dollars to reload here.";
    if (!Number.isInteger(amount) || amount < min || amount > max) return `Buy-in must be between ${formatDD(min)} and ${formatDD(max)}.`;
    player.bankroll -= amount;
    this.table.addChips(seat, amount);
    const sessionId = this.sessionIds.get(player.id);
    if (sessionId) this.options.stats?.addBuyIn(sessionId, amount);
    occ.rebuyDeadline = null;
    occ.ready = true;
    occ.drainSince = null;
    player.sendSession();
    this.checkReady();
    this.broadcast([]);
    this.changed();
    return null;
  }

  private buyInRange(player: HumanPlayer) {
    return { min: this.bigBlind * MIN_BUY_IN_BB, max: Math.min(this.bigBlind * MAX_BUY_IN_BB, player.bankroll) };
  }

  /** True if leaving right now would take effect immediately (vs. being queued until the hand ends). */
  canLeaveNow(player: HumanPlayer): boolean {
    const seat = this.seatOf(player);
    return seat === null || this.canLeave(seat);
  }

  private canLeave(seat: number): boolean {
    return this.table.phase === "idle" || !this.table.seats[seat]!.inHand;
  }

  private penalize(player: Player) {
    this.penalties.set(player.id, Date.now() + this.timing.rejoinPenaltyMs);
  }

  onDisconnect(player: HumanPlayer) {
    const seat = this.seatOf(player);
    if (seat === null) return;
    const occ = this.occupants[seat]!;
    this.commitDrain(occ);
    occ.drainSince = null;
    occ.disconnectedAt = Date.now();
    occ.dropTimer = setTimeout(() => {
      occ.leaving = true; // removed at the next gap unless they come back first
      this.broadcast([]);
    }, occ.timeBankMs);
    if (this.turn?.seat === seat) {
      const id = this.turn.id;
      this.turn.timers.push(setTimeout(() => this.finishTurn(id, this.table.defaultAction(seat), false), this.timing.awayActionDelayMs));
    }
    this.checkReady(); // an away player no longer holds up the next hand
    this.broadcast([]);
  }

  onReconnect(player: HumanPlayer) {
    const seat = this.seatOf(player);
    const occ = seat === null ? null : this.occupants[seat]!;
    if (occ && occ.disconnectedAt !== null) {
      occ.timeBankMs = this.liveBank(occ);
      occ.disconnectedAt = null;
      if (occ.dropTimer) clearTimeout(occ.dropTimer);
      occ.dropTimer = null;
      if (player.roomId === this.id) occ.leaving = false;
      if (this.readyGraceEndsAt !== null && !occ.ready) {
        occ.drainSince = Math.max(Date.now(), this.readyGraceEndsAt);
        this.checkReady();
      }
    }
    if (player.roomId === this.id) {
      player.notify({ view: this.viewFor(player.id), events: [], seq: this.seq });
    }
  }

  /** Validate a human's action and hand it to their pending turn. Returns an error or null. */
  submitAction(player: HumanPlayer, action: PokerAction): string | null {
    const seat = this.seatOf(player);
    if (seat === null || this.turn?.seat !== seat) return "It's not your turn.";
    const legal = this.table.legalActions(seat);
    const ok =
      action.type === "fold" ||
      action.type === "call" ||
      (action.type === "check" && legal.canCheck) ||
      (action.type === "raise" && legal.canRaise && action.to >= legal.minRaiseTo && action.to <= legal.maxRaiseTo);
    if (!ok) return "That action isn't allowed right now.";
    return player.submitAction(action) ? null : "It's not your turn.";
  }

  // ---------- hand loop ----------

  /** A human arriving at a slow bot-only table should not wait a minute. */
  private hurryNextHand() {
    if (this.table.phase === "idle") this.scheduleNextHand();
  }

  /**
   * Between hands. Bot-only rooms just wait out their 1-hand-per-minute interval.
   * Rooms with humans wait for every seated, connected human to ready up.
   */
  private scheduleNextHand(animationMs = 0) {
    if (this.closed) return;
    if (this.gapTimer) clearTimeout(this.gapTimer);
    const now = Date.now();
    if (this.hasHumans()) {
      if (this.readyGraceEndsAt === null) {
        // Clocks only start once the end-of-hand animation has played out.
        this.readyGraceEndsAt = now + animationMs + this.timing.readyGraceMs;
        this.occupants.forEach((occ, seat) => {
          if (!occ) return;
          occ.ready = occ.player.kind === "bot";
          const busted = !occ.ready && this.table.seats[seat]!.stack === 0;
          occ.drainSince = occ.ready || busted ? null : this.readyGraceEndsAt;
          occ.rebuyDeadline = busted ? now + animationMs + this.timing.rebuyDecisionMs : null;
        });
      }
      return this.checkReady();
    }
    this.readyGraceEndsAt = null;
    const delay = Math.max(this.timing.gapMs, this.lastHandStartedAt + this.timing.botOnlyHandIntervalMs - now);
    this.nextHandAt = now + delay;
    this.gapTimer = setTimeout(() => this.beginHand(), delay);
  }

  /** Humans who still need to ready up (away/leaving players don't hold the table). */
  private pendingReady(): Occupant[] {
    return this.occupants.filter(
      (o): o is Occupant => o !== null && o.player.kind === "human" && !o.ready && !o.leaving && o.disconnectedAt === null,
    );
  }

  /** Start the hand if everyone is ready, auto-ready anyone whose clock ran out, else wait for the next deadline. */
  private checkReady() {
    if (this.closed || this.table.phase !== "idle" || this.readyGraceEndsAt === null) return;
    if (this.gapTimer) clearTimeout(this.gapTimer);
    const now = Date.now();

    for (const occ of this.pendingReady()) {
      if (occ.rebuyDeadline === null && this.table.seats[this.occupants.indexOf(occ)]!.stack === 0) {
        occ.rebuyDeadline = now + this.timing.rebuyDecisionMs;
        occ.drainSince = null;
      }
      if (occ.rebuyDeadline !== null) {
        // Busted and didn't decide in time: removed at the gap (with the rejoin penalty).
        if (now >= occ.rebuyDeadline) occ.leaving = true;
      } else if (now >= this.readyGraceEndsAt && this.liveBank(occ) <= 0) {
        // Out of time (only once the grace period is over): ready them automatically.
        occ.timeBankMs = 0;
        occ.ready = true;
        occ.drainSince = null;
      }
    }
    const pending = this.pendingReady();
    if (pending.length === 0) {
      this.nextHandAt = now + this.timing.gapMs;
      this.gapTimer = setTimeout(() => this.beginHand(), this.timing.gapMs);
      return;
    }
    this.nextHandAt = null;
    const grace = this.readyGraceEndsAt;
    const soonest = Math.min(
      ...pending.map((o) => o.rebuyDeadline ?? Math.max(grace, now) + this.liveBank(o)),
    );
    this.gapTimer = setTimeout(() => {
      this.checkReady();
      this.broadcast([]);
    }, soonest - now + 1);
  }

  /** Fold any ready-phase drain so far into the stored clock. */
  private commitDrain(occ: Occupant) {
    if (occ.drainSince === null || occ.disconnectedAt !== null) return;
    occ.timeBankMs = this.liveBank(occ);
    occ.drainSince = Math.max(Date.now(), occ.drainSince);
  }

  private beginHand() {
    this.gapTimer = null;
    this.nextHandAt = null;
    this.readyGraceEndsAt = null;
    for (const occ of this.occupants) {
      if (!occ) continue;
      occ.drainSince = null;
      occ.rebuyDeadline = null;
    }
    this.maintainSeats();

    if (!this.hasHumans() && this.options.canClose?.(this)) return this.close();
    if (!this.table.canStartHand()) {
      this.scheduleNextHand();
      this.broadcast([]);
      return;
    }
    this.lastHandStartedAt = Date.now();
    this.afterEvents(this.table.startHand());
  }

  private afterEvents(events: PokerEvent[]) {
    this.trackActions(events);
    if (events.some((e) => e.type === "handStarted")) this.handLog = [];
    this.handLog.push(...events);
    if (events.some((e) => e.type === "handEnded")) this.recordHand(this.handLog);
    if (this.table.phase === "idle") {
      const animationMs = animationAllowanceMs(events);
      if (this.occupants.some((o) => o?.cashingOut)) {
        // Players cashing out still get this hand's result (showdown, payouts) before they're removed.
        this.broadcast(events);
        events = [];
        this.removeCashedOut();
      }
      this.scheduleNextHand(animationMs);
    } else this.startTurn(events);
    this.broadcast(events);
    this.changed();
  }

  private trackActions(events: PokerEvent[]) {
    const sticky = (label: string | null) => label === "Fold" || (label?.startsWith("All-in") ?? false);
    for (const e of events) {
      if (e.type === "handStarted") this.lastActions.fill(null);
      else if (e.type === "playerActed") this.lastActions[e.seat] = describeAction(e);
      else if (e.type === "communityDealt") this.lastActions = this.lastActions.map((a) => (sticky(a) ? a : null));
      else if (e.type === "potAwarded") {
        for (const { seat, amount } of e.winners) {
          const previous = Number(this.lastActions[seat]?.match(/^Wins \$([\d,]+)/)?.[1]?.replace(/,/g, "") ?? 0);
          this.lastActions[seat] = `Wins ${formatDD(previous + amount)}`;
        }
      }
    }
  }

  private startTurn(previous: PokerEvent[]) {
    const seat = this.table.toAct;
    if (seat === null) return;
    const occ = this.occupants[seat]!;
    const id = ++this.turnCounter;
    const away = occ.leaving || occ.disconnectedAt !== null;
    const bot = occ.player.kind === "bot";
    const thinkMs = bot ? this.botDelay(previous) : 0;

    if (!away && !bot) occ.timeBankMs = Math.min(TIME_BANK_MAX_MS, occ.timeBankMs + TIME_BANK_REFILL_MS);
    const turn: Turn = {
      id,
      seat,
      startedAt: Date.now(),
      budgetMs: away ? 0 : bot ? thinkMs + this.timing.botSafetyMs : occ.timeBankMs,
      abort: new AbortController(),
      timers: [],
    };
    this.turn = turn;

    if (away) {
      const action = occ.leaving ? { type: "fold" as const } : this.table.defaultAction(seat);
      turn.timers.push(setTimeout(() => this.finishTurn(id, action, false), this.timing.awayActionDelayMs));
      return;
    }

    turn.timers.push(setTimeout(() => this.finishTurn(id, this.table.defaultAction(seat), true), turn.budgetMs));

    const ask = () => {
      occ.player
        .requestAction(this.viewFor(occ.player.id), turn.abort.signal)
        .then((action) => this.finishTurn(id, action, false))
        .catch(() => {
          // Aborted (turn already over) or the strategy threw: fall back to check/fold.
          if (!turn.abort.signal.aborted) this.finishTurn(id, this.table.defaultAction(seat), false);
        });
    };
    if (bot) turn.timers.push(setTimeout(ask, thinkMs));
    else ask();
  }

  private finishTurn(id: number, action: PokerAction, timedOut: boolean) {
    const turn = this.turn;
    if (!turn || turn.id !== id || this.closed) return;
    this.turn = null;
    for (const timer of turn.timers) clearTimeout(timer);
    turn.abort.abort();

    const occ = this.occupants[turn.seat];
    if (occ && occ.player.kind === "human" && occ.disconnectedAt === null && !occ.leaving) {
      occ.timeBankMs = timedOut ? 0 : Math.max(0, occ.timeBankMs - (Date.now() - turn.startedAt));
    }

    let events: PokerEvent[];
    try {
      events = this.table.act(turn.seat, action);
    } catch {
      events = this.table.act(turn.seat, this.table.defaultAction(turn.seat));
    }
    this.afterEvents(events);
  }

  /** Fake thinking time, plus a pause after new cards so their animation finishes first. */
  private botDelay(previous: PokerEvent[]) {
    const dealt = previous.some((e) => e.type === "holeCardsDealt" || e.type === "communityDealt");
    const extra = dealt ? this.timing.streetPauseMs : 0;
    if (!this.hasHumans()) return this.timing.botOnlyDelayMs + extra;
    const [min, max] = this.timing.botDelayMs;
    return min + Math.random() * (max - min) + extra;
  }

  // ---------- seating (only between hands) ----------

  /** The hand just ended: everyone who queued a cash-out leaves now (with the rejoin penalty). */
  private removeCashedOut() {
    this.occupants.forEach((occ, seat) => {
      if (!occ?.cashingOut || !(occ.player instanceof HumanPlayer)) return;
      this.penalize(occ.player);
      this.removeOccupant(seat);
    });
  }

  /** Runs in the gap: drop leavers, rebuy bots, seat waiting humans by replacing bots, refill to 4. */
  private maintainSeats() {
    const botStack = this.bigBlind * BOT_BUY_IN_BB;

    this.occupants.forEach((occ, seat) => {
      if (!occ) return;
      const stack = this.table.seats[seat]!.stack;
      if (occ.player instanceof HumanPlayer && (occ.leaving || stack === 0)) {
        // Kicked (away too long / didn't rebuy in time) or busted: same rejoin penalty as cashing out,
        // so you can't bust or leave and immediately sit back down with a different stack.
        this.penalize(occ.player);
        this.removeOccupant(seat, stack === 0 ? "busted" : "removed");
      }
      else if (occ.player.kind === "bot" && stack < this.bigBlind) {
        this.table.addChips(seat, this.bank.withdraw(botStack - stack));
      } else if (occ.player.kind === "bot" && !this.hasHumans() && stack > this.bigBlind * BOT_MAX_STACK_BB) {
        // Bot-only table: return runaway winnings to the house so "on table" stays meaningful.
        // Never while a human is present, so nobody's game totals get changed under them.
        const excess = stack - this.bigBlind * BOT_MAX_STACK_BB;
        this.table.seats[seat]!.stack -= excess;
        this.bank.deposit(excess);
      }
    });

    while (this.waiting.length > 0) {
      const { player, buyIn } = this.waiting[0]!;
      const bots = this.botSeats();
      let seat: number | undefined;
      if (bots.length > 0) {
        seat = bots.reduce((best, s) =>
          Math.abs(this.table.seats[s]!.stack - buyIn) < Math.abs(this.table.seats[best]!.stack - buyIn) ? s : best,
        );
        this.removeOccupant(seat);
      } else {
        seat = this.table.emptySeats()[0];
      }
      if (seat === undefined) break; // table full of humans; keep waiting
      this.waiting.shift();
      this.table.seatPlayer(seat, player.id, buyIn);
      this.occupants[seat] = { player, timeBankMs: 0, leaving: false, disconnectedAt: null, dropTimer: null, ready: true, drainSince: null, rebuyDeadline: null, cashingOut: false };
      if (!player.connected) this.onDisconnect(player);
    }

    const target = Math.max(0, BOT_FILL_TARGET - this.humanCount());
    let bots = this.botSeats();
    while (bots.length > target) {
      this.removeOccupant(bots.pop()!);
    }
    while (bots.length < target && this.table.emptySeats().length > 0) {
      const seat = this.table.emptySeats()[0]!;
      const names = this.occupants.flatMap((o) => (o ? [o.player.name] : []));
      const bot = new BotPlayer(`bot-${++botCounter}`, pickBotName(names), new RuleBasedStrategy());
      this.table.seatPlayer(seat, bot.id, this.bank.withdraw(botStack));
      this.occupants[seat] = { player: bot, timeBankMs: 0, leaving: false, disconnectedAt: null, dropTimer: null, ready: true, drainSince: null, rebuyDeadline: null, cashingOut: false };
      bots = this.botSeats();
    }
  }

  private removeOccupant(seat: number, reason: SessionEndReason = "left") {
    const occ = this.occupants[seat];
    if (!occ) return;
    const stack = this.table.removePlayer(seat);
    this.occupants[seat] = null;
    if (occ.dropTimer) clearTimeout(occ.dropTimer);
    if (occ.player instanceof HumanPlayer) {
      this.closeSession(occ.player, stack, reason);
      occ.player.bankroll += stack;
      if (occ.player.roomId === this.id) {
        occ.player.roomId = null;
        occ.player.sendLeft();
      }
      occ.player.sendSession();
    } else {
      this.bank.deposit(stack);
    }
  }

  close() {
    if (this.closed) return;
    if (this.gapTimer) clearTimeout(this.gapTimer);
    if (this.turn) for (const timer of this.turn.timers) clearTimeout(timer);
    this.turn = null;
    this.closed = true;
    if (this.table.phase === "idle") this.occupants.forEach((_, seat) => this.removeOccupant(seat, "table closed"));
    for (const { player, buyIn } of this.waiting) {
      this.closeSession(player, buyIn, "table closed");
      player.bankroll += buyIn;
      player.roomId = null;
      player.sendSession();
    }
    this.waiting = [];
    this.options.onClose?.(this);
  }

  // ---------- career stats ----------

  private openSession(player: HumanPlayer, buyIn: number) {
    const stats = this.options.stats;
    if (!stats || this.sessionIds.has(player.id)) return;
    const stakes = `${formatDD(this.table.smallBlind)}/${formatDD(this.bigBlind)}`;
    this.sessionIds.set(player.id, stats.openSession(player.id, { game: "poker", roomId: this.id, roomName: this.name, stakes, buyIn }));
  }

  private closeSession(player: HumanPlayer, cashOut: number, reason: SessionEndReason) {
    const sessionId = this.sessionIds.get(player.id);
    if (!sessionId) return;
    this.sessionIds.delete(player.id);
    this.options.stats?.closeSession(sessionId, { cashOut, reason });
  }

  /** A hand just ended: record it for every human who was dealt in. */
  private recordHand(events: PokerEvent[]) {
    const stats = this.options.stats;
    const started = events.find((e) => e.type === "handStarted");
    const dealt = events.find((e) => e.type === "holeCardsDealt");
    if (!stats || !started || !dealt) return;
    const seats = dealt.seats.flatMap((seat) => {
      const occ = this.occupants[seat];
      const s = this.table.seats[seat];
      return occ && s ? [{ seat, kind: occ.player.kind, contributed: s.contributed, folded: s.folded }] : [];
    });
    const showdown = events.find((e) => e.type === "showdown");
    const pot = events.reduce((sum, e) => sum + (e.type === "potAwarded" ? e.amount : 0), 0);
    for (const outcome of attributePokerHand(seats, events)) {
      const occ = this.occupants[outcome.seat];
      if (!(occ?.player instanceof HumanPlayer)) continue;
      const sessionId = this.sessionIds.get(occ.player.id);
      if (!sessionId) continue;
      const s = this.table.seats[outcome.seat]!;
      const reveal = showdown?.reveals.find((r) => r.seat === outcome.seat);
      const acted = events.filter((e) => e.type === "playerActed" && e.seat === outcome.seat).at(-1);
      stats.recordPokerHand(
        occ.player.id,
        {
          game: "poker",
          sessionId,
          handId: started.handId,
          at: Date.now(),
          holeCards: [...s.holeCards],
          board: [...this.table.community],
          position:
            started.button === outcome.seat
              ? "D"
              : started.smallBlindSeat === outcome.seat
                ? "SB"
                : started.bigBlindSeat === outcome.seat
                  ? "BB"
                  : null,
          lastAction: acted?.type === "playerActed" ? describeAction(acted) : null,
          showdownHand: reveal?.handName ?? null,
          pot,
          wagered: s.contributed,
          returned: outcome.returned,
          net: outcome.net,
          result: outcome.result,
          vsPlayers: outcome.vsPlayers,
          vsBots: outcome.vsBots,
        },
        { reached: reveal !== undefined, won: reveal !== undefined && outcome.returned > 0 },
      );
    }
  }

  /** Dining Dollars this player has at this table (stack, or a queued buy-in). */
  chipsOf(player: HumanPlayer): number {
    const seat = this.seatOf(player);
    if (seat !== null) return this.table.seats[seat]!.stack + this.table.seats[seat]!.bet;
    return this.waiting.find((w) => w.player === player)?.buyIn ?? 0;
  }

  // ---------- views ----------

  summary(): PokerRoomSummary {
    return {
      id: this.id,
      name: this.name,
      smallBlind: this.table.smallBlind,
      bigBlind: this.bigBlind,
      maxSeats: POKER_MAX_SEATS,
      humans: this.humanCount(),
      bots: this.botSeats().length,
      waiting: this.waiting.length,
      cashingOut: this.occupants.filter((o) => o?.cashingOut).length,
      chipsOnTable: this.table.totalChips(),
      highRoller: this.bigBlind >= HIGH_ROLLER_MIN_BIG_BLIND,
      stage: this.stage(),
    };
  }

  stage(): TableStage {
    const t = this.table;
    if (t.phase !== "idle") return t.phase;
    if (t.handId === 0) return "waiting";
    return t.lastShowdown.length > 0 ? "showdown" : "hand-over";
  }

  /** What `playerId` is allowed to see. Pass null for a spectator. */
  viewFor(playerId: string | null): PokerTableView {
    const t = this.table;
    const now = Date.now();
    const mySeatIndex = this.occupants.findIndex((o) => o?.player.id === playerId);
    const mySeat = mySeatIndex >= 0 ? mySeatIndex : null;
    const handLive = t.phase !== "idle";

    const seats = this.occupants.map((occ, seat): PokerSeatView | null => {
      if (!occ) return null;
      const s = t.seats[seat]!;
      const reveal = !handLive ? t.lastShowdown.find((r) => r.seat === seat) : undefined;
      return {
        seat,
        playerId: occ.player.id,
        name: occ.player.name,
        kind: occ.player.kind,
        stack: s.stack,
        bet: s.bet,
        contributed: s.inHand ? s.contributed : 0,
        lastAction: s.inHand ? (this.lastActions[seat] ?? null) : null,
        isButton: t.handId > 0 && t.button === seat,
        blind: t.handId === 0 || !s.inHand ? null : t.smallBlindSeat === seat ? "SB" : t.bigBlindSeat === seat ? "BB" : null,
        status: !s.inHand ? "waiting" : s.folded ? "folded" : s.allIn ? "allIn" : "active",
        connected: occ.disconnectedAt === null,
        hasCards: handLive && s.inHand && !s.folded,
        revealedCards: reveal ? [...reveal.cards] : null,
        revealedHand: reveal?.handName ?? null,
        timeBankMs: occ.player.kind === "bot" ? 0 : this.turn?.seat === seat ? this.turnRemaining(now) : this.liveBank(occ),
        ready: occ.player.kind === "human" && this.readyGraceEndsAt !== null && !handLive ? occ.ready : null,
        rebuying: !handLive && occ.rebuyDeadline !== null,
        leaving: occ.leaving,
        cashingOut: occ.cashingOut,
      };
    });

    const me = mySeat === null ? null : t.seats[mySeat]!;
    return {
      roomId: this.id,
      name: this.name,
      smallBlind: t.smallBlind,
      bigBlind: t.bigBlind,
      handId: t.handId,
      phase: t.phase,
      stage: this.stage(),
      button: t.button,
      toAct: handLive ? t.toAct : null,
      turnRemainingMs: this.turn && this.occupants[this.turn.seat]?.player.kind === "human" ? this.turnRemaining(now) : null,
      readyGraceRemainingMs:
        this.readyGraceEndsAt !== null && !handLive ? Math.max(0, this.readyGraceEndsAt - now) : null,
      leaveMode:
        mySeat === null
          ? "now"
          : this.occupants[mySeat]!.cashingOut
            ? "queued"
            : this.canLeave(mySeat)
              ? "now"
              : "after-hand",
      rebuy: (() => {
        const occ = mySeat === null ? null : this.occupants[mySeat];
        if (!occ || handLive || occ.rebuyDeadline === null || !(occ.player instanceof HumanPlayer)) return null;
        return { remainingMs: Math.max(0, occ.rebuyDeadline - now), ...this.buyInRange(occ.player) };
      })(),
      nextHandInMs: this.nextHandAt === null ? null : Math.max(0, this.nextHandAt - now),
      community: [...t.community],
      pots: t.pots.map((p) => ({ amount: p.amount, eligibleSeats: [...p.eligibleSeats] })),
      currentBet: t.currentBet,
      seats,
      mySeat,
      myHoleCards: me?.inHand ? [...me.holeCards] : [],
      myLegalActions: mySeat !== null && this.turn?.seat === mySeat ? t.legalActions(mySeat) : null,
      waitingList: this.waiting.map((w) => w.player.name),
      amWaiting: this.waiting.some((w) => w.player.id === playerId),
    };
  }

  private broadcast(events: PokerEvent[]) {
    if (this.closed) return;
    this.seq += 1;
    for (const player of this.audience()) {
      player.notify({ view: this.viewFor(player.id), events, seq: this.seq });
    }
  }

  // ---------- helpers ----------

  humanCount(): number {
    return this.occupants.filter((o) => o?.player.kind === "human" && !o.leaving).length;
  }

  waitingCount(): number {
    return this.waiting.length;
  }

  /** Seated humans who'll still be here next hand. */
  private committedHumans(): number {
    return this.occupants.filter((o) => o?.player.kind === "human" && !o.leaving && !o.cashingOut).length;
  }

  hasHumans(): boolean {
    return this.humanCount() > 0 || this.waiting.length > 0;
  }

  private audience(): HumanPlayer[] {
    const seated = this.occupants.flatMap((o) =>
      o?.player instanceof HumanPlayer && o.player.roomId === this.id ? [o.player] : [],
    );
    return [...seated, ...this.waiting.map((w) => w.player)];
  }

  private botSeats(): number[] {
    return this.occupants.flatMap((o, seat) => (o?.player.kind === "bot" ? [seat] : []));
  }

  private seatOf(player: Player): number | null {
    const seat = this.occupants.findIndex((o) => o?.player === player);
    return seat >= 0 ? seat : null;
  }

  private liveBank(occ: Occupant): number {
    const now = Date.now();
    if (occ.disconnectedAt !== null) return Math.max(0, occ.timeBankMs - (now - occ.disconnectedAt));
    if (occ.drainSince !== null) return Math.max(0, occ.timeBankMs - Math.max(0, now - occ.drainSince));
    return occ.timeBankMs;
  }

  private turnRemaining(now: number): number {
    return this.turn ? Math.max(0, this.turn.budgetMs - (now - this.turn.startedAt)) : 0;
  }

  private changed() {
    this.options.onChange?.(this);
  }
}
