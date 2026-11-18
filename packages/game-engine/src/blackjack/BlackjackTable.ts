import type { PlayingCard } from "../cards/Deck";
import { handTotal, isNatural, isPair, rankValue } from "./hand";
import { Shoe, type ShoeOptions } from "./Shoe";

/**
 * Blackjack rules (agreed with the user):
 * 6-deck shoe, dealer stands on all 17s, blackjack pays 3:2, double on any two cards (also after a split),
 * split pairs up to 4 hands, split aces once and get one card each, insurance 2:1 against a dealer ace,
 * the dealer peeks on A/10 before anyone plays, late surrender (first decision, not after a split).
 * Spot 0 is "first base" (dealer's left) and acts first.
 */
export const BLACKJACK_SPOTS = 7;
export const MAX_SPLIT_HANDS = 4;

export type BlackjackAction = "hit" | "stand" | "double" | "split" | "surrender";
/** idle: no round (bets can be placed once the table is cleared). done: settled, cards still showing. */
export type BlackjackPhase = "idle" | "insurance" | "playing" | "done";
export type HandStatus = "playing" | "stood" | "bust" | "blackjack" | "surrendered";
export type HandResult = "win" | "lose" | "push" | "blackjack" | "surrender";

export interface BlackjackHand {
  cards: PlayingCard[];
  bet: number;
  doubled: boolean;
  status: HandStatus;
  /** Came from a split (so a two-card 21 is not a blackjack, and no surrender). */
  split: boolean;
  splitAces: boolean;
  result: HandResult | null;
  /** Everything returned to the player at settlement (stake included). */
  payout: number;
}

export interface BlackjackSpot {
  /** The bet placed on this spot for the next / current round. */
  bet: number;
  hands: BlackjackHand[];
  /** Insurance stake: null = not decided (or not offered), 0 = declined. */
  insurance: number | null;
}

export interface BlackjackLegal {
  hit: boolean;
  stand: boolean;
  double: boolean;
  split: boolean;
  surrender: boolean;
}

export interface HandRef {
  spot: number;
  hand: number;
}

export type DealTarget = HandRef | "dealer";

/** Everything here is public: the dealer's hole card is dealt as `card: null` and shown later in holeRevealed. */
export type BlackjackEvent =
  | { type: "roundStarted"; roundId: number; bets: { spot: number; amount: number }[] }
  | { type: "cardDealt"; target: DealTarget; card: PlayingCard | null }
  | { type: "insuranceOffered" }
  | { type: "insuranceDecided"; spot: number; amount: number }
  | { type: "dealerPeeked"; blackjack: boolean }
  | { type: "insuranceSettled"; results: { spot: number; stake: number; payout: number }[] }
  | { type: "playerActed"; spot: number; hand: number; action: BlackjackAction; amount: number }
  | { type: "handSplit"; spot: number; hand: number }
  | { type: "holeRevealed"; card: PlayingCard }
  | { type: "handSettled"; spot: number; hand: number; bet: number; result: HandResult; payout: number }
  | { type: "roundEnded"; dealerTotal: number; dealerBlackjack: boolean }
  | { type: "tableCleared"; cards: number }
  | { type: "shuffled" };

export interface BlackjackTableOptions extends Partial<ShoeOptions> {
  /** Supply a rigged shoe in tests. */
  shoe?: Shoe;
}

const emptySpot = (): BlackjackSpot => ({ bet: 0, hands: [], insurance: null });

export class BlackjackTable {
  readonly shoe: Shoe;
  phase: BlackjackPhase = "idle";
  roundId = 0;
  readonly spots: BlackjackSpot[] = Array.from({ length: BLACKJACK_SPOTS }, emptySpot);
  dealer: PlayingCard[] = [];
  holeRevealed = false;
  active: HandRef | null = null;
  private insuranceOffered = false;

