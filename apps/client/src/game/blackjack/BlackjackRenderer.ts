import { gsap } from "gsap";
import { Container, Graphics, Rectangle, Sprite, Text, type Application, type Texture } from "pixi.js";
import {
  BJ_RESULT_LABEL,
  BJ_SPOTS,
  describeBlackjackAction,
  formatDD,
  type BlackjackEvent,
  type BlackjackTableView,
  type HandResult,
  type PlayingCard,
} from "@owl-in/shared";
import type { ReceivedBlackjack } from "../../networking/blackjackStore";
import type { PokerTextures } from "../poker/assets";

// Fixed design space, scaled to fit the canvas (same as the poker table).
const W = 1200;
const H = 720;
const CX = W / 2;
const CARD_W = 50;
const CARD_H = 70;
const DEALER_W = 60;
/** The straight (dealer) edge of the half-moon; the arc and spots are centred on it. */
const TOP = 20;
const DEALER_H = 84;
const DEALER_Y = 104;
const BOX = 66;
/** Each extra card in a hand cascades up and to the right. */
const CASCADE = { x: 14, y: -17 };
const SHOE = { x: 820, y: 86, w: 60, h: 90 };
const TRAY = { x: 380, y: 86, w: 60, h: 90 };
const FONT = '"Oswald", "Inter", system-ui, sans-serif';
// Colours mirror the CSS tokens in styles.css.
const GOLD = 0xffb81c;
const GOLD_DIM = 0x8a6200;
const INK = 0x0a0a0a;
const SURFACE = 0x141414;
const LINE = 0x2e2e2e;
const TEXT = 0xf2f2f2;
const MUTED = 0x8a8a8a;
const DANGER = 0xe0393e;
const PAPER = 0xd9d9d9;

interface Point {
  x: number;
  y: number;
}

interface LocalHand {
  cards: PlayingCard[];
  doubled: boolean;
  result: HandResult | null;
  total: number | null;
}

interface LocalSpot {
  bet: number;
  hands: LocalHand[];
}

interface SpotNode {
  box: Graphics;
  boxNumber: Text;
  chip: Sprite;
  chipText: Text;
  plate: Container;
  plateBg: Graphics;
  name: Text;
  badge: Container;
  note: Text;
  timer: Graphics;
  highlight: Graphics;
  cards: Container;
  pills: Container;
  geom: { box: Point; plate: Point; origin: Point };
}

const fmt = formatDD;

function label(size: number, color: number, weight: "400" | "500" | "600" | "700" = "500") {
  const t = new Text({ text: "", style: { fontFamily: FONT, fontSize: size, fill: color, fontWeight: weight } });
  t.anchor.set(0.5);
  return t;
}

const total = (cards: PlayingCard[]) => {
  let sum = 0;
  let aces = 0;
  for (const { rank } of cards) {
    if (rank === "A") {
      aces += 1;
      sum += 1;
    } else sum += rank === "J" || rank === "Q" || rank === "K" ? 10 : Number(rank);
  }
  return aces > 0 && sum + 10 <= 21 ? sum + 10 : sum;
};

/**
 * Imperative Pixi scene for one blackjack table: half-moon felt, dealer on top with the shoe (right)
 * and discard tray (left), 7 betting boxes along the arc. Plays each server message's events as a
 * gsap timeline against a local model, then snaps to the authoritative view.
 */
export class BlackjackRenderer {
  private readonly root = new Container();
  private readonly felt = new Graphics();
  private readonly shoeGfx = new Graphics();
  private readonly trayGfx = new Graphics();
  private readonly dealerCards: Sprite[] = [];
  private readonly dealerPill = new Container();
  private readonly dealerPillBg = new Graphics();
  private readonly dealerPillText = label(14, TEXT, "700");
  private readonly message = label(22, GOLD, "600");
  private readonly spotsLayer = new Container();
  private readonly cardsLayer = new Container();
  private readonly fx = new Container();
  /** Hand totals/results sit above every card so a neighbour's cards never cover them. */
  private readonly pillsLayer = new Container();
  private readonly nodes: SpotNode[] = [];

