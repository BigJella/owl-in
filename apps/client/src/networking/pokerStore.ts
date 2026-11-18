import type { PokerStateMessage } from "@owl-in/shared";
import { createGameStore, type Received } from "./gameStore";
import { socket } from "./socket";

export type ReceivedMessage = Received<PokerStateMessage>;

export const pokerStore = createGameStore<PokerStateMessage>(
  (handler) => socket.on("poker:state", handler),
  (handler) => socket.on("poker:left", handler),
);

/** Latest poker message for React UI (action bar, banners). */
export const usePokerState = () => pokerStore.useState();