  constructor(options: BlackjackTableOptions = {}) {
    this.shoe =
      options.shoe ??
      new Shoe({ decks: options.decks ?? 6, penetration: options.penetration ?? 0.75, ...(options.random ? { random: options.random } : {}) });
  }

  /** Cards from the last round are still on the felt. */
  get hasCardsOut(): boolean {
    return this.dealer.length > 0;
  }

  get canBet(): boolean {
    return this.phase === "idle" && !this.hasCardsOut;
  }

  placeBet(spot: number, amount: number) {
    if (!this.canBet) throw new Error("Bets are closed.");
    if (!Number.isInteger(amount) || amount <= 0) throw new Error("Invalid bet.");
    this.spots[spot]!.bet = amount;
  }

  /** Take a bet back before the deal. Returns the amount. */
  clearBet(spot: number): number {
    if (!this.canBet) throw new Error("Bets are closed.");
    const amount = this.spots[spot]!.bet;
    this.spots[spot]!.bet = 0;
    return amount;
  }

  bettingSpots(): number[] {
    return this.spots.flatMap((s, i) => (s.bet > 0 ? [i] : []));
  }

  // ---------- the round ----------

  deal(): BlackjackEvent[] {
    if (!this.canBet) throw new Error("Clear the table first.");
    const playing = this.bettingSpots();
    if (playing.length === 0) throw new Error("No bets.");
    this.roundId += 1;
    const events: BlackjackEvent[] = [
      { type: "roundStarted", roundId: this.roundId, bets: playing.map((spot) => ({ spot, amount: this.spots[spot]!.bet })) },
    ];
    for (const spot of playing) {
      const s = this.spots[spot]!;
      s.insurance = null;
      s.hands = [{ cards: [], bet: s.bet, doubled: false, status: "playing", split: false, splitAces: false, result: null, payout: 0 }];
    }
    this.holeRevealed = false;
    for (let round = 0; round < 2; round += 1) {
      for (const spot of playing) {
        const card = this.shoe.draw();
        this.spots[spot]!.hands[0]!.cards.push(card);
        events.push({ type: "cardDealt", target: { spot, hand: 0 }, card });
      }
      const card = this.shoe.draw();
      this.dealer.push(card);
      events.push({ type: "cardDealt", target: "dealer", card: round === 0 ? card : null });
    }
    for (const spot of playing) {
      const hand = this.spots[spot]!.hands[0]!;
      if (isNatural(hand.cards)) hand.status = "blackjack";
    }

    if (this.dealer[0]!.rank === "A") {
      this.phase = "insurance";
      this.insuranceOffered = true;
      events.push({ type: "insuranceOffered" });
      return events;
    }
    this.insuranceOffered = false;
    return [...events, ...this.peekAndPlay()];
  }

  /** Spots still deciding on insurance. */
  pendingInsurance(): number[] {
    if (this.phase !== "insurance") return [];
    return this.bettingSpots().filter((spot) => this.spots[spot]!.insurance === null);
  }

  /** Insurance costs half the original bet. Returns the events (amount 0 = declined). */
  setInsurance(spot: number, take: boolean): BlackjackEvent[] {
    const s = this.spots[spot];
    if (this.phase !== "insurance" || !s || s.hands.length === 0 || s.insurance !== null) throw new Error("No insurance decision here.");
    s.insurance = take ? this.insuranceCost(spot) : 0;
    return [{ type: "insuranceDecided", spot, amount: s.insurance }];
  }

  insuranceCost(spot: number): number {
    return Math.floor(this.spots[spot]!.bet / 2);
  }

  /** Close insurance (undecided = declined), peek, and either end the round or start play. */
  closeInsurance(): BlackjackEvent[] {
    if (this.phase !== "insurance") return [];
    for (const spot of this.bettingSpots()) this.spots[spot]!.insurance ??= 0;
    return this.peekAndPlay();
  }

