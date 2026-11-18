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
const POT = { x: CX, y: CY + 78 };
const FONT = "Inter, system-ui, -apple-system, Segoe UI, sans-serif";
const GOLD = 0xe5b85b;

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

function label(size: number, color: number, weight: "400" | "600" | "800" = "600") {
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
  private readonly potText = label(18, 0xffffff, "800");
  private readonly sidePotText = label(13, 0xd8e4dc);
  private readonly infoText = label(13, 0xb6c0b8);
  private readonly titleText = label(11, 0xffffff);
  /** Showdown hand names: drawn above all cards so nothing covers them. */
  private readonly handsLayer = new Container();
  /** Humans still to ready up between hands (for the sub-label). */
  private notReady = 0;
  private readonly dealerButton = new Container();

  private view: PokerTableView | null = null;
  private rotationSeat: number | null | undefined = undefined;
  private stacks: number[] = Array(SEATS).fill(0);
  private bets: number[] = Array(SEATS).fill(0);
  private contributed: number[] = Array(SEATS).fill(0);
  private pots: Pot[] = [];
  private queue: ReceivedMessage[] = [];
  private current: gsap.core.Timeline | null = null;
  private clock: { seat: number; endsAt: number; total: number } | null = null;
  /** Bot currently "thinking" (bots have no clock). */
  private thinkingSeat: number | null = null;
  private nextHandAt: number | null = null;

  constructor(
    private readonly app: Application,
    private readonly tex: PokerTextures,
  ) {
    this.drawFelt();
    this.potChip = this.makeChip();
    this.potChip.position.set(POT.x, POT.y);
    this.potText.anchor.set(0, 0.5);
    this.potText.y = POT.y;
    this.sidePotText.position.set(CX, POT.y + 28);
    this.infoText.position.set(CX, CY - 80);
    this.titleText.position.set(CX, CY - 175);
    this.titleText.alpha = 0.45;
    this.titleText.style.letterSpacing = 5;

    for (let i = 0; i < 5; i += 1) {
      const card = this.makeCard(BOARD_W, BOARD_H);
      card.position.set(CX + (i - 2) * (BOARD_W + 8), CY - 6);
      this.board.push(card);
      this.cardsLayer.addChild(card);
    }

    const button = new Graphics().circle(0, 0, 13).fill(0xfdfbf4).stroke({ width: 2, color: 0x8c6a24 });
    const d = label(13, 0x1d2021, "800");
    d.text = "D";
    this.dealerButton.addChild(button, d);
    this.dealerButton.visible = false;

    for (let seat = 0; seat < SEATS; seat += 1) this.seats.push(this.makeSeat());

    this.root.addChild(
      this.felt,
      this.titleText,
      this.potChip,
      this.potText,
      this.sidePotText,
      this.infoText,
      this.betsLayer,
      this.cardsLayer,
      this.dealerButton,
      this.seatsLayer,
      this.fx,
      this.handsLayer,
    );
    this.app.stage.addChild(this.root);
    this.layoutSeats(0);
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
    this.nextHandAt = view.nextHandInMs === null ? null : received.receivedAt + view.nextHandInMs;
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
    if (view.mySeat !== this.rotationSeat) {
      this.rotationSeat = view.mySeat;
      this.layoutSeats(view.mySeat ?? 0);
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
          if (chips.length) tl.to(chips, { x: POT.x, y: POT.y, duration: 0.35, ease: "power2.in", stagger: 0.03 });
          tl.call(() => {
            for (const chip of chips) chip.destroy();
            this.setPots(e.pots);
          });
          break;
        }

        case "communityDealt": {
          const start = { preflop: 0, flop: 0, turn: 3, river: 4 }[e.street];
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
              POT,
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
    this.titleText.text = `${view.name.toUpperCase()}  ·  ${fmt(view.smallBlind)}/${fmt(view.bigBlind)}`;
    this.notReady = view.seats.filter((s) => s?.ready === false).length;

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
      node.status.style.fill = s.cashingOut || !s.connected ? 0xff8a80 : 0xd2c8a8;
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

    this.setPots(view.pots);
    const buttonSeat = view.seats[view.button] ? view.button : null;
    this.dealerButton.visible = view.handId > 0 && buttonSeat !== null;
    if (buttonSeat !== null) this.dealerButton.position.copyFrom(this.seats[buttonSeat]!.geom.button);
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
    node.handBg.clear().roundRect(-w / 2, -h / 2, w, h, 6).fill({ color: 0x111315, alpha: 0.88 }).stroke({ width: 1, color: GOLD, alpha: 0.6 });
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
    this.potChip.x = POT.x - width / 2 + 12;
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
        node.clock.style.fill = 0x8fb8ff;
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
      const color = fraction > 0.5 ? 0x65bc75 : fraction > 0.2 ? GOLD : 0xd9534f;
      node.timer.roundRect(-72, 39, 144 * fraction, 5, 2).fill(color);
      node.clock.text = `${Math.ceil(remaining / 1000)}s`;
      node.clock.style.fill = color;
    }
    if (this.view?.phase !== "idle" || this.current) {
      this.infoText.text = "";
    } else if (this.nextHandAt !== null) {
      const seconds = Math.max(0, Math.ceil((this.nextHandAt - now) / 1000));
      this.infoText.text = seconds > 1 ? `Next hand in ${seconds}s` : "Dealing…";
    } else if (this.notReady > 0) {
      this.infoText.text = `Waiting for ${this.notReady} player${this.notReady === 1 ? "" : "s"} to ready up`;
    } else {
      this.infoText.text = "";
    }
  };

  // ---------- construction / layout ----------

  private fit = (width: number, height: number) => {
    const scale = Math.min(width / W, height / H);
    this.root.scale.set(scale);
    this.root.position.set((width - W * scale) / 2, (height - H * scale) / 2);
  };

  private drawFelt() {
    this.felt
      .ellipse(CX, CY + 12, 478, 252)
      .fill({ color: 0x000000, alpha: 0.35 })
      .ellipse(CX, CY, 478, 250)
      .fill(0x5a3b29)
      .ellipse(CX, CY, 456, 228)
      .fill(0x0d6e4d)
      .stroke({ width: 4, color: 0xa18b67 })
      .ellipse(CX, CY, 380, 170)
      .stroke({ width: 2, color: 0xffffff, alpha: 0.06 });
  }

  /** Seat positions rotate so your own seat is always bottom-centre. */
  private layoutSeats(anchorSeat: number) {
    this.seats.forEach((node, seat) => {
      const displayIndex = (seat - anchorSeat + SEATS) % SEATS;
      const angle = Math.PI / 2 + (displayIndex * 2 * Math.PI) / SEATS;
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
    const name = label(14, 0xffffff, "800");
    name.position.set(0, -18);
    const stack = label(15, GOLD, "800");
    stack.position.set(0, 2);
    const inPot = label(11, 0x9fb5aa, "600");
    inPot.position.set(0, 21);
    const badgeText = label(9, 0x17191a, "800");
    badgeText.text = "BOT";
    const badge = new Container();
    badge.addChild(new Graphics().roundRect(-15, -8, 30, 16, 4).fill(0x8fb8ff), badgeText);
    badge.position.set(62, -36);
    badge.visible = false;
    const status = label(10, 0xd2c8a8, "800");
    status.position.set(0, -48);
    const action = label(14, 0xffffff, "800");
    action.position.set(0, 60);
    const clock = label(20, 0x65bc75, "800");
    clock.position.set(0, -52);
    const roleText = label(10, 0x17191a, "800");
    const role = new Container();
    role.addChild(new Graphics().roundRect(-14, -8, 28, 16, 4).fill(0xfdfbf4), roleText);
    role.position.set(-62, -36);
    role.visible = false;
    root.addChild(plate, timer, name, stack, inPot, badge, role, status, action, clock);

    const cards: [Sprite, Sprite] = [this.makeCard(CARD_W, CARD_H), this.makeCard(CARD_W, CARD_H)];
    this.cardsLayer.addChild(...cards);
    const handText = label(12, 0xffffff, "800");
    const handBg = new Graphics();
    const hand = new Container();
    hand.addChild(handBg, handText);
    hand.visible = false;
    this.handsLayer.addChild(hand);
    const betChip = this.makeChip();
    betChip.visible = false;
    const betText = label(13, 0xffffff, "800");
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
      .roundRect(-75, -36, 150, 72, 12)
      .fill({ color: 0x1d2021, alpha: 0.94 })
      .stroke({ width: active ? 3 : 1.5, color: active ? GOLD : 0x45494a });
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
