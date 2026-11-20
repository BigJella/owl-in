import { BlackjackTable, handTotal, isNatural, type BlackjackAction, type BlackjackEvent, type HandRef } from "@owl-in/game-engine";
import {
  BJ_BOT_SPOTS,
  BJ_DECKS,
  BJ_HIGH_ROLLER_MIN_BET,
  BJ_MAX_BET_MULT,
  BJ_MAX_SPOTS_PER_PLAYER,
  BJ_PENETRATION,
  BJ_SPOTS,
  BJ_DECISION_REFILL_MS,
  BJ_TIME_BANK_MAX_MS,
  BJ_TURN_REFILL_MS,
  BJ_STAGE_LABEL,
  formatDD,
  type AdminSeat,
  type AdminTable,
  type BlackjackRoomSummary,
  type BlackjackRoundRecord,
  type SessionEndReason,
  type BlackjackSpotView,
  type BlackjackStage,
  type BlackjackTableView,
  type BlackjackRoundLog,
} from "@owl-in/shared";
import { logPlayer, type EventLog } from "../admin/EventLog";
import { Moderation, joinBlockMessage } from "../admin/Moderation";
import { BasicStrategy } from "../ai/BasicStrategy";
import type { HouseBank } from "../economy/HouseBank";
import { BlackjackBot } from "../players/BlackjackBot";
import { pickBotName } from "../players/BotPlayer";
import { HumanPlayer } from "../players/HumanPlayer";
import type { StatsStore } from "../stats/StatsStore";

export interface BlackjackTiming {
  /** How long bets stay open (closes early once everyone holding a spot has pressed Deal). */
  bettingMs: number;
  /** How long players get to decide on insurance. */
  insuranceMs: number;
  /** Results stay on the felt this long (after their animation) before the cards are cleared. */
  resultMs: number;
  /** Pause between "no more bets" and the deal. */
  gapMs: number;
  /** Bot-only tables start at most one round per this interval. */
  botOnlyRoundIntervalMs: number;
  botDelayMs: [number, number];
  /** Hidden cap on a bot's (future LLM's) decision time. */
  botSafetyMs: number;
  /** How quickly a disconnected player's hand is stood. */
  awayActionDelayMs: number;
  /** Disconnected this long: removed from the table at the next betting round. */
  awayKickMs: number;
}

export const DEFAULT_BJ_TIMING: BlackjackTiming = {
  bettingMs: 15_000,
  insuranceMs: 8_000,
  resultMs: 3_000,
  gapMs: 600,
  botOnlyRoundIntervalMs: 20_000,
  botDelayMs: [800, 1_600],
  botSafetyMs: 30_000,
  awayActionDelayMs: 500,
  awayKickMs: 60_000,
};

/** Rough length of the client's animation for a batch of events. */
export function blackjackAnimationMs(events: BlackjackEvent[]): number {
  let ms = 0;
  for (const e of events) {
    if (e.type === "cardDealt") ms += 320;
    else if (e.type === "holeRevealed") ms += 450;
    else if (e.type === "handSplit") ms += 350;
    else if (e.type === "handSettled") ms += 220;
    else if (e.type === "insuranceSettled") ms += 400;
    else if (e.type === "tableCleared") ms += 500;
    else if (e.type === "shuffled") ms += 1_200;
  }
  return ms;
}

export interface BlackjackRoomOptions {
  id: string;
  name: string;
  minBet: number;
  bank: HouseBank;
  timing?: Partial<BlackjackTiming>;
  /** Rig the engine in tests. */
  table?: BlackjackTable;
  /** Career stats: sessions and settled rounds are reported here. */
  stats?: StatsStore;
  onChange?: (room: BlackjackRoom) => void;
  canClose?: (room: BlackjackRoom) => boolean;
  onClose?: (room: BlackjackRoom) => void;
  /** Bot spots to fill (0–3, default 3; bots only ever sit in spots 1–3). */
  maxBots?: number;
  /** Bans and timeouts, shared by every table (a private one if omitted, e.g. in tests). */
  moderation?: Moderation;
  /** The admin panel's event log: every settled round is added here. */
  eventLog?: EventLog;
}

interface Member {
  player: HumanPlayer;
  timeBankMs: number;
  /** Pressed Deal during this betting round. */
  ready: boolean;
  /** Had a bet in the last round: may run past the betting window on their clock. */
  playedLastRound: boolean;
  /** Betting window over and still not ready: the clock runs from here. */
  drainSince: number | null;
  /** Asked to leave mid-round: removed once the round ends. */
  leaving: boolean;
  disconnectedAt: number | null;
  lastBets: { spot: number; amount: number }[];
  /** Spots this player gives up when the current round ends. */
  releasing: Set<number>;
  /** Spots given up mid-round: this player can't bet on them in the following betting round. */
  blocked: Set<number>;
}

type Owner = HumanPlayer | BlackjackBot;

interface Turn {
  id: number;
  ref: HandRef;
  startedAt: number;
  budgetMs: number;
  /** Bots and away players have no visible clock. */
  human: boolean;
  abort: AbortController;
  timers: ReturnType<typeof setTimeout>[];
}

let botCounter = 0;

/** A fraction of the shoe, rounded to the nearest quarter deck. */
function quarterDecks(cards: number, size: number): number {
  return size > 0 ? Math.round(cards / 13) / (size / 13) : 0;
}

