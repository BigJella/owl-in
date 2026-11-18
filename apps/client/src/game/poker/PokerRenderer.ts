import { gsap } from "gsap";
import { Container, Graphics, Sprite, Text, type Application, type Texture } from "pixi.js";
import { formatDD, describeAction, type PlayingCard, type PokerEvent, type PokerTableView, type Pot } from "@owl-in/shared";
import type { ReceivedMessage } from "../../networking/pokerStore";
import type { PokerTextures } from "./assets";

// Everything is laid out in a fixed design space and scaled to fit the canvas.
const W = 1200;
const H = 720;
const CX = W / 2;
const CY = 330;
const SEATS = 8;
const CARD_W = 52;
const CARD_H = 74;
const BOARD_W = 66;
const BOARD_H = 94;
/** Where dealt cards fly from: the top edge of the table, clear of the stage label. */
const DECK = { x: CX, y: CY - 215 };
/** Board row sits just below centre; the pot sits above it (or dead centre before any board cards). */
const BOARD_Y = CY + 30;
const POT_Y_BOARD = CY - 62;
const POT_Y_EMPTY = CY;
const SIDE_POT_GAP = 26;
const FONT = '"Oswald", "Inter", system-ui, sans-serif';
/** KSU gold (Pantone 1235 C). */
const GOLD = 0xffb81c;
const INK = 0x0a0a0a;
const SURFACE = 0x141414;
const LINE = 0x2e2e2e;
const TEXT = 0xf2f2f2;
const MUTED = 0x8a8a8a;
const DANGER = 0xe0393e;

interface Point {
  x: number;
  y: number;
}

interface SeatGeometry {
  plate: Point;
  cards: [Point, Point];
  bet: Point;
  button: Point;
}

interface SeatNode {
  root: Container;
  plate: Graphics;
  timer: Graphics;
  name: Text;
  stack: Text;
  badge: Container;
  status: Text;
  action: Text;
  inPot: Text;
  clock: Text;
  role: Container;
  roleText: Text;
  /** Showdown hand name ("Two Pair, K's & 8's"), on its own layer above every card. */
  hand: Container;
  handText: Text;
  handBg: Graphics;
  cards: [Sprite, Sprite];
  betChip: Sprite;
  betText: Text;
  geom: SeatGeometry;
}

const fmt = formatDD;

function label(size: number, color: number, weight: "400" | "500" | "600" | "700" = "500") {
  const t = new Text({ text: "", style: { fontFamily: FONT, fontSize: size, fill: color, fontWeight: weight } });
  t.anchor.set(0.5);
  return t;
}

/**
 * Imperative Pixi scene for one poker table. React hands it every server message;
 * it animates the message's events with gsap, then snaps to the authoritative view.
 */
export class PokerRenderer {
  private readonly root = new Container();
  private readonly felt = new Graphics();
  private readonly cardsLayer = new Container();
  private readonly betsLayer = new Container();
  private readonly seatsLayer = new Container();
  private readonly fx = new Container();
  private readonly seats: SeatNode[] = [];
  private readonly board: Sprite[] = [];
  private readonly potChip: Sprite;
  private readonly potText = label(18, 0xffffff, "700");
  private readonly sidePotText = label(13, 0xcfcfcf);
  /** Showdown hand names: drawn above all cards so nothing covers them. */
  private readonly handsLayer = new Container();
  private readonly dealerButton = new Container();

  private view: PokerTableView | null = null;
  /** mySeat + occupied seats the current layout was built for; relayout when it changes. */
  private layoutKey = "";
  /** Where chips fly to / the pot label sits. Moves with the board. */
  private potPos: Point = { x: CX, y: POT_Y_EMPTY };
  private stacks: number[] = Array(SEATS).fill(0);
  private bets: number[] = Array(SEATS).fill(0);
  private contributed: number[] = Array(SEATS).fill(0);
  private pots: Pot[] = [];
  private queue: ReceivedMessage[] = [];
  private current: gsap.core.Timeline | null = null;
  private clock: { seat: number; endsAt: number; total: number } | null = null;
  /** Bot currently "thinking" (bots have no clock). */
  private thinkingSeat: number | null = null;