  private view: BlackjackTableView | null = null;
  /** level / tray: shoe and discard-tray fill (fractions of the shoe, quarter-deck precision from the server). */
  private model: { spots: LocalSpot[]; dealer: (PlayingCard | null)[]; level: number; tray: number } = {
    spots: Array.from({ length: BJ_SPOTS }, () => ({ bet: 0, hands: [] })),
    dealer: [],
    level: 1,
    tray: 0,
  };
  private queue: ReceivedBlackjack[] = [];
  private current: gsap.core.Timeline | null = null;
  private clock: { spot: number; endsAt: number; total: number } | null = null;
  private thinkingSpot: number | null = null;
  private selected: number | null = null;
  /** Short-lived per-spot action text ("Hit", "Double $50"), cleared at the next round. */
  private notes: string[] = Array(BJ_SPOTS).fill("");

  constructor(
    private readonly app: Application,
    private readonly tex: PokerTextures,
    private readonly onSpotClick: (spot: number) => void,
  ) {
    this.drawFelt();
    for (let i = 0; i < 12; i += 1) {
      const card = this.makeCard(DEALER_W, DEALER_H);
      this.dealerCards.push(card);
      this.cardsLayer.addChild(card);
    }
    this.dealerPill.addChild(this.dealerPillBg, this.dealerPillText);
    this.dealerPill.position.set(CX, DEALER_Y + DEALER_H / 2 + 22);
    this.dealerPill.visible = false;
    this.message.position.set(CX, 208);
    this.message.style.letterSpacing = 3;

    for (let spot = 0; spot < BJ_SPOTS; spot += 1) this.nodes.push(this.makeSpot(spot));

    this.root.addChild(this.felt, this.shoeGfx, this.trayGfx, this.spotsLayer, this.cardsLayer, this.pillsLayer, this.dealerPill, this.message, this.fx);
    this.app.stage.addChild(this.root);
    this.app.renderer.on("resize", this.fit);
    this.app.ticker.add(this.tick);
    this.fit(this.app.screen.width, this.app.screen.height);
    this.drawShoe();
  }

  destroy() {
    this.current?.kill();
    this.app.ticker.remove(this.tick);
    this.app.renderer.off("resize", this.fit);
    this.root.destroy({ children: true });
  }

  /** The spot picked in the sidebar for betting (outlined in gold). */
  setSelected(spot: number | null) {
    this.selected = spot;
    if (this.view) this.drawBoxes(this.view);
  }

  push(received: ReceivedBlackjack) {
    const { view } = received.message;
    const acting = view.toAct ? view.spots[view.toAct.spot] : null;
    this.clock =
      view.toAct && view.turnRemainingMs !== null
        ? { spot: view.toAct.spot, endsAt: received.receivedAt + view.turnRemainingMs, total: Math.max(view.turnRemainingMs, 20_000) }
        : null;
    this.thinkingSpot = acting?.kind === "bot" ? acting.spot : null;
    this.queue.push(received);
    if (this.current) {
      if (this.queue.length > 3) this.current.progress(1, false);
      else this.current.timeScale(1 + this.queue.length);
    }
    this.pump();
  }

  private pump(): void {
    if (this.current) return;
    const next = this.queue.shift();
    if (!next) return;
    const { view, events } = next.message;
    if (events.length === 0 || !this.view) {
      this.sync(view);
      return this.pump();
    }
    const timeline = this.animate(events, view);
    timeline.timeScale(1 + this.queue.length);
    this.current = timeline;
    timeline.eventCallback("onComplete", () => {
      this.current = null;
      this.sync(view);
      this.pump();
    });
  }

  // ---------- animation ----------

