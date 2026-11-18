import { createDeck, shuffle, type PlayingCard } from "../cards/Deck";
import { evaluateHand, findWinners } from "./evaluate";
import { buildPots, type Pot } from "./pots";

export type Street = "preflop" | "flop" | "turn" | "river";
export type PokerPhase = "idle" | Street;

/** `raise.to` is the player's total bet for this street (a "bet" when nobody has bet yet). */
export type PokerAction = { type: "fold" } | { type: "check" } | { type: "call" } | { type: "raise"; to: number };

export interface LegalActions {
  canCheck: boolean;
  /** Chips needed to call (capped at stack, so a short call is an all-in). */
  callAmount: number;
  canRaise: boolean;
  minRaiseTo: number;
  maxRaiseTo: number;
}

export interface SeatState {
  seat: number;
  playerId: string;
  stack: number;
  holeCards: PlayingCard[];
  /** Dealt into the current/last hand. Players seated mid-hand are false until the next deal. */
  inHand: boolean;
  folded: boolean;
  allIn: boolean;
  /** Chips put in on the current street. */
  bet: number;
  /** Chips put in over the whole hand. */
  contributed: number;
  hasActed: boolean;
}

export interface ShowdownReveal {
  seat: number;
  cards: PlayingCard[];
  handName: string;
}

/** Everything that happens, in order. Contains no hidden information, so it is safe to broadcast. */
export type PokerEvent =
  | { type: "handStarted"; handId: number; button: number; smallBlindSeat: number; bigBlindSeat: number }
  | { type: "blindPosted"; seat: number; amount: number; stack: number }
  | { type: "holeCardsDealt"; seats: number[] }
  | {
      type: "playerActed";
      seat: number;
      action: "fold" | "check" | "call" | "bet" | "raise";
      amount: number;
      bet: number;
      stack: number;
      allIn: boolean;
    }
  | { type: "uncalledReturned"; seat: number; amount: number }
  | { type: "betsCollected"; pots: Pot[] }
  | { type: "communityDealt"; street: Street; cards: PlayingCard[] }
  | { type: "showdown"; reveals: ShowdownReveal[] }
  | { type: "potAwarded"; potIndex: number; amount: number; winners: { seat: number; amount: number }[] }
  | { type: "handEnded"; handId: number };

export interface PokerTableOptions {
  smallBlind: number;
  bigBlind: number;
  maxSeats?: number;
  random?: () => number;
  /** Test hook: returns the deck in draw order (first element is dealt first). */
  deckFactory?: () => PlayingCard[];
}

const NEXT_STREET: Record<Exclude<Street, "river">, { street: Street; cards: number }> = {
  preflop: { street: "flop", cards: 3 },
  flop: { street: "turn", cards: 1 },
  turn: { street: "river", cards: 1 },
};

/**
 * Texas Hold'em state machine. Pure: no timers, no I/O, players are opaque ids.
 * Every mutating call returns the events it produced.
 */
export class PokerTable {
  readonly maxSeats: number;
  readonly smallBlind: number;
  readonly bigBlind: number;
  private readonly random: () => number;
  private readonly deckFactory: (() => PlayingCard[]) | undefined;

  readonly seats: (SeatState | null)[];
  phase: PokerPhase = "idle";
  handId = 0;
  button = -1;
  smallBlindSeat: number | null = null;
  bigBlindSeat: number | null = null;
  community: PlayingCard[] = [];
  /** Pots collected from finished streets. Current-street bets live on the seats. */
  pots: Pot[] = [];
  currentBet = 0;
  lastRaiseSize: number;
  toAct: number | null = null;
  lastShowdown: ShowdownReveal[] = [];
  private deck: PlayingCard[] = [];

  constructor(options: PokerTableOptions) {
    this.smallBlind = options.smallBlind;
    this.bigBlind = options.bigBlind;
    this.maxSeats = options.maxSeats ?? 8;
    this.random = options.random ?? Math.random;
    this.deckFactory = options.deckFactory;
    this.lastRaiseSize = this.bigBlind;
    this.seats = Array.from({ length: this.maxSeats }, () => null);
  }