  private peekAndPlay(): BlackjackEvent[] {
    const events: BlackjackEvent[] = [];
    const up = rankValue(this.dealer[0]!.rank);
    const dealerBlackjack = isNatural(this.dealer);
    if (up === 1 || up === 10) events.push({ type: "dealerPeeked", blackjack: dealerBlackjack });
    if (this.insuranceOffered) {
      events.push({
        type: "insuranceSettled",
        results: this.bettingSpots().map((spot) => {
          const stake = this.spots[spot]!.insurance ?? 0;
          return { spot, stake, payout: dealerBlackjack ? stake * 3 : 0 };
        }),
      });
    }
    if (dealerBlackjack) {
      this.revealHole(events);
      this.settle(events, true);
      return events;
    }
    this.phase = "playing";
    this.active = null;
    this.advance(events, { spot: 0, hand: 0 });
    return events;
  }

  legal(): BlackjackLegal | null {
    if (this.phase !== "playing" || !this.active) return null;
    const spot = this.spots[this.active.spot]!;
    const hand = spot.hands[this.active.hand]!;
    const two = hand.cards.length === 2;
    return {
      hit: true,
      stand: true,
      double: two && !hand.splitAces,
      split: two && isPair(hand.cards) && spot.hands.length < MAX_SPLIT_HANDS && !hand.splitAces,
      surrender: two && !hand.split && spot.hands.length === 1,
    };
  }

  /** Extra stake an action needs (double / split): the hand's current bet. */
  actionCost(action: BlackjackAction): number {
    if (!this.active || (action !== "double" && action !== "split")) return 0;
    return this.spots[this.active.spot]!.hands[this.active.hand]!.bet;
  }

  act(action: BlackjackAction): BlackjackEvent[] {
    const legal = this.legal();
    if (!legal || !this.active || !legal[action]) throw new Error(`Illegal action: ${action}`);
    const ref = this.active;
    const spot = this.spots[ref.spot]!;
    const hand = spot.hands[ref.hand]!;
    const events: BlackjackEvent[] = [
      { type: "playerActed", spot: ref.spot, hand: ref.hand, action, amount: this.actionCost(action) },
    ];

    switch (action) {
      case "hit": {
        this.drawTo(events, ref);
        const { total } = handTotal(hand.cards);
        if (total > 21) hand.status = "bust";
        else if (total === 21) hand.status = "stood"; // auto-stand on 21
        break;
      }
      case "stand":
        hand.status = "stood";
        break;
      case "double":
        hand.bet *= 2;
        hand.doubled = true;
        this.drawTo(events, ref);
        hand.status = handTotal(hand.cards).total > 21 ? "bust" : "stood";
        break;
      case "split": {
        const aces = hand.cards[0]!.rank === "A";
        const moved = hand.cards.pop()!;
        hand.split = true;
        hand.splitAces = aces;
        spot.hands.splice(ref.hand + 1, 0, {
          cards: [moved],
          bet: hand.bet,
          doubled: false,
          status: "playing",
          split: true,
          splitAces: aces,
          result: null,
          payout: 0,
        });
        events.push({ type: "handSplit", spot: ref.spot, hand: ref.hand });
        break;
      }
      case "surrender":
        hand.status = "surrendered";
        break;
    }
    this.advance(events, ref);
    return events;
  }

  /** What an absent/timed-out player does. */
  defaultAction(): BlackjackAction {
    return "stand";
  }

  private drawTo(events: BlackjackEvent[], ref: HandRef) {
    const card = this.shoe.draw();
    this.spots[ref.spot]!.hands[ref.hand]!.cards.push(card);
    events.push({ type: "cardDealt", target: { ...ref }, card });
  }