  private animate(events: BlackjackEvent[], view: BlackjackTableView): gsap.core.Timeline {
    const tl = gsap.timeline();
    // A shadow of the model, advanced while the timeline is built so card positions are known up front.
    const shadow = this.model.spots.map((s) => s.hands.map((h) => h.cards.length));
    let dealerCount = this.model.dealer.length;

    for (const e of events) {
      switch (e.type) {
        case "roundStarted":
          tl.call(() => {
            this.notes.fill("");
            this.model.dealer = [];
            this.model.spots.forEach((s, i) => {
              s.hands = [];
              s.bet = e.bets.find((b) => b.spot === i)?.amount ?? 0;
            });
            this.showMessage("");
            this.renderAll(view);
          });
          for (let i = 0; i < BJ_SPOTS; i += 1) shadow[i] = e.bets.some((b) => b.spot === i) ? [0] : [];
          dealerCount = 0;
          break;

        case "cardDealt": {
          const card = e.card;
          if (e.target === "dealer") {
            const index = dealerCount++;
            const to = this.dealerCardPos(index, dealerCount);
            this.fly(tl, SHOE_MOUTH, to, card, DEALER_W, DEALER_H, () => {
              this.model.dealer.push(card);
              this.renderDealer();
              this.drawShoe();
            });
          } else {
            const { spot, hand } = e.target;
            const hands = shadow[spot]!;
            hands[hand] = (hands[hand] ?? 0) + 1;
            const to = this.cardPos(spot, hand, hands.length, hands[hand]! - 1);
            this.fly(tl, SHOE_MOUTH, to, card, CARD_W, CARD_H, () => {
              const local = this.model.spots[spot]!;
              while (local.hands.length <= hand) local.hands.push({ cards: [], doubled: false, result: null, total: null });
              if (card) local.hands[hand]!.cards.push(card);
              this.renderSpot(spot);
              this.drawShoe();
            });
          }
          break;
        }

        case "handSplit": {
          const hands = shadow[e.spot]!;
          hands[e.hand] = 1;
          hands.splice(e.hand + 1, 0, 1);
          tl.call(() => {
            const local = this.model.spots[e.spot]!;
            const moved = local.hands[e.hand]!.cards.pop();
            local.hands.splice(e.hand + 1, 0, { cards: moved ? [moved] : [], doubled: false, result: null, total: null });
            this.renderSpot(e.spot);
          });
          tl.to({}, { duration: 0.25 });
          break;
        }

        case "playerActed": {
          const text = describeBlackjackAction(e.action, e.amount);
          tl.call(() => this.setNote(e.spot, text));
          if (e.action === "double") {
            tl.call(() => {
              const hand = this.model.spots[e.spot]!.hands[e.hand];
              if (hand) hand.doubled = true;
            });
          }
          if (e.amount > 0) this.chipFly(tl, this.nodes[e.spot]!.geom.plate, this.nodes[e.spot]!.geom.box, 0.25);
          else tl.to({}, { duration: 0.15 });
          break;
        }

        case "insuranceOffered":
          tl.call(() => this.showMessage("Insurance?"));
          break;

        case "insuranceDecided":
          tl.call(() => this.setNote(e.spot, e.amount > 0 ? `Insured ${fmt(e.amount)}` : "No insurance"));
          break;

        case "dealerPeeked":
          tl.call(() => this.showMessage(e.blackjack ? "Dealer blackjack" : "Dealer checks · no blackjack"));
          tl.to({}, { duration: 0.6 });
          tl.call(() => !e.blackjack && this.showMessage(""));
          break;

        case "insuranceSettled":
          for (const r of e.results) {
            if (r.payout > 0) this.chipFly(tl, DEALER_CHIP, this.nodes[r.spot]!.geom.plate, 0.35);
          }
          break;

        case "holeRevealed": {
          const sprite = this.dealerCards[1]!;
          tl.call(() => {
            this.model.dealer[1] = e.card;
          });
          this.flip(tl, sprite, this.tex.card(e.card), DEALER_W);
          tl.call(() => this.renderDealer());
          break;
        }

        case "handSettled": {
          const node = this.nodes[e.spot]!;
          tl.call(() => {
            const hand = this.model.spots[e.spot]!.hands[e.hand];
            if (hand) hand.result = e.result;
            this.renderSpot(e.spot);
          });
          if (e.result === "lose") this.chipFly(tl, node.geom.box, DEALER_CHIP, 0.3);
          else if (e.payout > e.bet) this.chipFly(tl, DEALER_CHIP, node.geom.box, 0.3);
          if (e.payout > 0) {
            this.chipFly(tl, node.geom.box, node.geom.plate, 0.25);
            const won = e.payout - e.bet;
            const note =
              e.result === "blackjack" ? `Blackjack +${fmt(won)}` : won > 0 ? `+${fmt(won)}` : e.result === "push" ? "Push" : `${fmt(e.payout)} back`;
            tl.call(() => this.setNote(e.spot, note));
          } else {
            tl.call(() => this.setNote(e.spot, `-${fmt(e.bet)}`));
          }
          break;
        }

        case "roundEnded":
          tl.call(() => {
            this.model.spots.forEach((s) => (s.bet = 0));
            this.renderAll(view);
          });
          tl.to({}, { duration: 0.3 });
          break;

        case "tableCleared": {
          tl.call(() => this.showMessage(""));
          const sprites: Sprite[] = [];
          tl.call(() => {
            for (const node of this.nodes) for (const child of node.cards.children) if (child instanceof Sprite && child.visible) sprites.push(child);
            for (const sprite of this.dealerCards) if (sprite.visible) sprites.push(sprite);
            const flying = sprites.map((s) => {
              const copy = this.makeCard(CARD_W, CARD_H);
              copy.texture = s.texture;
              const at = this.fx.toLocal(s.getGlobalPosition());
              copy.position.set(at.x, at.y);
              copy.width = s.width;
              copy.height = s.height;
              copy.rotation = s.rotation;
              copy.visible = true;
              this.fx.addChild(copy);
              s.visible = false;
              return copy;
            });
            for (const node of this.nodes) node.pills.removeChildren().forEach((c) => c.destroy());
            this.dealerPill.visible = false;
            gsap.to(flying, {
              x: TRAY.x,
              y: TRAY.y,
              rotation: 0,
              duration: 0.35,
              stagger: 0.008,
              ease: "power2.in",
              onComplete: () => flying.forEach((f) => f.destroy()),
            });
          });
          tl.to({}, { duration: 0.5 });
          tl.call(() => {
            this.model.spots.forEach((s) => (s.hands = []));
            this.model.dealer = [];
            this.notes.fill("");
            this.renderAll(view);
            this.drawShoe();
          });
          break;
        }

        case "shuffled": {
          tl.call(() => this.showMessage("Shuffling"));
          const backs = Array.from({ length: 8 }, () => {
            const card = this.makeCard(TRAY.w - 10, 20);
            card.position.set(TRAY.x, TRAY.y);
            this.fx.addChild(card);
            return card;
          });
          tl.set(backs, { visible: true });
          tl.to(backs, { x: SHOE.x, y: SHOE.y, duration: 0.5, stagger: 0.06, ease: "power2.inOut" });
          tl.call(() => {
            backs.forEach((b) => b.destroy());
            this.model.level = 1;
            this.model.tray = 0;
            this.drawShoe();
          });
          tl.to({}, { duration: 0.4 });
          tl.call(() => this.showMessage(""));
          break;
        }
      }
    }
    return tl;
  }