/**
 * One blackjack table: 7 spots, a persistent 6-deck shoe, the house as the dealer.
 * Humans bet straight from their bankroll on up to 3 spots; bots fill free spots among the first 3.
 * Money is conserved: bankrolls + house bank + `moneyOnTable` never change in total.
 */
export class BlackjackRoom {
  readonly id: string;
  readonly name: string;
  readonly minBet: number;
  readonly maxBet: number;
  readonly table: BlackjackTable;
  readonly timing: BlackjackTiming;
  closed = false;

  private readonly owners: (Owner | null)[] = Array.from({ length: BJ_SPOTS }, () => null);
  private readonly members = new Map<string, Member>();
  /** Stakes currently on the felt (bets, doubles, splits, insurance) not yet settled. */
  private moneyOnTable = 0;
  /** Bets are being taken. */
  private bettingOpen = false;
  /** End of the betting window (after which last round's players spend their clock). */
  private bettingEndsAt: number | null = null;
  /** Everyone's in: bets close at this time. */
  private closingAt: number | null = null;
  private insuranceEndsAt: number | null = null;
  private nextRoundAt: number | null = null;
  private lastRoundStartedAt = -Infinity;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private turn: Turn | null = null;
  private turnCounter = 0;
  /** Who made the previous decision this round: same player again only earns the small refill. */
  private lastActor: string | null = null;
  private seq = 0;
  private readonly bank: HouseBank;
  /** playerId -> open career session at this table. */
  private readonly sessionIds = new Map<string, string>();
  private readonly moderation: Moderation;
  /** How many of spots 1–3 bots fill (admin setting). */
  maxBots: number;
  /** An admin closed the table: it closes when the current round ends. */
  closing = false;

  constructor(private readonly options: BlackjackRoomOptions) {
    this.id = options.id;
    this.name = options.name;
    this.minBet = options.minBet;
    this.maxBet = options.minBet * BJ_MAX_BET_MULT;
    this.bank = options.bank;
    this.timing = { ...DEFAULT_BJ_TIMING, ...options.timing };
    this.table = options.table ?? new BlackjackTable({ decks: BJ_DECKS, penetration: BJ_PENETRATION });
    this.moderation = options.moderation ?? new Moderation();
    this.maxBots = Math.max(0, Math.min(BJ_BOT_SPOTS, options.maxBots ?? BJ_BOT_SPOTS));
  }

  start() {
    this.scheduleRound([]);
    this.changed();
  }

  // ---------- membership ----------

  join(player: HumanPlayer): string | null {
    if (this.closed || this.closing) return "That table is closing.";
    const existing = this.members.get(player.id);
    if (!existing) {
      const block = this.moderation.joinBlock(this.id, player.id);
      if (block) return joinBlockMessage(block);
    }
    player.roomId = this.id;
    player.game = "blackjack";
    if (existing) {
      this.onReconnect(player);
      return null;
    }
    if (this.options.stats) {
      const stakes = `${formatDD(this.minBet)}–${formatDD(this.maxBet)}`;
      this.sessionIds.set(
        player.id,
        this.options.stats.openSession(player.id, { game: "blackjack", roomId: this.id, roomName: this.name, stakes, buyIn: null }),
      );
    }
    this.members.set(player.id, {
      player,
      timeBankMs: 0,
      ready: false,
      playedLastRound: false,
      drainSince: null,
      leaving: false,
      disconnectedAt: null,
      lastBets: [],
      releasing: new Set(),
      blocked: new Set(),
    });
    // A bot-only table waiting out its interval opens bets right away for the newcomer.
    if (!this.bettingOpen && this.table.canBet && this.turn === null) this.scheduleRound([]);
    this.broadcast([]);
    this.changed();
    return null;
  }

  /** Between rounds you leave at once (bets refunded); mid-round you finish the round first. */
  leave(player: HumanPlayer): string | null {
    const member = this.members.get(player.id);
    if (!member) {
      if (player.roomId === this.id) player.roomId = null;
      return null;
    }
    if (!this.canLeaveNow(player)) {
      member.leaving = true;
      this.broadcast([]);
      this.changed();
      return null;
    }
    this.removeMember(member, false);
    if (this.bettingOpen) this.checkBettingDone();
    this.broadcast([]);
    this.changed();
    return null;
  }

  canLeaveNow(player: HumanPlayer): boolean {
    const inRound = this.table.phase === "insurance" || this.table.phase === "playing";
    return !inRound || !this.ownedSpots(player).some((spot) => this.table.spots[spot]!.hands.length > 0);
  }

  onDisconnect(player: HumanPlayer) {
    const member = this.members.get(player.id);
    if (!member) return;
    this.commitDrain(member);
    member.disconnectedAt = Date.now();
    const turn = this.turn;
    if (turn && this.owners[turn.ref.spot] === player) {
      turn.timers.push(setTimeout(() => this.finishTurn(turn.id, "stand"), this.timing.awayActionDelayMs));
    }
    if (this.bettingOpen) this.checkBettingDone();
    this.broadcast([]);
  }

  onReconnect(player: HumanPlayer) {
    const member = this.members.get(player.id);
    if (!member) return;
    member.disconnectedAt = null;
    if (this.bettingOpen) this.checkBettingDone();
    if (player.roomId === this.id) player.notifyBlackjack({ view: this.viewFor(player.id), events: [], seq: this.seq });
  }