  constructor(
    private readonly app: Application,
    private readonly tex: PokerTextures,
  ) {
    this.drawFelt();
    this.potChip = this.makeChip();
    this.potChip.position.set(this.potPos.x, this.potPos.y);
    this.potText.anchor.set(0, 0.5);
    this.potText.y = this.potPos.y;
    this.sidePotText.position.set(CX, this.potPos.y + SIDE_POT_GAP);
    this.potText.style.letterSpacing = 1;

    for (let i = 0; i < 5; i += 1) {
      const card = this.makeCard(BOARD_W, BOARD_H);
      card.position.set(CX + (i - 2) * (BOARD_W + 8), BOARD_Y);
      this.board.push(card);
      this.cardsLayer.addChild(card);
    }

    const button = new Graphics().rect(-12, -12, 24, 24).fill(TEXT).stroke({ width: 2, color: GOLD });
    const d = label(14, INK, "700");
    d.text = "D";
    this.dealerButton.addChild(button, d);
    this.dealerButton.visible = false;

    for (let seat = 0; seat < SEATS; seat += 1) this.seats.push(this.makeSeat());

    this.root.addChild(
      this.felt,
      this.potChip,
      this.potText,
      this.sidePotText,
      this.betsLayer,
      this.cardsLayer,
      this.dealerButton,
      this.seatsLayer,
      this.fx,
      this.handsLayer,
    );
    this.app.stage.addChild(this.root);
    this.layoutSeats(null, this.seats.map((_, i) => i));
    this.app.renderer.on("resize", this.fit);
    this.app.ticker.add(this.tick);
    this.fit(this.app.screen.width, this.app.screen.height);
    this.setPots([]);
  }

  destroy() {
    this.current?.kill();
    this.app.ticker.remove(this.tick);
    this.app.renderer.off("resize", this.fit);
    gsap.killTweensOf(this.seats.map((s) => s.action.scale));
    this.root.destroy({ children: true });
  }