  // ---------- seating ----------

  seatPlayer(seat: number, playerId: string, stack: number) {
    if (seat < 0 || seat >= this.maxSeats || this.seats[seat]) throw new Error(`Seat ${seat} unavailable`);
    this.seats[seat] = {
      seat,
      playerId,
      stack,
      holeCards: [],
      inHand: false,
      folded: false,
      allIn: false,
      bet: 0,
      contributed: 0,
      hasActed: false,
    };
  }

  /** Allowed between hands, or mid-hand for a seat that wasn't dealt in. Returns the chips they leave with. */
  removePlayer(seat: number): number {
    const s = this.seats[seat];
    if (!s) return 0;
    if (this.phase !== "idle" && s.inHand) throw new Error("Cannot remove a player who is in the hand");
    this.seats[seat] = null;
    return s.stack;
  }

  addChips(seat: number, amount: number) {
    if (this.phase !== "idle") throw new Error("Cannot add chips during a hand");
    const s = this.requireSeat(seat);
    s.stack += amount;
  }

  emptySeats(): number[] {
    return this.seats.flatMap((s, i) => (s ? [] : [i]));
  }

  occupiedSeats(): SeatState[] {
    return this.seats.filter((s): s is SeatState => s !== null);
  }

  canStartHand(): boolean {
    return this.phase === "idle" && this.occupiedSeats().filter((s) => s.stack > 0).length >= 2;
  }

  /** Chips in front of players plus everything in the middle. */
  totalChips(): number {
    return this.occupiedSeats().reduce((sum, s) => sum + s.stack + s.bet, 0) + this.potTotal();
  }

  potTotal(): number {
    return this.pots.reduce((sum, p) => sum + p.amount, 0);
  }

  // ---------- hand flow ----------

  startHand(): PokerEvent[] {
    if (!this.canStartHand()) throw new Error("Cannot start a hand");
    const events: PokerEvent[] = [];
    const eligible = (s: SeatState) => s.stack > 0;

    for (const s of this.occupiedSeats()) {
      Object.assign(s, { holeCards: [], inHand: eligible(s), folded: false, allIn: false, bet: 0, contributed: 0, hasActed: false });
    }
    this.handId += 1;
    this.community = [];
    this.pots = [];
    this.lastShowdown = [];
    this.currentBet = 0;
    this.lastRaiseSize = this.bigBlind;
    this.deck = this.deckFactory ? this.deckFactory().reverse() : shuffle(createDeck(), this.random);
    this.phase = "preflop";

    const dealtIn = this.occupiedSeats().filter((s) => s.inHand);
    this.button = this.nextSeat(this.button, (s) => s.inHand)!;
    const headsUp = dealtIn.length === 2;
    const smallBlindSeat = headsUp ? this.button : this.nextSeat(this.button, (s) => s.inHand)!;
    const bigBlindSeat = this.nextSeat(smallBlindSeat, (s) => s.inHand)!;
    this.smallBlindSeat = smallBlindSeat;
    this.bigBlindSeat = bigBlindSeat;

    events.push({ type: "handStarted", handId: this.handId, button: this.button, smallBlindSeat, bigBlindSeat });
    for (const [seat, amount] of [[smallBlindSeat, this.smallBlind], [bigBlindSeat, this.bigBlind]] as const) {
      const s = this.requireSeat(seat);
      this.putChips(s, Math.min(amount, s.stack));
      events.push({ type: "blindPosted", seat, amount: s.bet, stack: s.stack });
    }
    this.currentBet = this.bigBlind;

    // Two cards each, one at a time, starting left of the button.
    const order: number[] = [];
    for (let seat = this.nextSeat(this.button, (s) => s.inHand)!; !order.includes(seat); seat = this.nextSeat(seat, (s) => s.inHand)!) {
      order.push(seat);
    }
    for (let round = 0; round < 2; round += 1) {
      for (const seat of order) this.requireSeat(seat).holeCards.push(this.draw());
    }
    events.push({ type: "holeCardsDealt", seats: order });

    this.progress(events, bigBlindSeat);
    return events;
  }