  // ---------- betting ----------

  /** Bet on a spot: claims it if it's free or a bot's (the bot leaves). Replaces your existing bet there. */
  bet(player: HumanPlayer, spot: number, amount: number): string | null {
    const member = this.members.get(player.id);
    if (!member) return "You're not at this table.";
    if (!this.bettingOpen || !this.table.canBet) return "Bets are closed.";
    if (!Number.isInteger(spot) || spot < 0 || spot >= BJ_SPOTS) return "No such spot.";
    if (member.blocked.has(spot)) return `You gave up spot ${spot + 1}. You can bet on it again next round.`;
    if (!Number.isInteger(amount) || amount < this.minBet || amount > this.maxBet) {
      return `Bets are ${formatDD(this.minBet)} to ${formatDD(this.maxBet)}.`;
    }
    const owner = this.owners[spot];
    if (owner instanceof HumanPlayer && owner !== player) return "Someone else is playing that spot.";
    if (owner !== player && this.ownedSpots(player).length >= BJ_MAX_SPOTS_PER_PLAYER) {
      return `You can play at most ${BJ_MAX_SPOTS_PER_PLAYER} spots.`;
    }
    const current = owner === player ? this.table.spots[spot]!.bet : 0;
    if (amount - current > player.bankroll) return "Not enough Dining Dollars for that bet.";

    if (owner instanceof BlackjackBot) this.removeBot(spot);
    if (current > 0) this.refund(spot);
    player.bankroll -= amount;
    this.moneyOnTable += amount;
    this.table.placeBet(spot, amount);
    this.owners[spot] = player;
    member.ready = false;
    player.sendSession();
    this.checkBettingDone();
    this.broadcast([]);
    this.changed();
    return null;
  }

  /**
   * Give up one of your spots (e.g. to make room for someone). While bets are open it's immediate and the bet is
   * refunded; otherwise the spot plays out this round and is freed when the round ends.
   */
  leaveSpot(player: HumanPlayer, spot: number): string | null {
    const member = this.members.get(player.id);
    if (!member || this.owners[spot] !== player) return "That's not your spot.";
    if (this.bettingOpen && this.table.canBet) {
      this.refund(spot);
      this.owners[spot] = null;
      member.releasing.delete(spot);
      if (this.ownedSpots(player).length === 0) member.ready = false;
      player.sendSession();
      this.checkBettingDone();
    } else {
      member.releasing.add(spot);
    }
    this.broadcast([]);
    this.changed();
    return null;
  }

  /** Repeat last round's bets (on the same spots, where they're still yours to take). */
  rebet(player: HumanPlayer): string | null {
    const member = this.members.get(player.id);
    if (!member) return "You're not at this table.";
    if (member.lastBets.length === 0) return "No previous bets to repeat.";
    let error: string | null = null;
    for (const { spot, amount } of member.lastBets) {
      if (member.blocked.has(spot)) continue; // given up: not repeated this round
      if (this.owners[spot] === player && this.table.spots[spot]!.bet === amount) continue;
      error = this.bet(player, spot, amount) ?? error;
    }
    return error;
  }

  /** "Deal": done betting. Bets close early once everyone holding a spot is ready. */
  setReady(player: HumanPlayer): string | null {
    const member = this.members.get(player.id);
    if (!member || !this.bettingOpen) return null;
    if (!this.ownedSpots(player).some((spot) => this.table.spots[spot]!.bet > 0)) return "Place a bet first.";
    this.commitDrain(member);
    member.ready = true;
    this.checkBettingDone();
    this.broadcast([]);
    return null;
  }

  insurance(player: HumanPlayer, take: boolean): string | null {
    const spots = this.table.pendingInsurance().filter((spot) => this.owners[spot] === player);
    if (spots.length === 0) return null;
    const cost = spots.reduce((sum, spot) => sum + this.table.insuranceCost(spot), 0);
    if (take && cost > player.bankroll) return "Not enough Dining Dollars for insurance.";
    const events: BlackjackEvent[] = [];
    for (const spot of spots) {
      events.push(...this.table.setInsurance(spot, take));
      if (take) this.stake(player, this.table.insuranceCost(spot));
    }
    player.sendSession();
    if (this.table.pendingInsurance().every((spot) => !(this.owners[spot] instanceof HumanPlayer))) {
      // Every human has decided: don't make them wait out the clock.
      this.clearTimer();
      this.timer = setTimeout(() => this.closeInsurance(), this.timing.gapMs);
    }
    this.broadcast(events);
    return null;
  }

  /** Validate a human's action and hand it to their pending turn. */
  submitAction(player: HumanPlayer, action: BlackjackAction): string | null {
    const turn = this.turn;
    if (!turn || !turn.human || this.owners[turn.ref.spot] !== player) return "It's not your turn.";
    if (!this.legalFor(player)?.[action]) return "That action isn't allowed right now.";
    return player.submitBlackjackAction(action) ? null : "It's not your turn.";
  }

  // ---------- round loop ----------

