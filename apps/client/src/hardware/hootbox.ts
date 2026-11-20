/**
 * The HootBox connection (Web Serial) and event dispatch, kept outside React like the game stores.
 *
 * Dispatch: each handler has a priority (dialogs 2, table panels 1, the page 0). An event goes to the handlers from the
 * highest priority down until one returns true (consumed). `holdEnd` is the exception: every handler gets it, so a
 * hold bar always clears.
 */
import { createGestures, createLineSplitter, parseHootBoxLine, type HootBoxEvent } from "./hootboxProtocol";

export type HootBoxStatus = "unsupported" | "disconnected" | "connecting" | "connected";
export type HootBoxHandler = (event: HootBoxEvent) => boolean | void;

const BAUD = 115200;

let status: HootBoxStatus = typeof navigator !== "undefined" && navigator.serial ? "disconnected" : "unsupported";
let port: SerialPort | null = null;
let reader: ReadableStreamDefaultReader<string> | null = null;
let lastError: string | null = null;
const statusListeners = new Set<() => void>();
const handlers: { handler: HootBoxHandler; priority: number; order: number }[] = [];
let order = 0;

function setStatus(next: HootBoxStatus) {
  status = next;
  statusListeners.forEach((l) => l());
}

function dispatch(event: HootBoxEvent) {
  const sorted = [...handlers].sort((a, b) => b.priority - a.priority || b.order - a.order);
  if (event.kind === "holdEnd") {
    sorted.forEach((h) => h.handler(event));
    return;
  }
  for (const h of sorted) if (h.handler(event) === true) return;
}

const gestures = createGestures(dispatch);
const splitLine = createLineSplitter((line) => {
  const raw = parseHootBoxLine(line);
  if (raw) gestures.feed(raw);
});

async function readLoop(p: SerialPort) {
  const decoder = new TextDecoderStream();
  const closed = p.readable!.pipeTo(decoder.writable as WritableStream<Uint8Array>).catch(() => {});
  reader = decoder.readable.getReader();
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      if (value) splitLine(value);
    }
  } catch {
    // Unplugged or closed: handled below.
  } finally {
    reader.releaseLock();
    reader = null;
    await closed;
  }
}

async function open(p: SerialPort) {
  setStatus("connecting");
  try {
    await p.open({ baudRate: BAUD });
  } catch (error) {
    lastError = error instanceof Error ? error.message : "Couldn't open the port.";
    setStatus("disconnected");
    return;
  }
  port = p;
  lastError = null;
  setStatus("connected");
  await readLoop(p);
  // The read loop ended: unplugged, or disconnect() was called.
  gestures.reset();
  if (port === p) {
    port = null;
    await p.close().catch(() => {});
    setStatus("disconnected");
  }
}

export const hootBox = {
  getStatus: () => status,
  getError: () => lastError,
  subscribeStatus(listener: () => void) {
    statusListeners.add(listener);
    return () => {
      statusListeners.delete(listener);
    };
  },
  /** Register a handler; returns the unregister function. */
  on(handler: HootBoxHandler, priority: number) {
    const entry = { handler, priority, order: order++ };
    handlers.push(entry);
    return () => {
      const i = handlers.indexOf(entry);
      if (i >= 0) handlers.splice(i, 1);
    };
  },
  /** Ask the user to pick the board's port (must run from a click). */
  async connect() {
    if (!navigator.serial || status === "connected" || status === "connecting") return;
    try {
      const p = await navigator.serial.requestPort();
      void open(p);
    } catch {
      // The user closed the picker.
    }
  },
  async disconnect() {
    const p = port;
    if (!p) return;
    port = null;
    await reader?.cancel().catch(() => {});
    await p.close().catch(() => {});
    gestures.reset();
    setStatus("disconnected");
  },
  /** Feed protocol lines as if they came from the board (tests and the dev console: `hootBox.emit("R+1")`). */
  emit(...lines: string[]) {
    lines.forEach((line) => splitLine(`${line}\n`));
  },
};

// Reconnect to a board this browser was already allowed to use: on load, and when it's plugged back in.
if (navigator.serial) {
  const tryKnown = async () => {
    if (status !== "disconnected") return;
    const [known] = await navigator.serial!.getPorts();
    if (known) void open(known);
  };
  void tryKnown();
  navigator.serial.addEventListener("connect", () => void tryKnown());
}

if (import.meta.env.DEV) (window as unknown as { hootBox: typeof hootBox }).hootBox = hootBox;
