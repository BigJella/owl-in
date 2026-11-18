import type {
  BlackjackAction,
  BlackjackStateMessage,
  GameType,
  PokerAction,
  PokerStateMessage,
  PokerTableView,
  Session,
} from "@owl-in/shared";
import { STARTING_BANKROLL } from "@owl-in/shared";
import type { GameSocket } from "../networking/types";
import { Player } from "./Player";

export class HumanPlayer extends Player {
  readonly kind = "human" as const;
  bankroll = STARTING_BANKROLL;
  /** Others may open this player's career page from the leaderboard. */
  careerPublic = true;
  roomId: string | null = null;
  /** Which game `roomId` is (one table at a time across all games). */
  game: GameType | null = null;
  private socket: GameSocket | null = null;
  private pending: { resolve: (action: PokerAction) => void } | null = null;
  private pendingBlackjack: { resolve: (action: BlackjackAction) => void } | null = null;

  constructor(
    id: string,
    readonly token: string,
    name: string,
  ) {
    super(id, name);
  }

  get connected() {
    return this.socket?.connected ?? false;
  }

  attach(socket: GameSocket) {
    if (this.socket && this.socket !== socket) this.socket.disconnect(true); // one tab per player
    this.socket = socket;
  }

  detach(socket: GameSocket) {
    if (this.socket === socket) this.socket = null;
  }

  requestAction(_view: PokerTableView, signal: AbortSignal): Promise<PokerAction> {
    return new Promise((resolve, reject) => {
      this.pending = { resolve };
      signal.addEventListener("abort", () => {
        this.pending = null;
        reject(signal.reason);
      });
    });
  }

  /** Called by the socket handler; the room has already checked the action is legal. */
  submitAction(action: PokerAction): boolean {
    if (!this.pending) return false;
    const { resolve } = this.pending;
    this.pending = null;
    resolve(action);
    return true;
  }

  requestBlackjackAction(signal: AbortSignal): Promise<BlackjackAction> {
    return new Promise((resolve, reject) => {
      this.pendingBlackjack = { resolve };
      signal.addEventListener("abort", () => {
        this.pendingBlackjack = null;
        reject(signal.reason);
      });
    });
  }

  /** Called by the socket handler; the room has already checked the action is legal. */
  submitBlackjackAction(action: BlackjackAction): boolean {
    if (!this.pendingBlackjack) return false;
    const { resolve } = this.pendingBlackjack;
    this.pendingBlackjack = null;
    resolve(action);
    return true;
  }

  notifyBlackjack(message: BlackjackStateMessage) {
    this.socket?.emit("blackjack:state", message);
  }

  sendBlackjackLeft() {
    this.socket?.emit("blackjack:left");
  }

  override notify(message: PokerStateMessage) {
    this.socket?.emit("poker:state", message);
  }

  session(): Session {
    return {
      playerId: this.id,
      name: this.name,
      careerPublic: this.careerPublic,
      bankroll: this.bankroll,
      roomId: this.roomId,
      game: this.roomId ? this.game : null,
    };
  }

  sendSession() {
    this.socket?.emit("session", this.session());
  }

  /** Tell the client it no longer has a seat (cashed out, kicked, ...). */
  sendLeft() {
    this.socket?.emit("poker:left");
  }

  sendError(message: string) {
    this.socket?.emit("error-message", message);
  }
}