  /** After a round (or at start): open bets for humans, or wait out the bot-only interval. */
  private scheduleRound(events: BlackjackEvent[]): void {
    if (this.closed) return;
    this.clearTimer();
    if (this.closing) return this.close();
    if (this.members.size === 0 && this.table.roundId > 0 && this.options.canClose?.(this)) return this.close();
    if (this.hasHumans()) return this.openBetting(events);
    const delay = Math.max(this.timing.gapMs, this.lastRoundStartedAt + this.timing.botOnlyRoundIntervalMs - Date.now());
    this.nextRoundAt = Date.now() + delay;
    this.timer = setTimeout(() => {
      this.nextRoundAt = null;
      this.fillBots();
      this.placeBotBets();
      this.deal();
    }, delay);
    this.broadcast(events);
  }

  private openBetting(events: BlackjackEvent[]): void {
    const now = Date.now();
    this.nextRoundAt = null;
    // Long-gone players lose their seat at the table (no penalty; they can come back any time).
    for (const member of [...this.members.values()]) {
      if (member.disconnectedAt !== null && now - member.disconnectedAt >= this.timing.awayKickMs) this.removeMember(member, true, "removed");
    }
    if (!this.hasHumans()) return this.scheduleRound(events);
    for (const member of this.members.values()) {
      member.ready = false;
      member.drainSince = null;
    }
    this.fillBots();
    this.placeBotBets();
    this.bettingOpen = true;
    this.closingAt = null;
    this.bettingEndsAt = now + blackjackAnimationMs(events) + this.timing.bettingMs;
    this.checkBettingDone();
    this.broadcast(events);
    this.changed();
  }

  /**
   * Last round's players who are still deciding. Once the betting window is over they keep it open
   * by spending their clock (like readying up between poker hands).
   */
  private bankBettors(): Member[] {
    return [...this.members.values()].filter(
      (m) => m.disconnectedAt === null && m.playedLastRound && !m.ready && this.ownedSpots(m.player).length > 0,
    );
  }

  /** Fold any betting-time drain so far into the stored clock. */
  private commitDrain(member: Member) {
    member.timeBankMs = this.liveBank(member);
    member.drainSince = null;
  }

  private liveBank(member: Member): number {
    if (member.drainSince === null) return member.timeBankMs;
    return Math.max(0, member.timeBankMs - Math.max(0, Date.now() - member.drainSince));
  }

