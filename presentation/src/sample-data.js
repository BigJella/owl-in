/*
 * Sample data for when the game server isn't reachable (the deck opened from disk / Google Drive, or the server is off).
 * Same shapes as the management API (`/api/admin/snapshot`, `/llm`, `/log`). Every live panel that uses it shows
 * "Server offline · sample data". Totals are made consistent, so the chip-conservation check passes here too.
 */
window.OWL_SAMPLE = (() => {
  const START = 10_000;
  const now = Date.now();
  const humans = [
    ["Maya", 12_480], ["Jordan", 11_360], ["Priya", 10_940], ["Marcus", 10_610], ["Zoe", 10_220], ["Kai", 10_000],
    ["Hana", 9_870], ["Devin", 9_420], ["Elena", 9_100], ["Leo", 8_650], ["Sam", 7_930], ["Noah", 6_840],
  ];
  // [table id, game, name, stakes, stage, hand #, humans (names), bots ([name, llm?]), pot]
  const tableDefs = [
    ["p1", "poker", "Freshman Meal Plan", "$5/$10", "Flop", 48, ["Maya", "Leo", "Sam"], [["Hootbot", true], ["Turing", false], ["Clippy", false]], 260],
    ["p2", "poker", "Unlimited Swipes", "$50/$100", "Pre-flop", 31, ["Jordan", "Priya"], [["Owlgorithm", true], ["Deep Bluff", true], ["Byte Me", false]], 150],
    ["p3", "poker", "Late Night Grill", "$10/$20", "Turn", 22, ["Marcus", "Noah"], [["GPTina", false], ["Neural Ned", true]], 480],
    ["b1", "blackjack", "Owl's Nest", "$10–$500", "Place bets", 57, ["Zoe", "Hana", "Devin"], [["Hootbot", false]], 0],
    ["b2", "blackjack", "High Limit", "$100–$5,000", "Playing", 19, ["Elena"], [["Turing", false], ["HAL 9001", false]], 0],
  ];

  const ids = new Map(humans.map(([name], i) => [name, `h${i + 1}`]));
  const tables = tableDefs.map(([id, game, name, stakes, stage, handId, hs, bots, pot]) => {
    const poker = game === "poker";
    const seats = [
      ...hs.map((n, i) => ({ seat: i, playerId: ids.get(n), name: n, kind: "human", stack: poker ? 900 + i * 210 : null, bet: poker ? 20 : 50, status: poker ? "active" : "betting", aiCapable: false, botMode: null, botOverride: null, connected: true, lastAction: poker ? "call" : null })),
      ...bots.map(([n, llm], i) => ({ seat: hs.length + i, playerId: `${id}-bot${i}`, name: n, kind: "bot", stack: poker ? 600 + i * 140 : null, bet: poker ? 20 : 50, status: poker ? "active" : "playing", aiCapable: poker, botMode: poker ? (llm ? "llm" : "script") : null, botOverride: null, connected: true, lastAction: poker ? "check" : null })),
    ];
    const chips = poker ? seats.reduce((s, x) => s + (x.stack ?? 0) + x.bet, 0) + pot : seats.reduce((s, x) => s + x.bet, 0);
    return {
      id, game, name, stakes, stage, handId, closing: false,
      humans: hs.length, bots: bots.length, aiBots: bots.filter((b) => b[1] && poker).length, waiting: 0,
      chips, pot, settings: { maxBots: poker ? 4 : 3, maxAi: poker ? 2 : null }, seats,
    };
  });

  const seatedAt = new Map();
  for (const t of tables) for (const s of t.seats) if (s.kind === "human") seatedAt.set(s.name, { t, s });
  const players = humans.map(([name, total]) => {
    const at = seatedAt.get(name);
    const atTable = at && at.t.game === "poker" ? (at.s.stack ?? 0) + at.s.bet : 0;
    return {
      id: ids.get(name), name, online: true, bankroll: total - atTable, atTable, total,
      table: at ? { id: at.t.id, name: at.t.name, game: at.t.game } : null,
      banned: null, timeout: null, tableTimeouts: 0,
    };
  });

  const bankrolls = players.reduce((s, p) => s + p.bankroll, 0);
  const onPokerTables = tables.filter((t) => t.game === "poker").reduce((s, t) => s + t.chips, 0);
  const onBlackjackTables = tables.filter((t) => t.game === "blackjack").reduce((s, t) => s + t.chips, 0);
  const expected = 1_000_000 + players.length * START;
  const house = expected - bankrolls - onPokerTables - onBlackjackTables;

  // AI decisions, newest first.
  const decisionPlan = [
    ["Hootbot", "Freshman Meal Plan", "call", 2380], ["Owlgorithm", "Unlimited Swipes", "raise to $300", 3110],
    ["Neural Ned", "Late Night Grill", "check", 2050], ["Deep Bluff", "Unlimited Swipes", "fold", 2640],
    ["Hootbot", "Freshman Meal Plan", "raise to $40", 2910], ["Owlgorithm", "Unlimited Swipes", "call", 2270],
    ["Neural Ned", "Late Night Grill", "call", 1980], ["Deep Bluff", "Unlimited Swipes", "check", 2430],
    ["Hootbot", "Freshman Meal Plan", "fold", 2190], ["Neural Ned", "Late Night Grill", "raise to $90", 3520],
  ];
  const recent = [];
  for (let i = 0; i < 64; i++) {
    const [bot, table, action, ms] = decisionPlan[i % decisionPlan.length];
    const fallback = i === 7 || i === 41 ? "timeout" : null;
    recent.push({ at: now - i * 9_000, table, bot, handId: 48 - Math.floor(i / 4), action: fallback ? "check" : action, ms: fallback ? 15_000 : ms + ((i * 137) % 600), costUsd: fallback ? null : 0.0006, fallback });
  }
  const calls = 214;
  const llm = {
    available: true, model: "claude-haiku-5-5", calls, fallbacks: 5, fallbackReasons: { timeout: 4, "unrecognized action": 1 },
    avgMs: 2640, p95Ms: 4380, totalCostUsd: 0.1284, recent,
  };

  const handLines = [
    ["p1", "Freshman Meal Plan", "Hand #47 · pot $340 · Maya won $170 (Two Pair)"],
    ["b1", "Owl's Nest", "Round #56 · dealer bust (24) · Zoe +$50, Hana +$100, Devin +$25"],
    ["p2", "Unlimited Swipes", "Hand #30 · pot $1,200 · Jordan won $600 (Straight)"],
    ["p3", "Late Night Grill", "Hand #21 · pot $180 · Owlgorithm won $90"],
    ["b2", "High Limit", "Round #18 · dealer 20 · Elena −$200"],
    ["p1", "Freshman Meal Plan", "Hand #46 · pot $90 · Leo won $45"],
  ];
  const log = handLines.map(([tid, name, summary], i) => ({
    id: 900 - i, at: now - i * 41_000, kind: "hand", game: tid.startsWith("p") ? "poker" : "blackjack",
    table: { id: tid, name }, summary, players: [],
  }));

  // 15 minutes of "players online" history, one point every 5 s.
  const history = [];
  for (let i = 179; i >= 0; i--) {
    const t = (179 - i) / 179;
    const online = Math.round(2 + 10 * (1 - Math.pow(1 - t, 2)));
    history.push({ at: now - i * 5_000, online: Math.max(1, Math.min(12, online)), atTables: Math.max(0, Math.min(11, online - 1)) });
  }

  return {
    snapshot: {
      at: now,
      totals: {
        bankrolls, house, onPokerTables, onBlackjackTables, total: expected, expected, conserved: true,
        playersKnown: players.length, playersOnline: players.length, playersAtTables: seatedAt.size, banned: 0,
        pokerTables: 3, blackjackTables: 2,
      },
      tables, players, timeouts: [], llm,
    },
    log,
    history,
    network: { addresses: [], clientPort: 5173 },
  };
})();
