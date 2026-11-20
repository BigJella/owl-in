/**
 * HootBox site navigation (away from the tables). Pages opt elements in with data attributes:
 *
 * - `data-hb="<stable key>"`  focusable, in DOM order (disabled / hidden ones are skipped)
 * - `data-hb-initial`         the default focus on that screen
 * - `data-hb-back`            what B clicks (the page's "← Games" button)
 * - `data-hb-adjust="range" | "select" | "keys"`  a value control: pressing the dial adjusts it with the turn
 * - `data-hb-activate="<selector>"`  A clicks this child instead of the element (e.g. a row's Join button);
 *                             when that child is disabled the row is skipped
 *
 * Focus is tracked by key, so it stays on the same table / player while lists reorder.
 */
export type AdjustKind = "range" | "select" | "keys";

/** Move `steps` entries from `from` through the enabled ones (disabled skipped, clamped at the ends). */
export function stepIndex(enabled: boolean[], from: number, steps: number): number {
  let at = from;
  const dir = Math.sign(steps);
  for (let n = Math.abs(steps); n > 0; n -= 1) {
    let next = at + dir;
    while (next >= 0 && next < enabled.length && !enabled[next]) next += dir;
    if (next < 0 || next >= enabled.length) break;
    at = next;
  }
  return at;
}

/** Where the focus goes after `steps` detents. Unknown / vanished keys fall back to the nearest index. */
export function stepFocus(keys: string[], current: string | null, steps: number, lastIndex = 0): string | null {
  if (keys.length === 0) return null;
  const at = current === null ? -1 : keys.indexOf(current);
  if (at < 0) return keys[Math.min(Math.max(lastIndex, 0), keys.length - 1)]!;
  return keys[stepIndex(keys.map(() => true), at, steps)]!;
}

/** The focus to use when nothing valid is focused: remembered key, then `data-hb-initial`, then the first item. */
export function pickFocus(keys: string[], remembered: string | null, initial: string | null, lastIndex: number | null): string | null {
  if (keys.length === 0) return null;
  if (remembered && keys.includes(remembered)) return remembered;
  if (lastIndex !== null && remembered) return keys[Math.min(lastIndex, keys.length - 1)]!;
  if (initial && keys.includes(initial)) return initial;
  return keys[0]!;
}

// ---- DOM helpers -------------------------------------------------------------------------------------------------

function isDisabled(el: Element): boolean {
  return el.matches(":disabled") || el.getAttribute("aria-disabled") === "true";
}

function isVisible(el: HTMLElement): boolean {
  return el.getClientRects().length > 0;
}

/** The element A acts on. */
export function activationTarget(el: HTMLElement): HTMLElement | null {
  const selector = el.dataset.hbActivate;
  if (!selector) return el;
  return el.querySelector<HTMLElement>(selector);
}

/** Focusable items in `scope`, in DOM order. */
export function collectItems(scope: ParentNode): HTMLElement[] {
  return [...scope.querySelectorAll<HTMLElement>("[data-hb]")].filter((el) => {
    if (!isVisible(el) || isDisabled(el)) return false;
    if (el.dataset.hbActivate) {
      const target = activationTarget(el);
      if (target && isDisabled(target)) return false;
    }
    return true;
  });
}

const valueSetter = (proto: object) => Object.getOwnPropertyDescriptor(proto, "value")?.set;

/** Set an input / select value the way React notices (native setter + bubbling events). */
function setNativeValue(el: HTMLInputElement | HTMLSelectElement, value: string) {
  const setter = valueSetter(el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype);
  setter?.call(el, value);
  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.dispatchEvent(new Event("change", { bubbles: true }));
}

/** The control a `data-hb-adjust` element adjusts: itself, or the input / select / svg inside it. */
function adjustControl(el: HTMLElement): HTMLElement {
  if (el.matches("input, select, svg")) return el;
  return el.querySelector<HTMLElement>("input, select, svg[tabindex]") ?? el;
}

/** Turn a value control by `steps`. */
export function adjustValue(el: HTMLElement, steps: number) {
  const kind = el.dataset.hbAdjust as AdjustKind | undefined;
  const control = adjustControl(el);
  if (kind === "range" && control instanceof HTMLInputElement) {
    const step = Number(control.step) || 1;
    const min = Number(control.min);
    const max = Number(control.max);
    const next = Math.min(max, Math.max(min, Number(control.value) + steps * step));
    if (next !== Number(control.value)) setNativeValue(control, String(next));
  } else if (kind === "select" && control instanceof HTMLSelectElement) {
    const options = [...control.options].map((o, i) => (o.disabled ? -1 : i)).filter((i) => i >= 0);
    const at = options.indexOf(control.selectedIndex);
    const next = options[Math.min(options.length - 1, Math.max(0, at + Math.sign(steps)))];
    if (next !== undefined && next !== control.selectedIndex) setNativeValue(control, control.options[next]!.value);
  } else if (kind === "keys") {
    const key = steps > 0 ? "ArrowRight" : "ArrowLeft";
    for (let n = Math.abs(steps); n > 0; n -= 1) {
      control.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
    }
  }
}