  legalActions(seat: number): LegalActions {
    const s = this.requireSeat(seat);
    const toCall = Math.max(0, this.currentBet - s.bet);
    const maxRaiseTo = s.bet + s.stack;
    const othersCanRespond = this.liveSeats().some((o) => o.seat !== seat && !o.allIn);
    return {
      canCheck: toCall === 0,
      callAmount: Math.min(toCall, s.stack),
      canRaise: !s.hasActed && s.stack > toCall && othersCanRespond,
      minRaiseTo: Math.min(this.currentBet + this.lastRaiseSize, maxRaiseTo),
      maxRaiseTo,
    };
  }

  /** What happens when a player's clock runs out. */
  defaultAction(seat: number): PokerAction {
    return this.legalActions(seat).canCheck ? { type: "check" } : { type: "fold" };
  }

  act(seat: number, action: PokerAction): PokerEvent[] {
    if (this.phase === "idle" || this.toAct !== seat) throw new Error(`Not seat ${seat}'s turn`);
    const s = this.requireSeat(seat);
    const legal = this.legalActions(seat);
    const events: PokerEvent[] = [];
    let label: Extract<PokerEvent, { type: "playerActed" }>["action"];
    let amount = 0;

    switch (action.type) {
      case "fold":
        s.folded = true;
        label = "fold";
        break;
      case "check":
        if (!legal.canCheck) throw new Error("Cannot check facing a bet");
        label = "check";
        break;
      case "call":
        if (legal.callAmount === 0) {
          label = "check";
          break;
        }
        amount = legal.callAmount;
        this.putChips(s, amount);
        label = "call";
        break;
      case "raise": {
        const to = Math.floor(action.to);
        if (!legal.canRaise || to < legal.minRaiseTo || to > legal.maxRaiseTo) {
          throw new Error(`Illegal raise to ${action.to}`);
        }
        label = this.currentBet === 0 ? "bet" : "raise";
        amount = to - s.bet;
        const raiseSize = to - this.currentBet;
        this.putChips(s, amount);
        if (raiseSize >= this.lastRaiseSize) {
          // Full raise re-opens the action for everyone else.
          this.lastRaiseSize = raiseSize;
          for (const other of this.liveSeats()) if (other.seat !== seat) other.hasActed = false;
        }
        this.currentBet = Math.max(this.currentBet, to);
        break;
      }
    }

    s.hasActed = true;
    events.push({ type: "playerActed", seat, action: label, amount, bet: s.bet, stack: s.stack, allIn: s.allIn });
    this.progress(events, seat);
    return events;
  }

  // ---------- internals ----------

  private progress(events: PokerEvent[], fromSeat: number) {
    if (this.liveSeats().length === 1) return this.finishUncontested(events);

    const canAct = this.liveSeats().filter((s) => !s.allIn);
    const needsAction = (s: SeatState) =>
      s.inHand &&
      !s.folded &&
      !s.allIn &&
      (!s.hasActed || s.bet < this.currentBet) &&
      // Alone with chips and nothing to call: nobody left to bet against.
      !(canAct.length <= 1 && s.bet >= this.currentBet);

    const next = this.nextSeat(fromSeat, needsAction);
    if (next !== null) {
      this.toAct = next;
      return;
    }
    this.endStreet(events);
  }

  private endStreet(events: PokerEvent[]) {
    this.toAct = null;
    this.returnUncalledBet(events);
    this.collectBets(events);

    if (this.phase === "river") return this.showdown(events);

    const next = NEXT_STREET[this.phase as Exclude<Street, "river">];
    this.draw(); // burn
    const cards = Array.from({ length: next.cards }, () => this.draw());
    this.community.push(...cards);
    this.phase = next.street;
    events.push({ type: "communityDealt", street: next.street, cards });
    this.progress(events, this.button);
  }

