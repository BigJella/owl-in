import { useSyncExternalStore } from "react";

/** A server state message plus when it arrived. */
export interface Received<M> {
  message: M;
  /** performance.now() at receipt, to turn relative timers into local deadlines. */
  receivedAt: number;
}

export interface GameStore<M> {
  latest(): Received<M> | null;
  reset(): void;
  /** Every message, in order (for the animator). */
  subscribe(listener: (received: Received<M>) => void): () => void;
  /** Latest message for React UI. */
  useState(): Received<M> | null;
}

/**
 * Buffers a game's state messages outside React so no message (and its animation events)
 * is lost to render batching or arrives before the table page mounts.
 * The last state is kept after "left" so a departing player can watch the end play out;
 * the app calls reset() once they head back to the lobby.
 */
export function createGameStore<M>(
  onState: (handler: (message: M) => void) => void,
  onLeft: (handler: () => void) => void,
): GameStore<M> {
  let latest: Received<M> | null = null;
  const listeners = new Set<(received: Received<M>) => void>();
  const snapshotListeners = new Set<() => void>();
  const notifySnapshot = () => {
    for (const listener of snapshotListeners) listener();
  };

  onState((message) => {
    latest = { message, receivedAt: performance.now() };
    for (const listener of listeners) listener(latest);
    notifySnapshot();
  });
  onLeft(notifySnapshot);

  const subscribeSnapshot = (onChange: () => void) => {
    snapshotListeners.add(onChange);
    return () => {
      snapshotListeners.delete(onChange);
    };
  };

  return {
    latest: () => latest,
    reset() {
      latest = null;
      notifySnapshot();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    useState: () => useSyncExternalStore(subscribeSnapshot, () => latest),
  };
}
