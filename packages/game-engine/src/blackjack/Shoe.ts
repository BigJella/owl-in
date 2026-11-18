import { createDeck, shuffle, type PlayingCard } from "../cards/Deck";

export interface ShoeOptions {
  decks: number;
  /** Roughly how much of the shoe is dealt before the cut card comes out (0..1). */
  penetration: number;
  random?: () => number;
  /** Rig the shoe for tests: cards are drawn in this order; the cut card sits at `cutAt` (default: never). */
  stacked?: PlayingCard[];
  cutAt?: number;
}

/**
 * A casino shoe: several decks shuffled together, a cut card placed around `penetration`,
 * and a discard tray. Cards persist across rounds; it is only reshuffled between rounds
 * once the cut card has come out (no continuous shuffling).
 */
export class Shoe {
  readonly decks: number;
  private readonly penetration: number;
  private readonly random: () => number;
  private cards: PlayingCard[] = [];
  private drawn = 0;
  private cutIndex = 0;
  /** Cards in the discard tray (burned + cleared from the table). */
  discarded = 0;

  constructor(options: ShoeOptions) {
    this.decks = options.decks;
    this.penetration = options.penetration;
    this.random = options.random ?? Math.random;
    if (options.stacked) {
      this.cards = [...options.stacked];
      this.cutIndex = options.cutAt ?? Infinity;
    } else {
      this.shuffle();
    }
  }

  get size(): number {
    return this.decks * 52;
  }

  get cardsRemaining(): number {
    return this.cards.length - this.drawn;
  }

  /** The cut card has come out: shuffle before the next round. */
  get needsShuffle(): boolean {
    return this.drawn >= this.cutIndex;
  }

  /** Fresh shoe: every card back in, cut card placed at penetration ±5%. */
  shuffle() {
    const all: PlayingCard[] = [];
    for (let d = 0; d < this.decks; d += 1) all.push(...createDeck());
    this.cards = shuffle(all, this.random);
    this.drawn = 0;
    this.discarded = 0;
    const jitter = (this.random() - 0.5) * 0.1;
    this.cutIndex = Math.round(this.cards.length * Math.min(0.95, Math.max(0.3, this.penetration + jitter)));
  }

  draw(): PlayingCard {
    // Only reachable with an absurdly deep cut card; keep dealing rather than crash.
    if (this.drawn >= this.cards.length) this.shuffle();
    const card = this.cards[this.drawn]!;
    this.drawn += 1;
    return card;
  }

  /** Burn the top card face down into the tray. */
  burn() {
    this.draw();
    this.discarded += 1;
  }

  discard(count: number) {
    this.discarded += count;
  }
}
