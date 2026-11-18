import { useSyncExternalStore } from "react";
import type { PokerStateMessage } from "@owl-in/shared";
import { socket } from "./socket";

/**
 * Buffers poker state outside React so no message (and its animation events)
 * is lost to render batching or arrives before the table page mounts.
 */
export interface ReceivedMessage {
  message: PokerStateMessage;
  /** performance.now() at receipt, to turn relative timers into local deadlines. */
  receivedAt: number;
}

let latest: ReceivedMessage | null = null;
const listeners = new Set<(received: ReceivedMessage) => void>();
const snapshotListeners = new Set<() => void>();

socket.on("poker:state", (message) => {
  latest = { message, receivedAt: performance.now() };
  for (const listener of listeners) listener(latest);
  for (const listener of snapshotListeners) listener();
});

// Keep the last state after leaving so a cashed-out player can still watch their final hand play out.
// The app calls pokerStore.reset() once they head back to the lobby.
socket.on("poker:left", () => {
  for (const listener of snapshotListeners) listener();
});

export const pokerStore = {
  latest: () => latest,
  reset() {
    latest = null;
    for (const listener of snapshotListeners) listener();
  },
  /** Every message, in order (for the animator). */
  subscribe(listener: (received: ReceivedMessage) => void) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
};

/** Latest message for React UI (action bar, banners). */
export function usePokerState(): ReceivedMessage | null {
  return useSyncExternalStore(
    (onChange) => {
      snapshotListeners.add(onChange);
      return () => snapshotListeners.delete(onChange);
    },
    () => latest,
  );
}
