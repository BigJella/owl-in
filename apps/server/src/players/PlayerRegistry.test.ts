import { describe, expect, it } from "vitest";
import { PlayerRegistry } from "./PlayerRegistry";

describe("PlayerRegistry names", () => {
  it("keeps a name for its browser even while that player is offline", () => {
    const registry = new PlayerRegistry();
    const alice = registry.identify("token-alice", "Alice");
    expect("error" in alice).toBe(false);
    // Nobody is connected (no socket attached), but the name is still Alice's.
    expect(registry.nameTaken("token-other", "alice")).toBe(true);
    expect(registry.identify("token-other", "ALICE")).toEqual({ error: expect.stringMatching(/belongs to another player/) });
    expect(registry.all()).toHaveLength(1);
  });

  it("lets the same browser log back in, and renaming frees the old name", () => {
    const registry = new PlayerRegistry();
    const first = registry.identify("token-a", "Alice");
    expect(registry.identify("token-a", "Alice")).toBe(first);
    expect(registry.nameTaken("token-a", "alice")).toBe(false);

    expect(registry.identify("token-a", "Alicia")).toBe(first); // same player, new name
    expect(registry.nameTaken("token-b", "Alice")).toBe(false);
    expect("error" in registry.identify("token-b", "Alice")).toBe(false);
    expect(registry.nameTaken("token-b", "alicia")).toBe(true);
  });
});
