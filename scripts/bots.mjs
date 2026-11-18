// End-to-end smoke test: N socket clients sit at one table and play random legal actions.
// Usage: node scripts/bots.mjs [serverUrl] [hands] [clients]
// Checks: bots are replaced at the gap, hands complete, and no client ever sees another's hole cards.
import { io } from "socket.io-client";

const url = process.argv[2] ?? "http://localhost:3000";
const handsWanted = Number(process.argv[3] ?? 5);
const clientCount = Number(process.argv[4] ?? 3);
const fail = (msg) => {
  console.error(`FAIL: ${msg}`);
  process.exit(1);
};

const connect = (name) =>
  new Promise((resolve) => {
    const socket = io(url, { auth: { token: `smoke-${name}-${Date.now()}` }, transports: ["websocket"] });
    socket.on("connect", () => socket.emit("identify", name, (r) => (r.ok ? resolve(socket) : fail(r.error))));
  });

const clients = await Promise.all(Array.from({ length: clientCount }, (_, i) => connect(`smoke${i + 1}`)));

const rooms = await new Promise((resolve) => {
  clients[0].once("poker:rooms", resolve);
  clients[0].emit("poker:subscribe-rooms");
});
const room = rooms.find((r) => r.name === "Freshman Table") ?? rooms[0];
console.log(`Joining "${room.name}" (${room.smallBlind}/${room.bigBlind}) with ${clientCount} clients`);

let maxHand = 0;
let firstHand = null;
let checkedBots = false;
let rebuys = 0;
const joined = new Set();
const rebuying = new Set();
const seen = new Map(); // handId -> Map(playerSeat -> holeCards key)

clients.forEach((socket, index) => {
  socket.on("poker:state", ({ view }) => {
    // Privacy: other seats only ever show cards via revealedCards, and only between hands.
    for (const seat of view.seats) {
      if (!seat || seat.seat === view.mySeat) continue;
      if (seat.revealedCards && view.phase !== "idle") fail(`client ${index} saw seat ${seat.seat}'s cards mid-hand`);
    }
    if (view.myHoleCards.length) {
      const hand = seen.get(view.handId) ?? new Map();
      hand.set(view.mySeat, view.myHoleCards.map((c) => c.rank + c.suit).join());
      seen.set(view.handId, hand);
    }

    if (firstHand === null && view.handId > 0 && view.mySeat !== null) firstHand = view.handId;
    maxHand = Math.max(maxHand, view.handId);

    if (!checkedBots && view.mySeat !== null && view.phase !== "idle") {
      const humans = view.seats.filter((s) => s?.kind === "human").length;
      const bots = view.seats.filter((s) => s?.kind === "bot").length;
      if (humans === clientCount) {
        checkedBots = true;
        const expected = Math.max(0, 4 - clientCount);
        console.log(`Seated: ${humans} humans + ${bots} bots (expected ${expected} bots)`);
        if (bots !== expected) fail(`expected ${expected} bots, saw ${bots}`);
      }
    }

    // Between hands, ready up like a real player would.
    const me = view.mySeat === null ? null : view.seats[view.mySeat];
    if (view.rebuy && !rebuying.has(socket)) {
      // Busted: buy back in (which also readies us) so the run keeps going.
      rebuying.add(socket);
      rebuys += 1;
      socket.emit("poker:rebuy", view.rebuy.min, (r) => {
        rebuying.delete(socket);
        if (!r.ok) fail(`rebuy failed: ${r.error}`);
      });
    } else if (me?.ready === false && !view.rebuy) setTimeout(() => socket.emit("poker:ready"), 100);

    const legal = view.myLegalActions;
    if (!legal) return;
    setTimeout(() => {
      const roll = Math.random();
      let action = { type: "call" };
      if (roll < 0.15 && !legal.canCheck) action = { type: "fold" };
      else if (roll < 0.35 && legal.canRaise) action = { type: "raise", to: legal.minRaiseTo };
      socket.emit("poker:act", action);
    }, 50);
  });
  socket.on("error-message", (m) => console.warn(`client ${index}: ${m}`));
  socket.on("session", (session) => {
    if (session.roomId === null && joined.has(socket)) fail(`client ${index} was removed from the table`);
  });
});

for (const socket of clients) {
  await new Promise((resolve) =>
    socket.emit("poker:join", { roomId: room.id, buyIn: room.bigBlind * 50 }, (r) => (r.ok ? resolve() : fail(r.error))),
  );
  joined.add(socket);
}

const started = Date.now();
await new Promise((resolve) => {
  const timer = setInterval(() => {
    if (firstHand !== null && maxHand >= firstHand + handsWanted) {
      clearInterval(timer);
      resolve();
    }
    if (Date.now() - started > 240_000) fail(`only reached hand ${maxHand} (first ${firstHand}) in 4 minutes`);
  }, 250);
});

// Two clients must never be dealt the same card in one hand.
for (const [handId, hands] of seen) {
  const cards = [...hands.values()].flatMap((h) => h.split(","));
  if (new Set(cards).size !== cards.length) fail(`duplicate hole cards in hand ${handId}`);
}

if (!checkedBots) fail("never observed all clients seated");
console.log(`PASS (${rebuys} rebuys): played ${maxHand - firstHand} hands in ${Math.round((Date.now() - started) / 1000)}s, no hole-card leaks`);
joined.clear();
for (const socket of clients) socket.emit("poker:leave");
setTimeout(() => process.exit(0), 300);
