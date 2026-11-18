// End-to-end blackjack smoke test: N socket clients join one table, bet on random spots and play random legal actions.
// Usage: node scripts/blackjack-bots.mjs [serverUrl] [rounds] [clients]
// Checks: rounds complete, bots only ever sit in spots 1-3, the dealer's hole card never leaks before it's revealed,
// and nobody holds more than 3 spots.
import { io } from "socket.io-client";

const url = process.argv[2] ?? "http://localhost:3000";
const roundsWanted = Number(process.argv[3] ?? 6);
const clientCount = Number(process.argv[4] ?? 3);
const fail = (msg) => {
  console.error(`FAIL: ${msg}`);
  process.exit(1);
};
setTimeout(() => fail("timed out"), 60_000 + roundsWanted * 30_000).unref();

// Names are reserved per server run, so every run uses fresh ones.
const RUN = Date.now().toString(36).slice(-4);
const connect = (name) =>
  new Promise((resolve) => {
    const socket = io(url, { auth: { token: `bj-smoke-${name}-${Date.now()}` }, transports: ["websocket"] });
    socket.on("connect", () => socket.emit("identify", { name, careerPublic: true }, (r) => (r.ok ? resolve(socket) : fail(r.error))));
  });

const clients = await Promise.all(Array.from({ length: clientCount }, (_, i) => connect(`bj${i + 1}-${RUN}`)));
const rooms = await new Promise((resolve) => {
  clients[0].once("blackjack:rooms", resolve);
  clients[0].emit("blackjack:subscribe-rooms");
});
const room = rooms.find((r) => r.name === "Owl's Nest") ?? rooms[0];
console.log(`Joining "${room.name}" (${room.minBet}-${room.maxBet}) with ${clientCount} clients`);

let firstRound = null;
let lastRound = 0;
let tookBotSpot = false;
const bettingSeen = new Map();

clients.forEach((socket, index) => {
  socket.on("blackjack:state", ({ view, events }) => {
    // Bots only in the first three spots.
    view.spots.forEach((s, i) => {
      if (s?.kind === "bot" && i >= 3) fail(`bot in spot ${i + 1}`);
    });
    if (view.mySpots.length > 3) fail(`client ${index} holds ${view.mySpots.length} spots`);
    // The hole card is dealt face down and stays hidden until the dealer turns it over.
    const dealtToDealer = events.filter((e) => e.type === "cardDealt" && e.target === "dealer");
    if (events.some((e) => e.type === "roundStarted") && dealtToDealer[1]?.card) fail("hole card dealt face up");
    // While anyone can still act, the hole card must be hidden (the dealer only plays once everyone is done).
    if ((view.stage === "insurance" || view.stage === "playing") && view.dealer.cards.length >= 2 && view.dealer.cards[1] !== null) {
      fail("hole card visible before the dealer's turn");
    }
    if (firstRound === null && view.roundId > 0) firstRound = view.roundId;
    lastRound = Math.max(lastRound, view.roundId);

    if (view.stage === "betting" && bettingSeen.get(index) !== view.roundId) {
      bettingSeen.set(index, view.roundId);
      // Client 0 takes a bot spot (1-3); everyone also bets 1-2 open spots.
      const wants = index === 0 ? [0, 4] : [3 + ((index * 2) % 4), 3 + ((index * 2 + 1) % 4)];
      let pending = wants.length;
      for (const spot of wants) {
        const amount = view.minBet * (1 + Math.floor(Math.random() * 5));
        socket.emit("blackjack:bet", { spot, amount }, (r) => {
          if (r.ok && spot < 3) tookBotSpot = true;
          pending -= 1;
          if (pending === 0) socket.emit("blackjack:ready");
        });
      }
    }
    if (view.myInsurance) socket.emit("blackjack:insurance", Math.random() < 0.5);
    if (view.myLegal) {
      const options = Object.entries(view.myLegal).filter(([, ok]) => ok).map(([a]) => a);
      setTimeout(() => socket.emit("blackjack:act", options[Math.floor(Math.random() * options.length)]), 50);
    }
  });
});

for (const socket of clients) {
  await new Promise((resolve) => socket.emit("blackjack:join", { roomId: room.id }, (r) => (r.ok ? resolve() : fail(r.error))));
}

while (firstRound === null || lastRound - firstRound < roundsWanted) await new Promise((r) => setTimeout(r, 500));
if (!tookBotSpot) fail("never took over a bot's spot");
for (const socket of clients) socket.emit("blackjack:leave");
await new Promise((r) => setTimeout(r, 500));
console.log(`PASS: ${lastRound - firstRound} rounds, bot spot taken over, no hole-card leaks`);
process.exit(0);