  /** Queue a server message. If we fall behind, the running animation fast-forwards. */
  push(received: ReceivedMessage) {
    const { view } = received.message;
    this.clock =
      view.toAct !== null && view.turnRemainingMs !== null
        ? { seat: view.toAct, endsAt: received.receivedAt + view.turnRemainingMs, total: Math.max(view.turnRemainingMs, 20_000) }
        : null;
    const acting = view.toAct === null ? null : view.seats[view.toAct];
    this.thinkingSeat = acting?.kind === "bot" && view.phase !== "idle" ? acting.seat : null;

    this.queue.push(received);
    // Falling behind: play faster rather than skipping; only jump to the end if far behind.
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
    // Seats only change between hands, so relayout here, before this message's animation is built
    // (its tweens read seat positions when they're created).
    const occupied = view.seats.flatMap((s, i) => (s ? [i] : []));
    const key = `${view.mySeat}|${occupied.join(",")}`;
    if (key !== this.layoutKey) {
      this.layoutKey = key;
      this.layoutSeats(view.mySeat, occupied);
    }
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

  private animate(events: PokerEvent[], view: PokerTableView): gsap.core.Timeline {
    const tl = gsap.timeline();
    const g = (seat: number) => this.seats[seat]!.geom;

    for (const e of events) {
      switch (e.type) {
        case "handStarted":
          tl.call(() => {
            this.resetHand();
            this.syncIdentity(view); // seats may have changed hands in the gap (a human replacing a bot)
            this.setRoles(e.smallBlindSeat, e.bigBlindSeat);
          });
          tl.call(() => {
            this.dealerButton.visible = true;
          });
          tl.to(this.dealerButton, { x: g(e.button).button.x, y: g(e.button).button.y, duration: 0.35, ease: "power2.out" });
          break;

        case "blindPosted":
          this.chipMove(tl, g(e.seat).plate, g(e.seat).bet, () => {
            this.bets[e.seat] = e.amount;
            this.contributed[e.seat] = e.amount;
            this.stacks[e.seat] = e.stack;
            this.refreshChips(e.seat);
          });
          break;

        case "holeCardsDealt":
          for (const round of [0, 1] as const) {
            for (const seat of e.seats) this.dealHole(tl, seat, round);
          }
          if (view.mySeat !== null && e.seats.includes(view.mySeat) && view.myHoleCards.length === 2) {
            const node = this.seats[view.mySeat]!;
            view.myHoleCards.forEach((card, i) => this.flip(tl, node.cards[i as 0 | 1], this.tex.card(card), i === 0 ? ">" : "<"));
          }
          break;

        case "playerActed": {
          const text = describeAction(e);
          tl.call(() => this.showAction(e.seat, text));
          if (e.amount > 0) {
            this.chipMove(tl, g(e.seat).plate, g(e.seat).bet, () => {
              this.bets[e.seat] = e.bet;
              this.contributed[e.seat] = this.contributed[e.seat]! + e.amount;
              this.stacks[e.seat] = e.stack;
              this.refreshChips(e.seat);
            });
          } else if (e.action === "fold") {
            tl.to(this.seats[e.seat]!.cards, { alpha: 0.25, duration: 0.25 });
          } else {
            tl.to({}, { duration: 0.2 });
          }
          break;
        }

        case "uncalledReturned":
          this.chipMove(tl, g(e.seat).bet, g(e.seat).plate, () => {
            this.bets[e.seat] = Math.max(0, this.bets[e.seat]! - e.amount);
            this.contributed[e.seat] = Math.max(0, this.contributed[e.seat]! - e.amount);
            this.stacks[e.seat] = this.stacks[e.seat]! + e.amount;
            this.refreshChips(e.seat);
          });
          break;

        case "betsCollected": {
          const moving = this.bets.flatMap((_, seat) => (this.seats[seat]!.betChip.visible || this.bets[seat]! > 0 ? [seat] : []));
          const chips = moving.map((seat) => {
            const chip = this.makeChip();
            chip.position.set(g(seat).bet.x, g(seat).bet.y);
            chip.visible = false;
            this.fx.addChild(chip);
            return chip;
          });
          tl.call(() => {
            for (const chip of chips) chip.visible = true;
            for (const seat of moving) {
              this.bets[seat] = 0;
              this.refreshChips(seat);
            }
          });
          if (chips.length) tl.to(chips, { x: this.potPos.x, y: this.potPos.y, duration: 0.35, ease: "power2.in", stagger: 0.03 });
          tl.call(() => {
            for (const chip of chips) chip.destroy();
            this.setPots(e.pots);
          });
          break;
        }

        case "communityDealt": {
          const start = { preflop: 0, flop: 0, turn: 3, river: 4 }[e.street];
          tl.call(() => this.placePot(true, true));
          tl.call(() => {
            for (const node of this.seats) {
              if (node.action.text !== "Fold" && !node.action.text.startsWith("All-in")) node.action.text = "";
            }
          });
          e.cards.forEach((card, i) => this.dealBoard(tl, start + i, card, i === 0 ? "+=0.1" : "-=0.12"));
          break;
        }

        case "showdown":
          for (const reveal of e.reveals) {
            const node = this.seats[reveal.seat]!;
            if (reveal.seat !== view.mySeat) {
              reveal.cards.forEach((card, i) => this.flip(tl, node.cards[i as 0 | 1], this.tex.card(card), "<"));
            }
            tl.call(() => {
              this.setHandLabel(node, reveal.handName);
              node.cards.forEach((c) => (c.alpha = 1));
            });
          }
          tl.to({}, { duration: 0.6 });
          break;

        case "potAwarded":
          for (const winner of e.winners) {
            this.chipMove(
              tl,
              this.potPos,
              g(winner.seat).plate,
              () => {
                this.stacks[winner.seat] = this.stacks[winner.seat]! + winner.amount;
                this.refreshChips(winner.seat);
                this.showAction(winner.seat, `Wins ${fmt(winner.amount)}`);
              },
              0.5,
            );
          }
          tl.call(() => this.setPots([]));
          break;

        case "handEnded":
          tl.to({}, { duration: 0.3 });
          break;
      }
    }
    return tl;
  }

  private chipMove(tl: gsap.core.Timeline, from: Point, to: Point, onLand: () => void, duration = 0.3) {
    const chip = this.makeChip();
    chip.position.set(from.x, from.y);
    chip.visible = false;
    this.fx.addChild(chip);
    tl.set(chip, { visible: true });
    tl.to(chip, { x: to.x, y: to.y, duration, ease: "power2.inOut" });
    tl.call(() => {
      chip.destroy();
      onLand();
    });
  }

  private dealHole(tl: gsap.core.Timeline, seat: number, round: 0 | 1) {
    const node = this.seats[seat]!;
    const target = node.cards[round];
    const fly = this.makeCard(CARD_W, CARD_H);
    fly.position.set(DECK.x, DECK.y);
    fly.rotation = -0.5;
    this.fx.addChild(fly);
    tl.set(fly, { visible: true }, "-=0.1");
    tl.to(fly, { x: target.x, y: target.y, rotation: target.rotation, duration: 0.22, ease: "power2.out" }, "<");
    tl.call(() => {
      fly.destroy();
      target.texture = this.tex.back;
      target.alpha = 1;
      target.visible = true;
    });
  }

  private dealBoard(tl: gsap.core.Timeline, index: number, card: PlayingCard, position: string) {
    const target = this.board[index]!;
    const fly = this.makeCard(BOARD_W, BOARD_H);
    fly.position.set(DECK.x, DECK.y);
    this.fx.addChild(fly);
    tl.set(fly, { visible: true }, position);
    tl.to(fly, { x: target.x, y: target.y, duration: 0.25, ease: "power2.out" });
    tl.call(() => {
      fly.destroy();
      target.texture = this.tex.back;
      target.visible = true;
    });
    this.flip(tl, target, this.tex.card(card), ">");
  }

  /** Squash horizontally, swap texture, expand again. */
  private flip(tl: gsap.core.Timeline, sprite: Sprite, texture: Texture, position: string) {
    let base = 1;
    tl.call(
      () => {
        base = Math.abs(sprite.scale.x) || base;
        sprite.visible = true;
      },
      undefined,
      position,
    );
    tl.to(sprite.scale, { x: 0, duration: 0.12, ease: "power1.in" });
    tl.call(() => {
      sprite.texture = texture;
    });
    tl.to(sprite.scale, { x: () => base, duration: 0.12, ease: "power1.out" });
  }

  private showAction(seat: number, text: string) {
    const action = this.seats[seat]!.action;
    gsap.killTweensOf(action.scale);
    action.text = text;
    gsap.fromTo(action.scale, { x: 1.3, y: 1.3 }, { x: 1, y: 1, duration: 0.25, ease: "back.out" });
  }

  // ---------- static state ----------

  /** Snap every element to the server's view. */
  private sync(view: PokerTableView) {
    this.view = view;

    view.seats.forEach((s, i) => {
      const node = this.seats[i]!;
      const parts = [node.root, node.cards[0], node.cards[1], node.betChip, node.betText];
      if (!s) {
        for (const part of parts) part.visible = false;
        return;
      }
      node.root.visible = true;
      node.name.text = s.name;
      node.badge.visible = s.kind === "bot";
      this.stacks[i] = s.stack;
      this.bets[i] = s.bet;
      this.contributed[i] = s.contributed;
      this.refreshChips(i);
      node.action.text = s.lastAction ?? "";
      node.roleText.text = s.blind ?? "";
      node.role.visible = s.blind !== null;
      node.status.text = !s.connected
        ? "AWAY"
        : s.cashingOut
          ? "LAST HAND"
        : s.rebuying
          ? "BUSTED"
          : s.ready === true
          ? "✓ READY"
          : s.ready === false
            ? "NOT READY"
            : s.leaving
          ? "LEAVING"
          : s.status === "waiting"
            ? "NEXT HAND"
            : ""; // all-in already shows in the action label
      node.status.style.fill = s.cashingOut || !s.connected ? DANGER : s.ready === true ? GOLD : MUTED;
      node.status.style.fontSize = s.cashingOut ? 12 : 10;
      node.root.alpha = s.status === "waiting" ? 0.55 : s.status === "folded" ? 0.7 : 1;
      this.drawPlate(node, view.toAct === i);

      const mine = i === view.mySeat && view.myHoleCards.length === 2 ? view.myHoleCards : null;
      const faces = s.revealedCards ?? mine;
      const show = s.revealedCards !== null || s.hasCards || (mine !== null && view.phase !== "idle");
      node.cards.forEach((sprite, k) => {
        sprite.texture = faces ? this.tex.card(faces[k]!) : this.tex.back;
        sprite.width = CARD_W;
        sprite.height = CARD_H;
        sprite.visible = show;
        sprite.alpha = s.status === "folded" ? 0.3 : 1;
      });
      this.setHandLabel(node, s.revealedHand ?? "");
    });

    this.board.forEach((sprite, i) => {
      const card = view.community[i];
      sprite.visible = card !== undefined;
      if (card) sprite.texture = this.tex.card(card);
      sprite.width = BOARD_W;
      sprite.height = BOARD_H;
    });

    this.placePot(view.community.length > 0);
    this.setPots(view.pots);
    const buttonSeat = view.seats[view.button] ? view.button : null;
    this.dealerButton.visible = view.handId > 0 && buttonSeat !== null;
    if (buttonSeat !== null) this.dealerButton.position.copyFrom(this.seats[buttonSeat]!.geom.button);
  }

  /** Pot sits at the table's centre, or above the board once community cards are out. */
  private placePot(hasBoard: boolean, animate = false) {
    const y = hasBoard ? POT_Y_BOARD : POT_Y_EMPTY;
    if (y === this.potPos.y) return;
    this.potPos = { x: CX, y };
    const move = (target: { y: number }, to: number) =>
      animate ? gsap.to(target, { y: to, duration: 0.3, ease: "power2.out" }) : (target.y = to);
    move(this.potChip, y);
    move(this.potText, y);
    move(this.sidePotText, y + SIDE_POT_GAP);
  }

  /** Who sits where (names, bot badges, which plates exist), without touching cards or chips. */
  private syncIdentity(view: PokerTableView) {
    view.seats.forEach((s, i) => {
      const node = this.seats[i]!;
      node.root.visible = s !== null;
      if (!s) return;
      node.name.text = s.name;
      node.badge.visible = s.kind === "bot";
      node.root.alpha = 1;
    });
  }

  /** Hand name in a dark pill so it stays readable over cards and felt. */
  private setHandLabel(node: SeatNode, text: string) {
    node.handText.text = text;
    node.hand.visible = text !== "";
    if (!text) return;
    const w = node.handText.width + 16;
    const h = node.handText.height + 6;
    node.handBg.clear().rect(-w / 2, -h / 2, w, h).fill({ color: INK, alpha: 0.94 }).stroke({ width: 1, color: GOLD });
  }

  private resetHand() {
    for (const node of this.seats) {
      for (const card of node.cards) {
        card.visible = false;
        card.alpha = 1;
      }
      this.setHandLabel(node, "");
      node.action.text = "";
      node.role.visible = false;
    }
    this.contributed.fill(0);
    this.seats.forEach((_, seat) => this.refreshChips(seat));
    for (const card of this.board) card.visible = false;
    this.placePot(false);
    this.setPots([]);
  }

  private refreshChips(seat: number) {
    const node = this.seats[seat]!;
    node.stack.text = fmt(this.stacks[seat]!);
    const bet = this.bets[seat]!;
    node.betChip.visible = bet > 0;
    node.betText.visible = bet > 0;
    node.betText.text = fmt(bet);
    const inPot = this.contributed[seat]!;
    node.inPot.text = inPot > 0 ? `in pot ${fmt(inPot)}` : "";
    this.renderPot();
  }

  private setRoles(smallBlindSeat: number, bigBlindSeat: number) {
    this.seats.forEach((node, seat) => {
      const role = seat === smallBlindSeat ? "SB" : seat === bigBlindSeat ? "BB" : "";
      node.roleText.text = role;
      node.role.visible = role !== "";
    });
  }

  private setPots(pots: Pot[]) {
    this.pots = pots;
    this.renderPot();
  }

  /** Total in the middle (collected pots + live bets), with a main/side breakdown. */
  private renderPot() {
    const collected = this.pots.reduce((sum, p) => sum + p.amount, 0);
    const total = collected + this.bets.reduce((sum, b) => sum + b, 0);
    this.potChip.visible = total > 0;
    this.potText.text = total > 0 ? `POT ${fmt(total)}` : "";
    // Centre chip + label together as one unit on the table.
    const gap = 8;
    const width = 24 + gap + this.potText.width;
    this.potChip.x = this.potPos.x - width / 2 + 12;
    this.potText.x = this.potChip.x + 12 + gap;
    this.sidePotText.text =
      this.pots.length > 1
        ? this.pots.map((p, i) => (i === 0 ? `Main ${fmt(p.amount)}` : `Side ${i}: ${fmt(p.amount)}`)).join("   ·   ")
        : "";
  }

  private tick = () => {
    const now = performance.now();
    for (const [seat, node] of this.seats.entries()) {
      node.timer.clear();
      if (this.thinkingSeat === seat && node.root.visible) {
        node.clock.text = `thinking${".".repeat(1 + (Math.floor(now / 400) % 3))}`;
        node.clock.style.fill = MUTED;
        node.clock.style.fontSize = 15;
        node.status.visible = false;
        continue;
      }
      if (!this.clock || this.clock.seat !== seat || !node.root.visible) {
        node.clock.text = "";
        node.status.visible = true;
        continue;
      }
      node.status.visible = false;
      node.clock.style.fontSize = 20;
      const remaining = Math.max(0, this.clock.endsAt - now);
      const fraction = Math.min(1, remaining / this.clock.total);
      const color = fraction > 0.25 ? GOLD : DANGER;
      node.timer.rect(-75, 36, 150 * fraction, 4).fill(color);
      node.clock.text = `${Math.ceil(remaining / 1000)}s`;
      node.clock.style.fill = color;
    }
  };

  // ---------- construction / layout ----------

  private fit = (width: number, height: number) => {
    const scale = Math.min(width / W, height / H);
    this.root.scale.set(scale);
    this.root.position.set((width - W * scale) / 2, (height - H * scale) / 2);
  };

  private drawFelt() {
    // Black felt, a black rail edged in gold, and a faint inner betting line. Flat: no shadows.
    this.felt
      .ellipse(CX, CY, 476, 248)
      .fill(INK)
      .stroke({ width: 2, color: GOLD })
      .ellipse(CX, CY, 452, 224)
      .fill(0x121212)
      .stroke({ width: 1, color: GOLD, alpha: 0.55 })
      .ellipse(CX, CY, 372, 164)
      .stroke({ width: 1, color: 0x262626 });
  }

  /**
   * Spread the occupied seats evenly around the table, in seat (clockwise) order, with your own seat
   * at bottom-centre. Empty seats keep their last geometry; they're hidden anyway.
   */
  private layoutSeats(mySeat: number | null, occupied: number[]) {
    if (occupied.length === 0) return;
    const anchor = mySeat !== null && occupied.includes(mySeat) ? mySeat : occupied[0]!;
    const ordered = [...occupied].sort((a, b) => ((a - anchor + SEATS) % SEATS) - ((b - anchor + SEATS) % SEATS));
    ordered.forEach((seat, displayIndex) => {
      const node = this.seats[seat]!;
      const angle = Math.PI / 2 + (displayIndex * 2 * Math.PI) / ordered.length;
      const plate = { x: CX + 505 * Math.cos(angle), y: CY + 268 * Math.sin(angle) };
      const toward = (t: number, sideways = 0): Point => {
        const dx = CX - plate.x;
        const dy = CY - plate.y;
        const len = Math.hypot(dx, dy) || 1;
        return { x: plate.x + dx * t - (dy / len) * sideways, y: plate.y + dy * t + (dx / len) * sideways };
      };
      const cards = toward(0.3);
      // Clock/status/hand name go on whichever side of the plate the cards aren't: below for the bottom seats.
      const below = plate.y > CY + 60;
      node.clock.y = below ? 82 : -52;
      node.status.y = below ? 82 : -50;
      node.geom = {
        plate,
        cards: [
          { x: cards.x - CARD_W * 0.36, y: cards.y },
          { x: cards.x + CARD_W * 0.36, y: cards.y },
        ],
        bet: toward(0.6),
        button: toward(0.42, 48),
      };
      node.root.position.copyFrom(plate);

      node.cards[0].position.copyFrom(node.geom.cards[0]);
      node.cards[1].position.copyFrom(node.geom.cards[1]);
      node.cards[0].rotation = -0.08;
      node.cards[1].rotation = 0.08;
      node.betChip.position.copyFrom(node.geom.bet);
      node.betText.position.set(node.geom.bet.x + 16, node.geom.bet.y);
      node.betText.anchor.set(0, 0.5);
      node.hand.position.set(cards.x, below ? cards.y - CARD_H / 2 - 13 : cards.y + CARD_H / 2 + 13);
    });
  }

  private makeSeat(): SeatNode {
    const root = new Container();
    const plate = new Graphics();
    const timer = new Graphics();
    const name = label(14, 0xffffff, "700");
    name.position.set(0, -18);
    const stack = label(15, GOLD, "700");
    stack.position.set(0, 2);
    const inPot = label(11, MUTED, "500");
    inPot.position.set(0, 21);
    const badgeText = label(9, 0xcfcfcf, "600");
    badgeText.text = "BOT";
    const badge = new Container();
    badge.addChild(new Graphics().rect(-15, -8, 30, 16).fill(INK).stroke({ width: 1, color: MUTED }), badgeText);
    badge.position.set(62, -36);
    badge.visible = false;
    const status = label(10, MUTED, "600");
    status.position.set(0, -48);
    const action = label(14, 0xffffff, "700");
    action.position.set(0, 60);
    const clock = label(20, GOLD, "700");
    clock.position.set(0, -52);
    const roleText = label(10, 0x17191a, "700");
    const role = new Container();
    role.addChild(new Graphics().rect(-14, -8, 28, 16).fill(GOLD), roleText);
    role.position.set(-62, -36);
    role.visible = false;
    root.addChild(plate, timer, name, stack, inPot, badge, role, status, action, clock);

    const cards: [Sprite, Sprite] = [this.makeCard(CARD_W, CARD_H), this.makeCard(CARD_W, CARD_H)];
    this.cardsLayer.addChild(...cards);
    const handText = label(12, 0xffffff, "700");
    const handBg = new Graphics();
    const hand = new Container();
    hand.addChild(handBg, handText);
    hand.visible = false;
    this.handsLayer.addChild(hand);
    const betChip = this.makeChip();
    betChip.visible = false;
    const betText = label(13, 0xffffff, "700");
    betText.visible = false;
    this.betsLayer.addChild(betChip, betText);
    this.seatsLayer.addChild(root);
    root.visible = false;

    return {
      root,
      plate,
      timer,
      name,
      stack,
      badge,
      status,
      action,
      inPot,
      clock,
      role,
      roleText,
      hand,
      handText,
      handBg,
      cards,
      betChip,
      betText,
      geom: { plate: { x: 0, y: 0 }, cards: [{ x: 0, y: 0 }, { x: 0, y: 0 }], bet: { x: 0, y: 0 }, button: { x: 0, y: 0 } },
    };
  }

  private drawPlate(node: SeatNode, active: boolean) {
    node.plate
      .clear()
      .rect(-75, -36, 150, 72)
      .fill(SURFACE)
      .stroke({ width: active ? 2 : 1, color: active ? GOLD : LINE });
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
    chip.width = 24;
    chip.height = 24;
    return chip;
  }
}