  /** A card flies from `from` to `to` (face down for the hole card), then `onLand` updates the model. */
  private fly(tl: gsap.core.Timeline, from: Point, to: Point, card: PlayingCard | null, w: number, h: number, onLand: () => void) {
    const sprite = this.makeCard(w, h);
    sprite.texture = card ? this.tex.card(card) : this.tex.back;
    sprite.width = w;
    sprite.height = h;
    sprite.position.set(from.x, from.y);
    sprite.rotation = 0.4;
    this.fx.addChild(sprite);
    tl.set(sprite, { visible: true });
    tl.to(sprite, { x: to.x, y: to.y, rotation: 0, duration: 0.24, ease: "power2.out" });
    tl.call(() => {
      sprite.destroy();
      onLand();
    });
  }

  private chipFly(tl: gsap.core.Timeline, from: Point, to: Point, duration: number) {
    const chip = this.makeChip();
    chip.position.set(from.x, from.y);
    chip.visible = false;
    this.fx.addChild(chip);
    tl.set(chip, { visible: true });
    tl.to(chip, { x: to.x, y: to.y, duration, ease: "power2.inOut" });
    tl.call(() => chip.destroy());
  }

  private flip(tl: gsap.core.Timeline, sprite: Sprite, texture: Texture, width: number) {
    tl.to(sprite, { width: 0, duration: 0.14, ease: "power1.in" });
    tl.call(() => {
      sprite.texture = texture;
      sprite.width = 0;
      sprite.height = DEALER_H;
    });
    tl.to(sprite, { width, duration: 0.14, ease: "power1.out" });
  }

