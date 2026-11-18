import type { PokerAction, PokerStateMessage, PokerTableView, Session } from "@owl-in/shared";
import { STARTING_BANKROLL } from "@owl-in/shared";
import type { GameSocket } from "../networking/types";
import { Player } from "./Player";

export class HumanPlayer extends Player {
  readonly kind = "human" as const;
  bankroll = STARTING_BANKROLL;
  roomId: string | null = null;
  private socket: GameSocket | null = null;
  private pending: { resolve: (action: PokerAction) => void } | null = null;

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

  override notify(message: PokerStateMessage) {
    this.socket?.emit("poker:state", message);
  }

  session(): Session {
    return { name: this.name, bankroll: this.bankroll, roomId: this.roomId };
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
