/**
 * Owl Dial serial protocol v1 (see "Owl Dial" in CLAUDE.md) and the gesture layer that turns raw
 * key-down / key-up lines into what the UI uses (taps, a 1 s hold on B, accelerated turns). Pure: no Web Serial here.
 */

export type DialKey = "P" | "A" | "B";

export type RawDialEvent = { type: "turn"; steps: number } | { type: "key"; key: DialKey; down: boolean } | { type: "hello"; version: number };

/**
 * What the UI receives.
 * - `holdStart` / `holdEnd`: B went down / the hold is over (released or fired). Used to draw the hold bar.
 *   `holdEnd` is broadcast to every handler; the others go to the first handler that consumes them.
 */
export type DialEvent =
  | { kind: "turn"; steps: number }
  | { kind: "press" }
  | { kind: "a" }
  | { kind: "b" }
  | { kind: "holdB" }
  | { kind: "holdStart" }
  | { kind: "holdEnd" };

export const DIAL_HOLD_MS = 1000;
/** Detents closer together than this count as a fast turn. */
export const DIAL_FAST_MS = 40;
export const DIAL_FAST_FACTOR = 5;

/** One line of protocol v1, or null for anything else (blank lines, noise, unknown commands). */
export function parseDialLine(line: string): RawDialEvent | null {
  const text = line.trim();
  const hello = /^OWL-DIAL (\d+)$/.exec(text);
  if (hello) return { type: "hello", version: Number(hello[1]) };
  const turn = /^R([+-]\d{1,3})$/.exec(text);
  if (turn) {
    const steps = Number(turn[1]);
    return steps === 0 ? null : { type: "turn", steps };
  }
  const key = /^([PAB])([01])$/.exec(text);
  if (key) return { type: "key", key: key[1] as DialKey, down: key[2] === "1" };
  return null;
}

/** Splits a stream of text chunks into lines (handles chunks that end mid-line). */
export function createLineSplitter(onLine: (line: string) => void) {
  let buffer = "";
  return (chunk: string) => {
    buffer += chunk;
    let at = buffer.indexOf("\n");
    while (at >= 0) {
      onLine(buffer.slice(0, at).replace(/\r$/, ""));
      buffer = buffer.slice(at + 1);
      at = buffer.indexOf("\n");
    }
    // A stream of garbage without newlines shouldn't grow forever.
    if (buffer.length > 256) buffer = "";
  };
}

/**
 * Turns raw events into gestures. Press, A and B fire on release; holding B for `DIAL_HOLD_MS` fires `holdB` once
 * (while still held) and swallows that release. Fast turns are multiplied.
 */
export function createGestures(emit: (event: DialEvent) => void, now: () => number = Date.now) {
  const down = new Set<DialKey>();
  let holdTimer: ReturnType<typeof setTimeout> | null = null;
  let holdFired = false;
  let lastTurn = -Infinity;

  const endHold = () => {
    if (holdTimer) clearTimeout(holdTimer);
    holdTimer = null;
  };

  function feed(event: RawDialEvent) {
    if (event.type === "hello") return;
    if (event.type === "turn") {
      const t = now();
      const fast = t - lastTurn < DIAL_FAST_MS;
      lastTurn = t;
      emit({ kind: "turn", steps: fast ? event.steps * DIAL_FAST_FACTOR : event.steps });
      return;
    }
    const { key } = event;
    if (event.down) {
      if (down.has(key)) return; // repeated down without an up
      down.add(key);
      if (key === "B") {
        holdFired = false;
        emit({ kind: "holdStart" });
        holdTimer = setTimeout(() => {
          holdTimer = null;
          holdFired = true;
          emit({ kind: "holdEnd" });
          emit({ kind: "holdB" });
        }, DIAL_HOLD_MS);
      }
      return;
    }
    if (!down.has(key)) return; // release without a press (e.g. connected mid-press)
    down.delete(key);
    if (key === "P") emit({ kind: "press" });
    else if (key === "A") emit({ kind: "a" });
    else if (!holdFired) {
      endHold();
      emit({ kind: "holdEnd" });
      emit({ kind: "b" });
    }
  }

  /** Forget everything held (e.g. the device disconnected). */
  function reset() {
    if (down.has("B") && !holdFired) emit({ kind: "holdEnd" });
    endHold();
    down.clear();
  }

  return { feed, reset };
}