  // ---------- static state ----------

  /** Snap everything to the server's view. */
  private sync(view: BlackjackTableView) {
    this.view = view;
    this.model.spots = view.spots.map((s) => ({
      // Settled rounds have been paid out: no chips left in the box.
      bet: !s || view.stage === "settled" ? 0 : s.hands.length > 0 ? s.hands.reduce((sum, h) => sum + h.bet, 0) : s.bet,
      hands: s ? s.hands.map((h) => ({ cards: [...h.cards], doubled: h.doubled, result: h.result, total: h.total })) : [],
    }));
    this.model.dealer = [...view.dealer.cards];
    this.model.level = view.shoe.level;
    this.model.tray = view.shoe.tray;
    this.renderAll(view);
    this.drawShoe();
    this.showMessage(
      view.stage === "betting" ? "Place your bets" : view.stage === "insurance" ? "Insurance?" : "",
    );
  }

  private renderAll(view: BlackjackTableView) {
    this.view = view;
    this.drawBoxes(view);
    for (let spot = 0; spot < BJ_SPOTS; spot += 1) this.renderSpot(spot);
    this.renderDealer();
  }

  /** Boxes, chips, name plates: who sits where. */
  private drawBoxes(view: BlackjackTableView) {
    view.spots.forEach((s, i) => {
      const node = this.nodes[i]!;
      const mine = view.mySpots.includes(i);
      const selected = this.selected === i;
      const active = view.toAct?.spot === i;
      node.box
        .clear()
        .rect(-BOX / 2, -BOX / 2, BOX, BOX)
        .fill(s ? SURFACE : INK)
        .stroke({ width: selected || active ? 2 : 1, color: selected || mine || active ? GOLD : LINE });
      node.boxNumber.visible = !s || this.model.spots[i]!.bet === 0;
      node.plate.visible = s !== null;
      if (s) {
        node.name.text = s.name;
        node.badge.visible = s.kind === "bot";
        node.plateBg.clear().rect(-66, -20, 132, 40).fill(SURFACE).stroke({ width: active ? 2 : 1, color: active ? GOLD : LINE });
        node.plate.alpha = s.connected ? 1 : 0.6;
      }
      this.refreshChip(i);
    });
  }

  private refreshChip(spot: number) {
    const node = this.nodes[spot]!;
    const bet = this.model.spots[spot]!.bet;
    node.chip.visible = bet > 0;
    node.chipText.visible = bet > 0;
    node.chipText.text = fmt(bet);
    node.boxNumber.visible = bet === 0;
  }

