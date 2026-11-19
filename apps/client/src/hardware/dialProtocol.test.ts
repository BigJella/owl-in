import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createGestures, createLineSplitter, DIAL_FAST_FACTOR, DIAL_HOLD_MS, parseDialLine, type DialEvent } from "./dialProtocol";

describe("parseDialLine", () => {
  it("reads protocol v1", () => {
    expect(parseDialLine("OWL-DIAL 1")).toEqual({ type: "hello", version: 1 });
    expect(parseDialLine("R+1")).toEqual({ type: "turn", steps: 1 });
    expect(parseDialLine("R-3\r")).toEqual({ type: "turn", steps: -3 });
    expect(parseDialLine("P1")).toEqual({ type: "key", key: "P", down: true });
    expect(parseDialLine("A0")).toEqual({ type: "key", key: "A", down: false });
    expect(parseDialLine("B1")).toEqual({ type: "key", key: "B", down: true });
  });

  it("ignores anything else", () => {
    for (const line of ["", "  ", "R+0", "R1", "C1", "B2", "hello", "R+1 R+1", "OWL-DIAL"]) expect(parseDialLine(line)).toBeNull();
  });
});

describe("createLineSplitter", () => {
  it("joins chunks split mid-line and strips \\r", () => {
    const lines: string[] = [];
    const split = createLineSplitter((l) => lines.push(l));
    split("R+");
    split("1\r\nA1\nA");
    split("0\n");
    expect(lines).toEqual(["R+1", "A1", "A0"]);
  });
});

describe("createGestures", () => {
  let events: DialEvent[];
  let clock: number;
  let g: ReturnType<typeof createGestures>;
  const kinds = () => events.map((e) => e.kind);
  const key = (k: "P" | "A" | "B", down: boolean) => g.feed({ type: "key", key: k, down });

  beforeEach(() => {
    vi.useFakeTimers();
    events = [];
    clock = 1000;
    g = createGestures((e) => events.push(e), () => clock);
  });
  afterEach(() => vi.useRealTimers());

  it("fires press and A on release", () => {
    key("P", true);
    key("A", true);
    expect(events).toEqual([]);
    key("P", false);
    key("A", false);
    expect(kinds()).toEqual(["press", "a"]);
  });

  it("a short B is a tap", () => {
    key("B", true);
    vi.advanceTimersByTime(DIAL_HOLD_MS / 2);
    key("B", false);
    expect(kinds()).toEqual(["holdStart", "holdEnd", "b"]);
    vi.advanceTimersByTime(DIAL_HOLD_MS);
    expect(kinds()).toEqual(["holdStart", "holdEnd", "b"]);
  });

  it("holding B fires holdB once, while held, and swallows the release", () => {
    key("B", true);
    vi.advanceTimersByTime(DIAL_HOLD_MS);
    expect(kinds()).toEqual(["holdStart", "holdEnd", "holdB"]);
    vi.advanceTimersByTime(DIAL_HOLD_MS * 3);
    key("B", false);
    expect(kinds()).toEqual(["holdStart", "holdEnd", "holdB"]);
  });

  it("ignores a release without a press and a repeated press", () => {
    key("A", false);
    key("B", true);
    key("B", true);
    key("B", false);
    expect(kinds()).toEqual(["holdStart", "holdEnd", "b"]);
  });

  it("speeds up fast turns", () => {
    g.feed({ type: "turn", steps: 1 });
    clock += 200;
    g.feed({ type: "turn", steps: 1 });
    clock += 10;
    g.feed({ type: "turn", steps: -1 });
    expect(events).toEqual([
      { kind: "turn", steps: 1 },
      { kind: "turn", steps: 1 },
      { kind: "turn", steps: -DIAL_FAST_FACTOR },
    ]);
  });

  it("reset ends a pending hold without firing it", () => {
    key("B", true);
    g.reset();
    vi.advanceTimersByTime(DIAL_HOLD_MS * 2);
    expect(kinds()).toEqual(["holdStart", "holdEnd"]);
  });
});