  /**
   * Move to the next hand that needs a decision, starting at `from` (inclusive). Split hands get their
   * second card when they come up; split aces and 21s stand automatically. No one left: the dealer plays.
   */
  private advance(events: BlackjackEvent[], from: HandRef) {
    for (let s = from.spot; s < BLACKJACK_SPOTS; s += 1) {
      const hands = this.spots[s]!.hands;
      for (let h = s === from.spot ? from.hand : 0; h < hands.length; h += 1) {
        const hand = hands[h]!;
        if (hand.status !== "playing") continue;
        if (hand.cards.length === 1) {
          this.drawTo(events, { spot: s, hand: h });
          if (hand.splitAces) {
            hand.status = "stood";
            continue;
          }
        }
        if (handTotal(hand.cards).total === 21) {
          hand.status = "stood";
          continue;
        }
        this.active = { spot: s, hand: h };
        return;
      }
    }
    this.active = null;
    this.dealerTurn(events);
  }

  private revealHole(events: BlackjackEvent[]) {
    if (this.holeRevealed) return;
    this.holeRevealed = true;
    events.push({ type: "holeRevealed", card: this.dealer[1]! });
  }

  private dealerTurn(events: BlackjackEvent[]) {
    this.revealHole(events);
    const live = this.spots.some((s) => s.hands.some((h) => h.status === "stood"));
    if (live) {
      // Stands on all 17s, soft ones included.
      while (handTotal(this.dealer).total < 17) {
        const card = this.shoe.draw();
        this.dealer.push(card);
        events.push({ type: "cardDealt", target: "dealer", card });
      }
    }
    this.settle(events, false);
  }

  private settle(events: BlackjackEvent[], dealerBlackjack: boolean) {
    const dealer = handTotal(this.dealer).total;
    this.spots.forEach((spot, s) => {
      spot.hands.forEach((hand, h) => {
        let result: HandResult;
        let payout = 0;
        if (hand.status === "surrendered") {
          result = "surrender";
          payout = Math.floor(hand.bet / 2);
        } else if (hand.status === "bust") {
          result = "lose";
        } else if (hand.status === "blackjack") {
          result = dealerBlackjack ? "push" : "blackjack";
          payout = dealerBlackjack ? hand.bet : hand.bet + Math.floor((hand.bet * 3) / 2);
        } else if (dealerBlackjack) {
          result = "lose";
        } else {
          const mine = handTotal(hand.cards).total;
          result = dealer > 21 || mine > dealer ? "win" : mine === dealer ? "push" : "lose";
          payout = result === "win" ? hand.bet * 2 : result === "push" ? hand.bet : 0;
        }
        if (hand.status === "playing") hand.status = "stood";
        hand.result = result;
        hand.payout = payout;
        events.push({ type: "handSettled", spot: s, hand: h, bet: hand.bet, result, payout });
      });
    });
    this.phase = "done";
    this.active = null;
    events.push({ type: "roundEnded", dealerTotal: dealer, dealerBlackjack });
  }

  /** Sweep the cards into the discard tray; shuffle (and burn one) if the cut card came out. */
  clearTable(): BlackjackEvent[] {
    if (this.phase === "insurance" || this.phase === "playing") throw new Error("Round in progress.");
    const events: BlackjackEvent[] = [];
    const count = this.dealer.length + this.spots.reduce((n, s) => n + s.hands.reduce((m, h) => m + h.cards.length, 0), 0);
    if (count > 0) {
      this.shoe.discard(count);
      events.push({ type: "tableCleared", cards: count });
    }
    for (const spot of this.spots) {
      spot.hands = [];
      spot.insurance = null;
      if (this.phase === "done") spot.bet = 0;
    }
    this.dealer = [];
    this.holeRevealed = false;
    this.phase = "idle";
    if (this.shoe.needsShuffle) {
      this.shoe.shuffle();
      this.shoe.burn();
      events.push({ type: "shuffled" });
    }
    return events;
  }

  /** The dealer's cards as the players see them (hole card hidden until revealed). */
  visibleDealer(): (PlayingCard | null)[] {
    return this.dealer.map((card, i) => (i === 1 && !this.holeRevealed ? null : card));
  }
}