  private renderSpot(spot: number) {
    const node = this.nodes[spot]!;
    const local = this.model.spots[spot]!;
    const hands = local.hands;
    const sprites = node.cards.children as Sprite[];
    let used = 0;
    node.pills.removeChildren().forEach((c) => c.destroy());
    hands.forEach((hand, h) => {
      hand.cards.forEach((card, k) => {
        let sprite = sprites[used];
        if (!sprite) {
          sprite = this.makeCard(CARD_W, CARD_H);
          node.cards.addChild(sprite);
        }
        used += 1;
        const pos = this.cardPos(spot, h, hands.length, k);
        sprite.texture = this.tex.card(card);
        sprite.width = CARD_W;
        sprite.height = CARD_H;
        sprite.position.set(pos.x, pos.y);
        sprite.rotation = hand.doubled && k === 2 ? Math.PI / 2 : 0;
        sprite.visible = true;
        sprite.alpha = 1;
      });
      if (hand.cards.length > 0) node.pills.addChild(this.handPill(spot, h, hands.length, hand));
    });
    for (let i = used; i < sprites.length; i += 1) sprites[i]!.visible = false;

    const view = this.view;
    const ref = view?.toAct;
    node.highlight.clear();
    if (ref && ref.spot === spot && hands[ref.hand]) {
      const count = hands[ref.hand]!.cards.length;
      const first = this.cardPos(spot, ref.hand, hands.length, 0);
      const last = this.cardPos(spot, ref.hand, hands.length, Math.max(0, count - 1));
      const pad = 6;
      node.highlight
        .rect(first.x - CARD_W / 2 - pad, last.y - CARD_H / 2 - pad, last.x - first.x + CARD_W + pad * 2, first.y - last.y + CARD_H + pad * 2)
        .stroke({ width: 2, color: GOLD });
    }
    this.refreshChip(spot);
  }

  /** "18", "Soft 17", "BJ", plus the result once settled, in a flat pill under the hand. */
  private handPill(spot: number, h: number, count: number, hand: LocalHand): Container {
    const value = total(hand.cards);
    const natural = hand.cards.length === 2 && value === 21 && count === 1;
    const result = hand.result;
    const text = [natural ? "BJ" : String(value), result ? BJ_RESULT_LABEL[result] : value > 21 ? "Bust" : null]
      .filter(Boolean)
      .join(" · ")
      .toUpperCase();
    const color = result === "win" || result === "blackjack" ? GOLD : result === "lose" || value > 21 ? DANGER : LINE;
    const t = label(12, result === "win" || result === "blackjack" ? GOLD : TEXT, "700");
    t.text = text;
    const w = t.width + 14;
    const pill = new Container();
    pill.addChild(new Graphics().rect(-w / 2, -10, w, 20).fill({ color: INK, alpha: 0.95 }).stroke({ width: 1, color }), t);
    const base = this.cardPos(spot, h, count, 0);
    pill.position.set(base.x, base.y + CARD_H / 2 + 14);
    return pill;
  }

  private renderDealer() {
    const cards = this.model.dealer;
    this.dealerCards.forEach((sprite, i) => {
      const card = cards[i];
      if (card === undefined) {
        sprite.visible = false;
        return;
      }
      const pos = this.dealerCardPos(i, cards.length);
      sprite.texture = card ? this.tex.card(card) : this.tex.back;
      sprite.width = DEALER_W;
      sprite.height = DEALER_H;
      sprite.position.set(pos.x, pos.y);
      sprite.visible = true;
    });
    const faceUp = cards.filter((c): c is PlayingCard => c !== null);
    this.dealerPill.visible = faceUp.length > 0;
    if (faceUp.length > 0) {
      const value = total(faceUp);
      const hidden = cards.some((c) => c === null);
      this.dealerPillText.text = (cards.length === 2 && value === 21 && !hidden ? "Blackjack" : value > 21 ? `${value} · Bust` : `${value}${hidden ? " showing" : ""}`).toUpperCase();
      const w = this.dealerPillText.width + 16;
      this.dealerPillBg.clear().rect(-w / 2, -11, w, 22).fill(INK).stroke({ width: 1, color: value > 21 ? DANGER : LINE });
    }
  }

  private setNote(spot: number, text: string) {
    this.notes[spot] = text;
  }

  private showMessage(text: string) {
    this.message.text = text.toUpperCase();
  }

