/**
 * Site navigation with the HootBox, away from the tables (see "Site navigation" in CLAUDE.md):
 * turn = move the highlight, A = do it, B = back / cancel, hold B = Games, press = adjust a value control.
 * Elements opt in with the `data-hb*` attributes described in `navigation.ts`.
 */
import { useEffect, useRef, useState } from "react";
import { activationTarget, adjustValue, collectItems, pickFocus, stepFocus } from "./navigation";
import { HOOTBOX_PRIORITY, useHootBox, useHootBoxConnected, useHoldState } from "./useHootBox";

type ScopeState = { key: string | null; index: number; explicit: boolean };

/** Per screen (and per dialog on it): the last highlighted item, kept for the whole visit to the site. */
const remembered = new Map<string, ScopeState>();

/** A HootBox event arrived this page load (the board, or `hootBox.emit` in dev): draw the highlight from then on. */
let eventSeen = false;

const FOCUS = "data-hb-focus";
const ADJUSTING = "data-hb-adjusting";

function currentScope(screenKey: string): { root: HTMLElement | null; id: string; modal: boolean } {
  const modal = document.querySelector<HTMLElement>(".modal");
  if (modal) return { root: modal, id: `${screenKey}:modal`, modal: true };
  return { root: document.querySelector<HTMLElement>("main"), id: screenKey, modal: false };
}

function byKey(items: HTMLElement[], key: string | null) {
  return key === null ? null : (items.find((el) => el.dataset.hb === key) ?? null);
}

/**
 * @param active   false at the tables (they have their own mappings) and while banned
 * @param screenKey which screen this is (e.g. "leaderboard", "career:<id>"): focus is remembered per screen
 * @param onHome   hold B goes here (undefined: hold B does nothing, e.g. on Games itself)
 */
export function useHootBoxNavigation({ active, screenKey, onHome }: { active: boolean; screenKey: string; onHome?: () => void }) {
  const connected = useHootBoxConnected();
  const [seen, setSeen] = useState(eventSeen);
  /** Draw the highlight: only once a HootBox is in use. Events are handled whenever `active`. */
  const on = active && (connected || seen);
  const adjusting = useRef(false);
  const homeHold = useHoldState();

  /** The highlighted element right now (recomputed: lists change under us). */
  function resolve() {
    const scope = currentScope(screenKey);
    if (!scope.root) return { scope, items: [] as HTMLElement[], el: null as HTMLElement | null, state: null as ScopeState | null };
    if (!scope.modal) {
      // A closed dialog starts fresh next time it opens.
      remembered.delete(`${screenKey}:modal`);
    }
    const items = collectItems(scope.root);
    const keys = items.map((el) => el.dataset.hb!);
    const state = remembered.get(scope.id) ?? { key: null, index: 0, explicit: false };
    let key: string | null;
    if (state.explicit) {
      key = keys.includes(state.key ?? "") ? state.key : stepFocus(keys, state.key, 0, state.index);
    } else {
      // Until the player turns the dial, follow the page's preferred item (it may only appear once data loads).
      const initial = items.find((el) => el.hasAttribute("data-hb-initial"))?.dataset.hb ?? null;
      key = pickFocus(keys, null, initial, null);
    }
    return { scope, items, el: byKey(items, key), state };
  }

  function paint() {
    document.querySelectorAll(`[${FOCUS}], [${ADJUSTING}]`).forEach((el) => {
      el.removeAttribute(FOCUS);
      el.removeAttribute(ADJUSTING);
    });
    if (!on) return;
    const { el } = resolve();
    if (!el) {
      adjusting.current = false;
      return;
    }
    el.setAttribute(FOCUS, "");
    if (adjusting.current) el.setAttribute(ADJUSTING, "");
  }

  function focus(scopeId: string, items: HTMLElement[], key: string | null) {
    const index = key === null ? 0 : items.findIndex((el) => el.dataset.hb === key);
    remembered.set(scopeId, { key, index: Math.max(0, index), explicit: true });
    adjusting.current = false;
    paint();
    byKey(items, key)?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }

  // Repaint when the screen changes and whenever React adds or replaces nodes (rows loading, dialogs opening).
  const paintRef = useRef(paint);
  paintRef.current = paint;
  useEffect(() => {
    adjusting.current = false;
    paintRef.current();
    if (!on) return;
    const main = document.querySelector("main");
    if (!main) return;
    let queued = false;
    const observer = new MutationObserver(() => {
      if (queued) return;
      queued = true;
      requestAnimationFrame(() => {
        queued = false;
        paintRef.current();
      });
    });
    observer.observe(main, { childList: true, subtree: true });
    return () => {
      observer.disconnect();
      document.querySelectorAll(`[${FOCUS}], [${ADJUSTING}]`).forEach((el) => {
        el.removeAttribute(FOCUS);
        el.removeAttribute(ADJUSTING);
      });
    };
  }, [on, screenKey]);

  useHootBox(
    (event) => {
      homeHold.track(event);
      if (!eventSeen || !seen) {
        eventSeen = true;
        setSeen(true);
      }
      const { scope, items, el } = resolve();

      switch (event.kind) {
        case "turn": {
          if (adjusting.current && el) {
            adjustValue(el, event.steps);
            return true;
          }
          const keys = items.map((item) => item.dataset.hb!);
          const from = el?.dataset.hb ?? null;
          focus(scope.id, items, from === null ? pickFocus(keys, null, null, null) : stepFocus(keys, from, event.steps));
          return true;
        }
        case "press":
        case "a": {
          if (!el) return true;
          if (adjusting.current) {
            adjusting.current = false;
            paint();
            return true;
          }
          if (event.kind === "press" && el.dataset.hbAdjust) {
            adjusting.current = true;
            remembered.set(scope.id, { key: el.dataset.hb!, index: items.indexOf(el), explicit: true });
            paint();
            return true;
          }
          activationTarget(el)?.click();
          return true;
        }
        case "b": {
          if (adjusting.current) {
            adjusting.current = false;
            paint();
            return true;
          }
          scope.root?.querySelector<HTMLElement>("[data-hb-back]")?.click();
          return true;
        }
        case "holdStart":
          if (onHome && !scope.modal) homeHold.start();
          return true;
        case "holdB":
          if (onHome && !scope.modal) onHome();
          return true;
        default:
          return false;
      }
    },
    HOOTBOX_PRIORITY.page,
    active,
  );

  return { homeHolding: on && homeHold.holding };
}
