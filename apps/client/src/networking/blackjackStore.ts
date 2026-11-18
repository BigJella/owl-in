import type { BlackjackStateMessage } from "@owl-in/shared";
import { createGameStore, type Received } from "./gameStore";
import { socket } from "./socket";

export type ReceivedBlackjack = Received<BlackjackStateMessage>;

export const blackjackStore = createGameStore<BlackjackStateMessage>(
  (handler) => socket.on("blackjack:state", handler),
  (handler) => socket.on("blackjack:left", handler),
);

export const useBlackjackState = () => blackjackStore.useState();
