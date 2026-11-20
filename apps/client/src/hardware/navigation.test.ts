import { describe, expect, it } from "vitest";
import { pickFocus, stepFocus } from "./navigation";

describe("stepFocus", () => {
  const keys = ["nav:games", "room:a", "room:b", "room:c"];

  it("moves by key and clamps at the ends", () => {
    expect(stepFocus(keys, "room:a", 1)).toBe("room:b");
    expect(stepFocus(keys, "room:a", -1)).toBe("nav:games");
    expect(stepFocus(keys, "room:b", 5)).toBe("room:c");
    expect(stepFocus(keys, "nav:games", -3)).toBe("nav:games");
  });

  it("follows the item when the list reorders", () => {
    const reordered = ["nav:games", "room:c", "room:a", "room:b"];
    expect(stepFocus(reordered, "room:a", 1)).toBe("room:b");
    expect(stepFocus(reordered, "room:a", -1)).toBe("room:c");
  });

  it("falls back to the nearest index when the focused item is gone", () => {
    expect(stepFocus(["nav:games", "room:a", "room:c"], "room:b", 1, 2)).toBe("room:c");
    expect(stepFocus(["nav:games"], "room:b", 1, 2)).toBe("nav:games");
    expect(stepFocus([], "room:b", 1)).toBeNull();
  });
});

describe("pickFocus", () => {
  const keys = ["nav:games", "leader:me", "leader:x"];

  it("prefers the remembered key, then the initial one, then the first", () => {
    expect(pickFocus(keys, "leader:x", "leader:me", null)).toBe("leader:x");
    expect(pickFocus(keys, null, "leader:me", null)).toBe("leader:me");
    expect(pickFocus(keys, null, null, null)).toBe("nav:games");
    expect(pickFocus([], null, null, null)).toBeNull();
  });

  it("uses the last index when the remembered item vanished", () => {
    expect(pickFocus(keys, "leader:gone", "leader:me", 2)).toBe("leader:x");
  });
});