  private returnUncalledBet(events: PokerEvent[]) {
    const bettors = this.occupiedSeats().filter((s) => s.bet > 0).sort((a, b) => b.bet - a.bet);
    const top = bettors[0];
    if (!top) return;
    const excess = top.bet - (bettors[1]?.bet ?? 0);
    if (excess <= 0) return;
    top.bet -= excess;
    top.contributed -= excess;
    top.stack += excess;
    top.allIn = false;
    events.push({ type: "uncalledReturned", seat: top.seat, amount: excess });
  }

  private collectBets(events: PokerEvent[]) {
    const hadBets = this.occupiedSeats().some((s) => s.bet > 0);
    this.pots = buildPots(
      this.occupiedSeats()
        .filter((s) => s.inHand)
        .map((s) => ({ seat: s.seat, contributed: s.contributed, folded: s.folded })),
    );
    for (const s of this.occupiedSeats()) {
      s.bet = 0;
      s.hasActed = false;
    }
    this.currentBet = 0;
    this.lastRaiseSize = this.bigBlind;
    if (hadBets) events.push({ type: "betsCollected", pots: this.pots.map((p) => ({ amount: p.amount, eligibleSeats: [...p.eligibleSeats] })) });
  }

  private finishUncontested(events: PokerEvent[]) {
    this.toAct = null;
    this.returnUncalledBet(events);
    this.collectBets(events);
    const winner = this.liveSeats()[0]!;
    this.pots.forEach((pot, potIndex) => {
      winner.stack += pot.amount;
      events.push({ type: "potAwarded", potIndex, amount: pot.amount, winners: [{ seat: winner.seat, amount: pot.amount }] });
    });
    this.endHand(events);
  }

  private showdown(events: PokerEvent[]) {
    const live = this.liveSeats();
    this.lastShowdown = live.map((s) => ({
      seat: s.seat,
      cards: [...s.holeCards],
      handName: evaluateHand([...s.holeCards, ...this.community]).description,
    }));
    events.push({ type: "showdown", reveals: this.lastShowdown.map((r) => ({ ...r, cards: [...r.cards] })) });

    this.pots.forEach((pot, potIndex) => {
      const winners = findWinners(
        pot.eligibleSeats.map((seat) => ({ key: seat, cards: [...this.requireSeat(seat).holeCards, ...this.community] })),
      );
      // Odd chips go to winners closest to the left of the button.
      const ordered = this.clockwiseFrom(this.button).filter((seat) => winners.includes(seat));
      const share = Math.floor(pot.amount / ordered.length);
      let remainder = pot.amount - share * ordered.length;
      const payouts = ordered.map((seat) => {
        const amount = share + (remainder-- > 0 ? 1 : 0);
        this.requireSeat(seat).stack += amount;
        return { seat, amount };
      });
      events.push({ type: "potAwarded", potIndex, amount: pot.amount, winners: payouts });
    });
    this.endHand(events);
  }

  private endHand(events: PokerEvent[]) {
    this.pots = [];
    this.toAct = null;
    this.phase = "idle";
    events.push({ type: "handEnded", handId: this.handId });
  }

  private putChips(s: SeatState, amount: number) {
    s.stack -= amount;
    s.bet += amount;
    s.contributed += amount;
    if (s.stack === 0) s.allIn = true;
  }

  private draw(): PlayingCard {
    const card = this.deck.pop();
    if (!card) throw new Error("Deck is empty");
    return card;
  }

  private liveSeats(): SeatState[] {
    return this.occupiedSeats().filter((s) => s.inHand && !s.folded);
  }

  /** Seats in clockwise order starting just after `from`. */
  private clockwiseFrom(from: number): number[] {
    return Array.from({ length: this.maxSeats }, (_, i) => (((from + 1 + i) % this.maxSeats) + this.maxSeats) % this.maxSeats);
  }

  private nextSeat(from: number, predicate: (s: SeatState) => boolean): number | null {
    for (const seat of this.clockwiseFrom(from)) {
      const s = this.seats[seat];
      if (s && predicate(s)) return seat;
    }
    return null;
  }

  private requireSeat(seat: number): SeatState {
    const s = this.seats[seat];
    if (!s) throw new Error(`Seat ${seat} is empty`);
    return s;
  }
}