  /** Shoe (right) and discard tray (left): flat stacks whose height tracks the card counts. */
  private drawShoe() {
    const { level, tray } = this.model;
    const stack = (g: Graphics, box: typeof SHOE, fraction: number, edge: number) => {
      const inner = box.h - 8;
      const h = Math.round(inner * Math.max(0, Math.min(1, fraction)));
      g.clear()
        .rect(box.x - box.w / 2, box.y - box.h / 2, box.w, box.h)
        .fill(INK)
        .stroke({ width: 1, color: edge });
      if (h > 0) {
        g.rect(box.x - box.w / 2 + 6, box.y + box.h / 2 - 4 - h, box.w - 12, h).fill(PAPER);
        // Faint card edges every few pixels.
        for (let y = box.y + box.h / 2 - 4 - 3; y > box.y + box.h / 2 - 4 - h; y -= 3) {
          g.rect(box.x - box.w / 2 + 6, y, box.w - 12, 1).fill({ color: 0x9a9a9a });
        }
      }
    };
    stack(this.shoeGfx, SHOE, level, GOLD_DIM);
    stack(this.trayGfx, TRAY, tray, LINE);
  }

  private tick = () => {
    const now = performance.now();
    this.nodes.forEach((node, spot) => {
      node.timer.clear();
      const s = this.view?.spots[spot];
      if (!s) {
        node.note.text = "";
        return;
      }
      if (this.thinkingSpot === spot) {
        node.note.text = `thinking${".".repeat(1 + (Math.floor(now / 400) % 3))}`;
        node.note.style.fill = MUTED;
        return;
      }
      if (this.clock && this.clock.spot === spot) {
        const remaining = Math.max(0, this.clock.endsAt - now);
        const fraction = Math.min(1, remaining / this.clock.total);
        const color = fraction > 0.25 ? GOLD : DANGER;
        node.timer.rect(-66, 20, 132 * fraction, 3).fill(color);
        node.note.text = `${Math.ceil(remaining / 1000)}s`;
        node.note.style.fill = color;
        return;
      }
      const status = !s.connected ? "AWAY" : s.leaving ? "LAST ROUND" : s.ready === true ? "✓ READY" : "";
      node.note.text = this.notes[spot] || status;
      node.note.style.fill = !s.connected || s.leaving ? DANGER : /^(\+|Blackjack)/.test(this.notes[spot] ?? "") || s.ready ? GOLD : TEXT;
    });
  };

  // ---------- geometry ----------

  private fit = (width: number, height: number) => {
    const scale = Math.min(width / W, height / H);
    this.root.scale.set(scale);
    this.root.position.set((width - W * scale) / 2, (height - H * scale) / 2);
  };

  /** Spot 0 is first base: the dealer's left, i.e. the right side of the screen. */
  private spotGeometry(spot: number) {
    const angle = ((20 + (spot * 140) / (BJ_SPOTS - 1)) * Math.PI) / 180;
    const box = { x: CX + 480 * Math.cos(angle), y: TOP + 480 * Math.sin(angle) };
    const dx = CX - box.x;
    const dy = TOP - box.y;
    const len = Math.hypot(dx, dy) || 1;
    const origin = { x: box.x + (dx / len) * 112, y: box.y + (dy / len) * 112 };
    return { box, plate: { x: box.x, y: box.y + BOX / 2 + 30 }, origin };
  }

  private cardPos(spot: number, hand: number, hands: number, index: number): Point {
    const { origin } = this.nodes[spot]!.geom;
    const spacing = hands > 2 ? 52 : 64;
    const x = origin.x + (hand - (hands - 1) / 2) * spacing;
    return { x: x + index * CASCADE.x, y: origin.y + index * CASCADE.y };
  }

  private dealerCardPos(index: number, count: number): Point {
    const step = DEALER_W * 0.62;
    return { x: CX + (index - (Math.max(count, 2) - 1) / 2) * step, y: DEALER_Y };
  }