  /**
   * Bets close early once every connected human holding a spot has pressed Deal. Otherwise they close when the
   * window ends, unless last round's players are still deciding: then it stays open while their clocks run.
   */
  private checkBettingDone() {
    if (!this.bettingOpen || this.bettingEndsAt === null || this.closingAt !== null) return;
    const now = Date.now();
    const holders = [...this.members.values()].filter((m) => m.disconnectedAt === null && this.ownedSpots(m.player).length > 0);
    const allReady = holders.length > 0 && holders.every((m) => m.ready);
    const windowOver = now >= this.bettingEndsAt;
    let drainers: Member[] = [];
    if (windowOver) {
      for (const m of this.bankBettors()) m.drainSince ??= now;
      drainers = this.bankBettors().filter((m) => this.liveBank(m) > 0);
    }
    this.clearTimer();
    if (allReady) {
      this.closingAt = now + this.timing.gapMs;
      this.timer = setTimeout(() => this.closeBetting(), this.timing.gapMs);
      return;
    }
    if (windowOver && drainers.length === 0) return this.closeBetting();
    const next = windowOver ? Math.min(...drainers.map((m) => this.liveBank(m))) : this.bettingEndsAt - now;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.checkBettingDone();
      if (this.bettingOpen) this.broadcast([]);
    }, next + 1);
  }

  private closeBetting(): void {
    this.clearTimer();
    this.bettingOpen = false;
    this.bettingEndsAt = null;
    this.closingAt = null;
    for (const member of this.members.values()) {
      this.commitDrain(member);
      member.ready = false;
      member.blocked.clear(); // sat out one betting round: those spots are open to them again
      const bets = this.ownedSpots(member.player).flatMap((spot) => {
        const amount = this.table.spots[spot]!.bet;
        return amount > 0 ? [{ spot, amount }] : [];
      });
      if (bets.length > 0) member.lastBets = bets;
      member.playedLastRound = bets.length > 0;
    }
    // Spots held without a bet are given up.
    this.owners.forEach((owner, spot) => {
      if (owner && this.table.spots[spot]!.bet === 0) {
        if (owner instanceof BlackjackBot) this.removeBot(spot);
        else this.owners[spot] = null;
      }
    });
    if (this.table.bettingSpots().length === 0) return this.scheduleRound([]);
    this.deal();
  }

  private deal() {
    this.lastRoundStartedAt = Date.now();
    this.lastActor = null;
    this.afterEvents(this.table.deal());
  }

  private afterEvents(events: BlackjackEvent[]) {
    this.settleMoney(events);
    const animation = blackjackAnimationMs(events);
    const phase = this.table.phase;
    if (phase === "insurance") {
      for (const spot of this.table.pendingInsurance()) {
        const owner = this.owners[spot];
        if (owner instanceof BlackjackBot) {
          const take = owner.strategy.insurance(this.viewFor(owner.id));
          if (take) this.stake(owner, this.table.insuranceCost(spot));
          events.push(...this.table.setInsurance(spot, take));
        }
      }
      const humansPending = this.table.pendingInsurance().length > 0;
      const wait = animation + (humansPending ? this.timing.insuranceMs : this.timing.gapMs);
      this.insuranceEndsAt = humansPending ? Date.now() + wait : null;
      this.timer = setTimeout(() => this.closeInsurance(), wait);
    } else if (phase === "playing") {
      this.timer = setTimeout(() => {
        this.timer = null;
        this.startTurn();
      }, animation);
    } else if (phase === "done") {
      this.recordRound();
      this.timer = setTimeout(() => this.finishRound(), animation + this.timing.resultMs);
    }
    this.broadcast(events);
    this.changed();
  }

  private closeInsurance() {
    this.timer = null;
    this.insuranceEndsAt = null;
    this.afterEvents(this.table.closeInsurance());
  }

  private startTurn() {
    const ref = this.table.active;
    if (!ref || this.closed) return;
    const owner = this.owners[ref.spot];
    const id = ++this.turnCounter;
    const member = owner instanceof HumanPlayer ? this.members.get(owner.id) : undefined;
    const away = owner instanceof HumanPlayer && (!member || member.disconnectedAt !== null);
    const human = owner instanceof HumanPlayer && !away;
    let budgetMs = 0;
    let thinkMs = 0;
    const refill = owner && owner.id === this.lastActor ? BJ_DECISION_REFILL_MS : BJ_TURN_REFILL_MS;
    this.lastActor = owner?.id ?? null;
    if (human) {
      member!.timeBankMs = Math.min(BJ_TIME_BANK_MAX_MS, member!.timeBankMs + refill);
      budgetMs = member!.timeBankMs;
    } else if (owner instanceof BlackjackBot) {
      const [min, max] = this.timing.botDelayMs;
      thinkMs = min + Math.random() * (max - min);
      budgetMs = thinkMs + this.timing.botSafetyMs;
    }
    const turn: Turn = { id, ref: { ...ref }, startedAt: Date.now(), budgetMs, human, abort: new AbortController(), timers: [] };
    this.turn = turn;

    if (!human && !(owner instanceof BlackjackBot)) {
      turn.timers.push(setTimeout(() => this.finishTurn(id, "stand"), this.timing.awayActionDelayMs));
    } else {
      turn.timers.push(setTimeout(() => this.finishTurn(id, "stand", true), budgetMs));
      const ask = () => {
        const decision =
          owner instanceof BlackjackBot
            ? owner.strategy.decide(this.viewFor(owner.id), turn.abort.signal)
            : (owner as HumanPlayer).requestBlackjackAction(turn.abort.signal);
        decision
          .then((action) => this.finishTurn(id, action))
          .catch(() => {
            if (!turn.abort.signal.aborted) this.finishTurn(id, "stand");
          });
      };
      if (owner instanceof BlackjackBot) turn.timers.push(setTimeout(ask, thinkMs));
      else ask();
    }
    this.broadcast([]);
  }

  private finishTurn(id: number, action: BlackjackAction, timedOut = false) {
    const turn = this.turn;
    if (!turn || turn.id !== id || this.closed) return;
    this.turn = null;
    for (const timer of turn.timers) clearTimeout(timer);
    turn.abort.abort();

    const owner = this.owners[turn.ref.spot] ?? null;
    if (turn.human && owner instanceof HumanPlayer) {
      const member = this.members.get(owner.id);
      if (member) member.timeBankMs = timedOut ? 0 : Math.max(0, member.timeBankMs - (Date.now() - turn.startedAt));
    }
    const legal = owner instanceof HumanPlayer ? this.legalFor(owner) : this.table.legal();
    if (!legal?.[action]) action = "stand";
    const cost = this.table.actionCost(action);
    if (owner) this.stake(owner, cost);
    this.afterEvents(this.table.act(action));
  }

  /** Round over: drop players who asked to leave, sweep the cards, start the next round. */
  private finishRound() {
    this.timer = null;
    for (const member of [...this.members.values()]) {
      if (member.leaving) {
        this.removeMember(member, true);
        continue;
      }
      for (const spot of member.releasing) {
        if (this.owners[spot] === member.player) this.owners[spot] = null;
        member.blocked.add(spot);
      }
      member.releasing.clear();
    }
    const events = this.table.clearTable();
    this.scheduleRound(events);
  }

  // ---------- money ----------

  /** Move a stake from its owner onto the felt. */
  private stake(owner: Owner, amount: number) {
    if (amount <= 0) return;
    if (owner instanceof HumanPlayer) {
      owner.bankroll -= amount;
      owner.sendSession();
    } else {
      this.bank.withdraw(amount);
    }
    this.moneyOnTable += amount;
  }

  /** Settled stakes go to the house; the house pays each payout to the spot's owner. */
  private settleMoney(events: BlackjackEvent[]) {
    const pay = (spot: number, stake: number, payout: number) => {
      this.moneyOnTable -= stake;
      this.bank.deposit(stake);
      if (payout <= 0) return;
      this.bank.withdraw(payout);
      const owner = this.owners[spot];
      if (owner instanceof HumanPlayer) {
        owner.bankroll += payout;
        owner.sendSession();
      } else {
        this.bank.deposit(payout);
      }
    };
    for (const e of events) {
      if (e.type === "handSettled") pay(e.spot, e.bet, e.payout);
      else if (e.type === "insuranceSettled") for (const r of e.results) pay(r.spot, r.stake, r.payout);
    }
  }

  /** Give a pre-deal bet back to whoever made it. */
  private refund(spot: number) {
    const amount = this.table.clearBet(spot);
    if (amount <= 0) return;
    this.moneyOnTable -= amount;
    const owner = this.owners[spot];
    if (owner instanceof HumanPlayer) owner.bankroll += amount;
    else this.bank.deposit(amount);
  }

  /** The round just settled: log it for the admin panel, and record it for every human who played a spot. */
  private recordRound() {
    this.logRound();
    const stats = this.options.stats;
    if (!stats) return;
    const t = this.table;
    const dealerBlackjack = isNatural(t.dealer);
    const byPlayer = new Map<HumanPlayer, BlackjackRoundRecord["spots"]>();
    this.owners.forEach((owner, spot) => {
      const s = t.spots[spot]!;
      if (!(owner instanceof HumanPlayer) || s.hands.length === 0) return;
      const insurance = s.insurance ?? 0;
      const spots = byPlayer.get(owner) ?? [];
      spots.push({
        spot,
        insurance,
        insurancePayout: dealerBlackjack ? insurance * 3 : 0,
        hands: s.hands.map((h) => ({
          cards: [...h.cards],
          bet: h.bet,
          doubled: h.doubled,
          split: h.split,
          result: h.result ?? "lose",
          payout: h.payout,
        })),
      });
      byPlayer.set(owner, spots);
    });
    for (const [player, spots] of byPlayer) {
      const sessionId = this.sessionIds.get(player.id);
      if (!sessionId) continue;
      const wagered = spots.reduce((sum, s) => sum + s.insurance + s.hands.reduce((m, h) => m + h.bet, 0), 0);
      const returned = spots.reduce((sum, s) => sum + s.insurancePayout + s.hands.reduce((m, h) => m + h.payout, 0), 0);
      stats.recordBlackjackRound(player.id, {
        game: "blackjack",
        sessionId,
        roundId: t.roundId,
        at: Date.now(),
        dealer: { cards: [...t.dealer], total: handTotal(t.dealer).total },
        spots,
        wagered,
        returned,
        net: returned - wagered,
      });
    }
  }

  /** One entry per round in the admin event log (every blackjack card ends up face up, so all of it is public). */
  private logRound() {
    const log = this.options.eventLog;
    if (!log) return;
    const t = this.table;
    const dealerBlackjack = isNatural(t.dealer);
    const spots: BlackjackRoundLog["spots"] = [];
    this.owners.forEach((owner, spot) => {
      const s = t.spots[spot]!;
      if (!owner || s.hands.length === 0) return;
      const insurance = s.insurance ?? 0;
      const insurancePayout = dealerBlackjack ? insurance * 3 : 0;
      const hands = s.hands.map((h) => ({
        cards: [...h.cards],
        bet: h.bet,
        doubled: h.doubled,
        split: h.split,
        result: h.result ?? ("lose" as const),
        payout: h.payout,
      }));
      const net = insurancePayout - insurance + hands.reduce((sum, h) => sum + h.payout - h.bet, 0);
      spots.push({ spot, player: logPlayer(owner, owner instanceof HumanPlayer), insurance, insurancePayout, hands, net });
    });
    if (spots.length === 0) return;
    // One line per player (a player may hold several spots).
    const byName = new Map<string, number>();
    for (const s of spots) byName.set(s.player.name, (byName.get(s.player.name) ?? 0) + s.net);
    const signed = (n: number) => (n > 0 ? `+${formatDD(n)}` : n < 0 ? `−${formatDD(-n)}` : "push");
    const dealerTotal = handTotal(t.dealer).total;
    const players = [...new Map(spots.map((s) => [s.player.name, s.player])).values()];
    log.add({
      kind: "hand",
      game: "blackjack",
      table: { id: this.id, name: this.name },
      summary: `Round #${t.roundId} · dealer ${dealerBlackjack ? "blackjack" : dealerTotal > 21 ? `bust (${dealerTotal})` : dealerTotal} · ${[...byName].map(([name, net]) => `${name} ${signed(net)}`).join(", ")}`,
      players,
      hand: {
        game: "blackjack",
        roundId: t.roundId,
        stakes: `${formatDD(this.minBet)}–${formatDD(this.maxBet)}`,
        dealer: { cards: [...t.dealer], total: dealerTotal },
        spots,
      },
    });
  }

  /** Everything the room holds right now (for conservation checks). */
  onTable(): number {
    return this.moneyOnTable;
  }

  // ---------- seats ----------

  /** Bots sit in free spots among the first three, up to `maxBots` of them. */
  private fillBots() {
    let bots = this.owners.filter((o) => o instanceof BlackjackBot).length;
    for (let spot = 0; spot < BJ_BOT_SPOTS && bots < this.maxBots; spot += 1) {
      if (this.owners[spot]) continue;
      const names = this.owners.flatMap((o) => (o ? [o.name] : []));
      this.owners[spot] = new BlackjackBot(`bjbot-${++botCounter}`, pickBotName(names), new BasicStrategy());
      bots += 1;
    }
    // maxBots was lowered: the highest bot spots go first.
    for (let spot = BJ_BOT_SPOTS - 1; spot >= 0 && bots > this.maxBots; spot -= 1) {
      if (this.owners[spot] instanceof BlackjackBot) {
        this.removeBot(spot);
        bots -= 1;
      }
    }
  }

  private placeBotBets() {
    this.owners.forEach((owner, spot) => {
      if (!(owner instanceof BlackjackBot) || this.table.spots[spot]!.bet > 0) return;
      const amount = Math.min(this.maxBet, Math.max(this.minBet, Math.round(owner.strategy.bet(this.viewFor(owner.id)))));
      this.bank.withdraw(amount);
      this.moneyOnTable += amount;
      this.table.placeBet(spot, amount);
    });
  }

  private removeBot(spot: number) {
    if (this.table.canBet) this.refund(spot);
    this.owners[spot] = null;
  }

  /** Remove a member and free their spots. Pre-deal bets are refunded. */
  private removeMember(member: Member, notify: boolean, reason: SessionEndReason = "left") {
    const { player } = member;
    const sessionId = this.sessionIds.get(player.id);
    if (sessionId) {
      this.sessionIds.delete(player.id);
      this.options.stats?.closeSession(sessionId, { cashOut: null, reason });
    }
    for (const spot of this.ownedSpots(player)) {
      if (this.table.canBet) this.refund(spot);
      this.owners[spot] = null;
    }
    this.members.delete(player.id);
    if (player.roomId === this.id) {
      player.roomId = null;
      player.game = null;
      if (notify) player.sendBlackjackLeft();
    }
    player.sendSession();
  }

  // ---------- admin ----------

  /** Change how many bot spots are filled (0–3). Applies when the next betting round opens. */
  updateSettings(maxBots: number) {
    this.maxBots = Math.max(0, Math.min(BJ_BOT_SPOTS, maxBots));
    this.changed();
  }

  /** Admin kick: leave at once between rounds, after the round otherwise. Optional timeout from this table. */
  kick(player: HumanPlayer, penaltyMs: number, message = "An admin removed you from the table."): boolean {
    if (!this.members.has(player.id)) return false;
    player.sendError(message);
    this.leave(player);
    if (penaltyMs > 0) this.moderation.setTableTimeout(this.id, this.name, player.id, penaltyMs, "Removed by an admin");
    player.sendSession();
    return true;
  }

  /** Admin close: at once between rounds, otherwise when the current round ends. Bets are refunded. */
  requestClose() {
    if (this.closed) return;
    this.closing = true;
    if (this.table.canBet) this.close();
    else this.changed();
  }

  refresh() {
    this.broadcast([]);
    this.changed();
  }

  /** Everything the admin panel shows about this table. The dealer's hole card is never included. */
  admin(): AdminTable {
    const t = this.table;
    const seats = this.owners.flatMap((owner, spot): AdminSeat[] => {
      if (!owner) return [];
      const s = t.spots[spot]!;
      const member = owner instanceof HumanPlayer ? this.members.get(owner.id) : undefined;
      return [
        {
          seat: spot,
          playerId: owner.id,
          name: owner.name,
          kind: owner.kind,
          stack: null,
          bet: s.bet,
          status: this.bettingOpen ? "betting" : s.hands.length > 0 ? "playing" : "waiting",
          aiCapable: false,
          botMode: null,
          botOverride: null,
          connected: member ? member.disconnectedAt === null : true,
          lastAction: null,
        },
      ];
    });
    return {
      id: this.id,
      game: "blackjack",
      name: this.name,
      stakes: `${formatDD(this.minBet)}–${formatDD(this.maxBet)}`,
      stage: BJ_STAGE_LABEL[this.stage()],
      handId: t.roundId,
      closing: this.closing,
      humans: this.members.size,
      bots: this.owners.filter((o) => o instanceof BlackjackBot).length,
      aiBots: 0,
      waiting: 0,
      chips: this.moneyOnTable,
      pot: 0,
      settings: { maxBots: this.maxBots, maxAi: null },
      seats,
    };
  }

  close() {
    if (this.closed) return;
    this.clearTimer();
    if (this.closing) for (const member of this.members.values()) member.player.sendError("This table was closed by an admin.");
    if (this.turn) for (const timer of this.turn.timers) clearTimeout(timer);
    this.turn = null;
    if (this.table.canBet) this.owners.forEach((_, spot) => this.table.spots[spot]!.bet > 0 && this.refund(spot));
    for (const member of [...this.members.values()]) this.removeMember(member, true, "table closed");
    this.closed = true;
    this.moderation.dropRoom(this.id);
    this.options.onClose?.(this);
  }

  // ---------- views ----------

  stage(): BlackjackStage {
    const phase = this.table.phase;
    if (this.bettingOpen) return "betting";
    if (phase === "insurance") return "insurance";
    if (phase === "playing") return "playing";
    if (phase === "done") return "settled";
    return "waiting";
  }

  summary(): BlackjackRoomSummary {
    return {
      id: this.id,
      name: this.name,
      minBet: this.minBet,
      maxBet: this.maxBet,
      humans: this.members.size,
      bots: this.owners.filter((o) => o instanceof BlackjackBot).length,
      spots: this.owners.map((o) => (o ? o.kind : null)),
      stage: this.stage(),
      highRoller: this.minBet >= BJ_HIGH_ROLLER_MIN_BET,
    };
  }

  viewFor(playerId: string | null): BlackjackTableView {
    const t = this.table;
    const now = Date.now();
    const member = playerId ? this.members.get(playerId) : undefined;
    const me = member?.player ?? null;

    const spots = this.owners.map((owner, spot): BlackjackSpotView | null => {
      if (!owner) return null;
      const s = t.spots[spot]!;
      const ownerMember = owner instanceof HumanPlayer ? this.members.get(owner.id) : undefined;
      return {
        spot,
        playerId: owner.id,
        name: owner.name,
        kind: owner.kind,
        bet: s.bet,
        hands: s.hands.map((h) => {
          const { total, soft } = handTotal(h.cards);
          return { cards: [...h.cards], bet: h.bet, doubled: h.doubled, total, soft, status: h.status, result: h.result, payout: h.payout };
        }),
        insurance: s.insurance,
        ready: ownerMember && this.bettingOpen ? ownerMember.ready : null,
        connected: ownerMember ? ownerMember.disconnectedAt === null : true,
        leaving: ownerMember?.leaving ?? false,
        releasing: ownerMember?.releasing.has(spot) ?? false,
      };
    });

    const visible = t.visibleDealer();
    const faceUp = visible.filter((c) => c !== null);
    const dealerTotal = faceUp.length > 0 ? handTotal(faceUp) : null;
    const pendingInsurance = me ? t.pendingInsurance().filter((spot) => this.owners[spot] === me) : [];
    const turn = this.turn;
    const mySpots = me ? this.ownedSpots(me) : this.owners.flatMap((o, i) => (o && o.id === playerId ? [i] : []));
    const myTurn = turn !== null && mySpots.includes(turn.ref.spot);

    return {
      roomId: this.id,
      name: this.name,
      minBet: this.minBet,
      maxBet: this.maxBet,
      roundId: t.roundId,
      stage: this.stage(),
      spots,
      dealer: { cards: visible, total: dealerTotal?.total ?? null, soft: dealerTotal?.soft ?? false },
      toAct: turn ? { ...turn.ref } : null,
      turnRemainingMs: turn?.human ? Math.max(0, turn.budgetMs - (now - turn.startedAt)) : null,
      phaseRemainingMs: this.bettingOpen
        ? this.closingAt !== null
          ? Math.max(0, this.closingAt - now)
          : this.bettingEndsAt !== null && now < this.bettingEndsAt
            ? this.bettingEndsAt - now
            : null // running on players' clocks
        : this.insuranceEndsAt !== null
            ? Math.max(0, this.insuranceEndsAt - now)
            : null,
      nextRoundInMs: this.nextRoundAt === null ? null : Math.max(0, this.nextRoundAt - now),
      // Only to the nearest quarter deck: reading the shoe and tray is part of the (secret) counting game.
      shoe: { decks: t.shoe.decks, level: quarterDecks(t.shoe.cardsRemaining, t.shoe.size), tray: quarterDecks(t.shoe.discarded, t.shoe.size) },
      mySpots,
      myBankroll: me?.bankroll ?? 0,
      myTimeBankMs: member ? (myTurn && turn!.human ? Math.max(0, turn!.budgetMs - (now - turn!.startedAt)) : this.liveBank(member)) : 0,
      myBettingClock:
        member && this.bettingOpen && this.closingAt === null && this.bankBettors().includes(member)
          ? this.bettingEndsAt !== null && now < this.bettingEndsAt
            ? "window"
            : this.liveBank(member) > 0
              ? "bank"
              : null
          : null,
      waitingFor:
        this.bettingOpen && this.closingAt === null && this.bettingEndsAt !== null && now >= this.bettingEndsAt
          ? this.bankBettors().filter((m) => this.liveBank(m) > 0).map((m) => m.player.name)
          : [],
      myLegal: myTurn ? (me ? this.legalFor(me) : t.legal()) : null,
      myInsurance:
        pendingInsurance.length > 0
          ? { spots: pendingInsurance, cost: pendingInsurance.reduce((sum, spot) => sum + t.insuranceCost(spot), 0) }
          : null,
      myLastBets: member ? member.lastBets.map((b) => ({ ...b })) : [],
      myBlockedSpots: member ? [...member.blocked] : [],
      amReady: member?.ready ?? false,
      leaveMode: !member ? "now" : member.leaving ? "queued" : me && this.canLeaveNow(me) ? "now" : "after-hand",
      members: this.members.size,
    };
  }

  /** Engine-legal actions, minus doubles/splits the player can't afford. */
  private legalFor(player: HumanPlayer) {
    const legal = this.table.legal();
    if (!legal) return null;
    const cost = this.table.actionCost("double");
    return { ...legal, double: legal.double && cost <= player.bankroll, split: legal.split && cost <= player.bankroll };
  }

  private broadcast(events: BlackjackEvent[]) {
    if (this.closed) return;
    this.seq += 1;
    for (const { player } of this.members.values()) {
      if (player.roomId === this.id) player.notifyBlackjack({ view: this.viewFor(player.id), events, seq: this.seq });
    }
  }

  // ---------- helpers ----------

  humanCount(): number {
    return this.members.size;
  }

  hasHumans(): boolean {
    return this.members.size > 0;
  }

  ownedSpots(player: Owner): number[] {
    return this.owners.flatMap((o, spot) => (o === player ? [spot] : []));
  }

  private clearTimer() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private changed() {
    this.options.onChange?.(this);
  }
}
