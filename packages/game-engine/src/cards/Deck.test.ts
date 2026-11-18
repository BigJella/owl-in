import { describe, expect, it } from "vitest";
import { createDeck, shuffle } from "./Deck";

const key = (card: { rank: string; suit: string }) => `${card.rank}-${card.suit}`;

describe("createDeck", () => {
  it("has 52 unique cards", () => {
    const deck = createDeck();
    expect(deck).toHaveLength(52);
    expect(new Set(deck.map(key)).size).toBe(52);
  });
});

describe("shuffle", () => {
  it("keeps the same cards and does not mutate the input", () => {
    const deck = createDeck();
    const before = deck.map(key);
    const shuffled = shuffle(deck);
    expect(deck.map(key)).toEqual(before);
    expect(shuffled.map(key).sort()).toEqual([...before].sort());
  });
});