  private drawFelt() {
    // Half-moon: straight edge at the dealer, gold rail around the players' arc. Flat, no shadows.
    const g = this.felt;
    g.moveTo(CX - 590, TOP)
      .lineTo(CX + 590, TOP)
      .arc(CX, TOP, 590, 0, Math.PI)
      .closePath()
      .fill(INK)
      .stroke({ width: 2, color: GOLD });
    g.moveTo(CX - 566, TOP).arc(CX, TOP, 566, Math.PI, 0, true).stroke({ width: 1, color: GOLD, alpha: 0.5 });
    // The felt print: an arc of rules text between the dealer and the spots.
    g.moveTo(CX + 300 * Math.cos(Math.PI / 7), TOP + 300 * Math.sin(Math.PI / 7)).arc(CX, TOP, 300, Math.PI / 7, (6 * Math.PI) / 7).stroke({ width: 1, color: 0x262626 });
    const pays = label(20, GOLD_DIM, "600");
    pays.text = "BLACKJACK PAYS 3 TO 2";
    pays.style.letterSpacing = 4;
    pays.position.set(CX, 248);
    const rules = label(12, MUTED, "500");
    rules.text = "DEALER STANDS ON ALL 17S   ·   INSURANCE PAYS 2 TO 1";
    rules.style.letterSpacing = 2;
    rules.position.set(CX, 274);
    const shoe = label(10, MUTED, "600");
    shoe.text = "SHOE";
    shoe.style.letterSpacing = 2;
    shoe.position.set(SHOE.x, SHOE.y + SHOE.h / 2 + 12);
    const tray = label(10, MUTED, "600");
    tray.text = "DISCARDS";
    tray.style.letterSpacing = 2;
    tray.position.set(TRAY.x, TRAY.y + TRAY.h / 2 + 12);
    const dealer = label(11, MUTED, "600");
    dealer.text = "DEALER";
    dealer.style.letterSpacing = 3;
    dealer.position.set(CX, 42);
    this.root.addChild(pays, rules, shoe, tray, dealer);
  }

  private makeSpot(spot: number): SpotNode {
    const geom = this.spotGeometry(spot);
    const box = new Graphics();
    box.position.copyFrom(geom.box);
    box.eventMode = "static";
    box.cursor = "pointer";
    box.hitArea = new Rectangle(-BOX / 2, -BOX / 2, BOX, BOX);
    box.on("pointertap", () => this.onSpotClick(spot));
    const boxNumber = label(22, 0x3a3a3a, "600");
    boxNumber.text = String(spot + 1);
    boxNumber.position.copyFrom(geom.box);
    const chip = this.makeChip();
    chip.position.set(geom.box.x, geom.box.y - 8);
    chip.visible = false;
    const chipText = label(13, TEXT, "700");
    chipText.position.set(geom.box.x, geom.box.y + 18);
    chipText.visible = false;

    const plate = new Container();
    plate.position.copyFrom(geom.plate);
    const plateBg = new Graphics();
    const name = label(14, TEXT, "700");
    const badgeText = label(9, 0xcfcfcf, "600");
    badgeText.text = "BOT";
    const badge = new Container();
    badge.addChild(new Graphics().rect(-15, -8, 30, 16).fill(INK).stroke({ width: 1, color: MUTED }), badgeText);
    badge.position.set(58, -22);
    badge.visible = false;
    const timer = new Graphics();
    const note = label(14, TEXT, "700");
    note.position.set(0, 38);
    plate.addChild(plateBg, timer, name, badge, note);
    plate.visible = false;

    const highlight = new Graphics();
    const cards = new Container();
    const pills = new Container();
    this.spotsLayer.addChild(box, boxNumber, chip, chipText, plate);
    this.cardsLayer.addChild(highlight, cards);
    this.pillsLayer.addChild(pills);
    return { box, boxNumber, chip, chipText, plate, plateBg, name, badge, note, timer, highlight, cards, pills, geom };
  }

  private makeCard(width: number, height: number): Sprite {
    const sprite = new Sprite(this.tex.back);
    sprite.anchor.set(0.5);
    sprite.width = width;
    sprite.height = height;
    sprite.visible = false;
    return sprite;
  }

  private makeChip(): Sprite {
    const chip = new Sprite(this.tex.chip);
    chip.anchor.set(0.5);
    chip.width = 26;
    chip.height = 26;
    return chip;
  }
}

/** Cards leave the shoe from its lower-left corner; chips go to / come from the dealer's tray. */
const SHOE_MOUTH = { x: SHOE.x - SHOE.w / 2, y: SHOE.y + SHOE.h / 2 };
const DEALER_CHIP = { x: CX, y: DEALER_Y + 80 };
