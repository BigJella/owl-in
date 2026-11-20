import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { hootBox, type HootBoxHandler } from "./hootbox";
import type { HootBoxEvent } from "./hootboxProtocol";
import { stepIndex } from "./navigation";

export { stepIndex };

/** Dialogs win over table panels, which win over the page. */
export const HOOTBOX_PRIORITY = { page: 0, panel: 1, dialog: 2 } as const;

export function useHootBoxStatus() {
  return useSyncExternalStore(hootBox.subscribeStatus, hootBox.getStatus);
}

/** Is a HootBox connected? Highlights (`.hootbox-focus`) are only drawn then. */
export function useHootBoxConnected() {
  return useHootBoxStatus() === "connected";
}

/** Receive HootBox events while `active`. The latest handler is always used, so closures never go stale. */
export function useHootBox(handler: HootBoxHandler, priority: number, active = true) {
  const ref = useRef(handler);
  ref.current = handler;
  useEffect(() => {
    if (!active) return;
    return hootBox.on((event) => ref.current(event), priority);
  }, [priority, active]);
}

/**
 * B-hold progress for one target: call `start()` from your `holdStart` handling when a hold would act on this
 * control; `holding` goes false again on `holdEnd` (broadcast). Render `<HoldFill>`-style markup while it's true.
 */
export function useHoldState() {
  const [holding, setHolding] = useState(false);
  return {
    holding,
    start: () => setHolding(true),
    /** Pass every event through this; it clears the hold on `holdEnd`. */
    track: (event: HootBoxEvent) => {
      if (event.kind === "holdEnd") setHolding(false);
    },
  };
}

/**
 * A highlight that the dial moves over a list of entries. Returns the focused index (-1 when nothing is enabled) and
 * `move(steps)` for `turn`. If the focused entry becomes disabled it falls back to the first enabled one from `initial`.
 */
export function useHootBoxMenu(enabled: boolean[], initial = 0) {
  const [index, setIndex] = useState(initial);
  const fallback = () => {
    for (let i = initial; i < enabled.length; i += 1) if (enabled[i]) return i;
    for (let i = initial - 1; i >= 0; i -= 1) if (enabled[i]) return i;
    return -1;
  };
  const focused = enabled[index] ? index : fallback();
  return {
    focused,
    move: (steps: number) => focused >= 0 && setIndex(stepIndex(enabled, focused, steps)),
    reset: () => setIndex(initial),
  };
}
