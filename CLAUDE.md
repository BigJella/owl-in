# OWL IN — KSU Card Club

A multiplayer card-game website built for the **KSU AI Club Hackathon 2026**. Players join from any device on the LAN,
pick a name, and play Texas Hold'em and Blackjack against each other **and against AI bot players** for **KSU Dining Dollars**
(play money). AI is the hackathon's theme: bots are first-class players, deterministic today and LLM-driven next.

> This file is the onboarding doc for new Claude Code sessions. Keep it current when you change rules,
> architecture, or finish roadmap items.

---

## Project goals

1. **AI players are the star.** Bots sit at every table, behave believably, and can be swapped from a rule-based
   strategy to an LLM without touching game code. Bots only ever see what a human in their seat would see.
2. **Real multiplayer poker** that several people on the same network can play at once, from laptops or phones.
3. **Polished, animated table** (PixiJS + gsap). Every state change is animated, and the info a player needs is always on screen.
   See **Design language** below. It's a firm user requirement.
4. **Fair, server-authoritative game.** The engine is pure and tested; the server never leaks hidden cards;
   chips are conserved (bankrolls + house bank + tables never change in total).
5. **Light humor, used sparingly.** The currency is "Dining Dollars" ($), the tables are "Freshman Meal Plan" and "Unlimited Swipes",
   and a bust says "Your meal plan is empty". **Don't add more school jokes.** The user found heavier use unfunny
   (no "Ramen Ronnie" bot names, no long joke paragraphs, no "go grab a snack").

---

## Design language (user requirement)

- **KSU black & gold.** Gold is Pantone 1235 C = `#FFB81C`. All colors are tokens in `:root` of `apps/client/src/styles.css`
  (`--gold`, `--bg`, `--surface`, `--line`, `--text`, `--muted`, `--danger`, ...). The Pixi canvas mirrors them as constants
  at the top of `PokerRenderer.ts` (`GOLD`, `INK`, `SURFACE`, `LINE`, ...).
- **Sharp and flat.** Square corners (radius 0; 2px max on tiny things), 1px rules for structure, solid fills.
  **No glows, gradients, blur or soft shadows.** The user explicitly dislikes "tech-bro glow".
- **Gold is an accent, used sparingly.** Structural lines are neutral (`--line`). Gold rules are thin (1px) and reserved
  for the table strip's top and bottom rules and the lobby table header. The nav underline and sidebar edges are neutral.
  The user found several thick gold lines stacked at the top of the page jarring.
- **Type:** Oswald (condensed, uppercase, letter-spaced) for headings, labels, numbers and buttons; Inter for body text.
  Both are bundled via `@fontsource` (works offline on LAN). Pixi waits for Oswald to load before drawing.
- **Nav while seated:** the links (and the logo) look disabled but stay clickable; a click shows a small one-line popover
  centred under that link's text, nudged back on screen at the edges ("You must leave your current table first.", 12px, gold left rule, × to dismiss, gone after 4s or when
  you leave the table). Keep it minimal.
- Buttons: `.primary` (solid gold, black text), `.secondary` (black, gray border → gold on hover), `.primary.danger`.
  Tags: `.tag` / `.tag.gold` / `.tag.danger` (square, outlined).
- **One content width.** Page content (headers with their right-side button, toolbars, lists, panels) is capped at
  `--content-w` (1180px) so everything shares one right edge on wide screens. Use the token, never a new max-width.
- **Layout stability is a requirement.** The user notices and dislikes UI that shifts as values change. Use fixed
  widths/heights, `font-variant-numeric: tabular-nums`, and anchored regions so that changing numbers, names and controls
  coming and going never move other elements.
- **Table screen layout** (`apps/client/src/pages/PokerTablePage.tsx`):
  - **`TableStrip`** sits across the top between two gold rules, with cells split by vertical bars. It shows **only
    table-wide info**: name, blinds, hand #, stage, pot (with a main/side breakdown), dealer, SB/BB, and who's acting
    plus their clock (or "thinking" for bots, or the between-hands status). Every player must see the same strip, so
    never put personal data in it. The cells use **fixed proportional grid columns** (not content-sized), so the strip
    never shifts. Overflowing text is cut off with an ellipsis, with a `title` tooltip showing the full value.
  - **Player sidebar** (right, 340px): everything personal, split in two.
    - **`.panel-info` (top, static):** name with Folded / All-in / Last hand tags **on the same row**, Stack / In pot,
      and the `ClockBlock`. The clock block has a constant height (label, seconds, a one-line note). Between your turns it
      shows your clock with a greyed **"+20s next turn"** refill preview (or "Clock full"). Its note is
      "Auto check / fold at 0".
    - **`.panel-controls` (bottom, anchored):** "Waiting for X…", the ready-up panel, the betting controls (`ActionBar`,
      vertical: Fold/Check/Call, presets, slider, typed amount + Raise), and the single Cash out / Back to lobby button.
    - Below 900px the sidebar stacks under the table, controls first.
  - Buttons whose label has a changing amount (`Reload $X`, `Sit down with $X`) use `.amount-btn` (tabular digits;
    the reload button is a fixed 172px).
  - Dialogs: Leave (30-min lockout called out), Rebuy ("Your meal plan is empty", 30s), plus a cashed-out result view.
    Don't add redundant warnings when the clock block already shows the state (e.g. no separate "clock running" text).
- **Canvas** (`PokerRenderer.ts`, design space 1200×780, center `CX,CY`):
  - The felt is black with a gold rail. The table name and blinds are **not** drawn on the canvas (they're in the strip).
  - **Seats are spread evenly** around the table based on who's actually seated, in seat order, with your seat at
    bottom-center (`layoutSeats`). The layout recalculates between hands whenever occupancy changes, *before* the next
    animation is built.
  - **Labels avoid the cards:**
    - bottom seats: action, then status/clock, below the plate
    - side seats: status/clock above, action below
    - **top seats**: action, status/clock and the showdown hand-name pill are stacked **above** the plate
  - **Pot:** dead center pre-flop. Once the board is out, it sits above the board and the pot + board group is centered.
    Chip flights target the pot's current position (`potPos`).

---

## Stack & commands

TypeScript monorepo with npm workspaces. Node 26, npm 12, Windows (bash + PowerShell available).

| Command | What it does |
|---|---|
| `npm install` | Install all workspaces |
| `npm run dev` | Server (`:3000`, tsx watch) + client (Vite `:5173`, LAN-exposed) |
| `npm run typecheck` | `tsc --noEmit` in every workspace (must be clean) |
| `npm test` | Vitest across the repo (engine + server room tests) |
| `npm run build` | Vite production build of the client (a >500 kB chunk warning from PixiJS is expected) |
| `node scripts/bots.mjs [url] [hands] [clients]` | End-to-end smoke test: N socket clients play real hands; checks bot replacement, no hole-card leaks, rebuys |
| `node scripts/blackjack-bots.mjs [url] [rounds] [clients]` | Blackjack e2e smoke: clients bet (one takes a bot's spot) and play random legal actions; checks bots only in spots 1–3, ≤3 spots each, no dealer hole-card leak |
| `OWL_LLM_BOTS=2 npm run dev` | Same, with 2 of each table's bots driven by Claude (see **LLM bots** below); overrides `.env` for one run |
| `node scripts/generate-placeholder-cards.mjs` | Regenerates placeholder card/chip SVGs into `apps/client/public/assets` |

- **Server settings live in `apps/server/.env`** (git-ignored; copy `apps/server/.env.example`). The server's `dev` / `start`
  scripts load it with `--env-file-if-exists`; real environment variables win. Long term, machine settings (CLI path,
  timeout) stay in `.env` and game settings (LLM bots per table, per-bot mode) move to the database, edited from the admin panel.
- Server runs TypeScript directly via `tsx` (no build step). Workspace packages export raw `.ts` (`"exports": "./src/index.ts"`).
- LAN play: open `http://<pc-ip>:5173`. The client connects to `http://<same-host>:3000` (override with `VITE_SERVER_URL`).
  Windows Firewall may prompt for Node.
- **Before finishing work:** `npm run typecheck && npm test && npm run build`, and for gameplay changes run `scripts/bots.mjs`
  (poker) and/or `scripts/blackjack-bots.mjs` against `npm run dev`. For UI changes, check in a browser at desktop (1280px) **and** phone (390px) widths.
  Previous sessions drove headless Chrome (`C:/Program Files/Google/Chrome/Application/chrome.exe`) with `puppeteer-core`
  installed in the session scratchpad (not a project dependency). Gotchas:
  - Use a separate `browser.createBrowserContext()` per simulated player (localStorage holds the session token and name).
  - `innerText` is affected by CSS `text-transform: uppercase`, so match button and label text case-insensitively.
  - Seat labels, cards and pot are drawn on the canvas: assert on DOM state (strip, sidebar, dialogs) or screenshots.
- Stop any dev server you started so ports 3000/5173 are free for the user.

---

## Repository layout

```
apps/
  client/                     React 19 + Vite + PixiJS 8 + gsap (player website)
    src/App.tsx               Screen routing: Name → Home → Poker lobby → Table; session + "left table" notice
    src/networking/socket.ts  Typed Socket.IO client; per-browser session token (localStorage) for seat reclaim
    src/networking/gameStore.ts   createGameStore(): buffers a game's state messages outside React (animations never drop events)
    src/networking/pokerStore.ts, blackjackStore.ts  The two stores built from it
    src/components/ClockBlock.tsx  ClockBlock + useNow, shared by both table pages
    src/components/ChipChart.tsx   Career chips-over-time chart (SVG, hover/keyboard tooltip)
    src/pages/                NamePage (name + Public/Private career), HomePage, PokerLobbyPage (sortable/filterable room list, buy-in/create dialogs),
                              CareerPage (stats panels, table history with expandable hands), LeaderboardPage,
                              BlackjackLobbyPage, BlackjackTablePage (strip; sidebar BetPanel / insurance / PlayPanel),
                              PokerTablePage (shared TableStrip; sidebar = static info top + controls bottom;
                              ClockBlock, ReadyPanel, RebuyDialog, LeaveDialog, cashed-out result view)
    src/game/poker/
      pixiApp.ts              ONE Pixi Application for the whole session (canvas is moved between pages; never destroyed)
      PokerScene.tsx          Mounts the shared canvas + creates a PokerRenderer per table visit
      PokerRenderer.ts        Imperative scene (black felt, gold rail): seats, cards, chips, pots; plays server events as gsap timelines,
                              then snaps to the authoritative view
      ActionBar.tsx           Fold / Check / Call / Raise (presets, slider, typed amount); laid out vertically in the sidebar
      assets.ts               Card/chip textures (public/assets/cards/{rank}{S|H|D|C}.svg + back.svg, chips/chip.svg)
    src/game/blackjack/
      BlackjackScene.tsx      Same shared-canvas pattern; spot clicks select the betting spot in the sidebar
      BlackjackRenderer.ts    Half-moon felt, dealer + shoe/discard tray, 7 betting boxes; animates events against a local model
  server/                     Express + Socket.IO, run with tsx
    src/index.ts              Wires registry, house bank, room manager, socket handlers
    src/networking/handlers/connectionHandler.ts  All socket events, zod-validated
    src/players/              Player (abstract) → HumanPlayer, BotPlayer; PlayerRegistry (token → human)
    src/ai/                   PokerStrategy interface, RuleBasedStrategy (deterministic), LlmStrategy (prompt + parse + fallback),
                              claudeCli (headless `claude -p` CompleteFn), llmConfig (OWL_LLM_* env vars);
                              BlackjackStrategy interface, BasicStrategy (6-deck S17 DAS LS chart)
    src/rooms/PokerRoom.ts    The table loop: turns, clocks, ready-up, bot seating/pacing, cash-outs, penalties, views
    src/rooms/RoomManager.ts  Create/list rooms, keeps ≥2 open, batches room-list pushes
    src/stats/                StatsStore interface + MemoryStatsStore (career totals, sessions, hand records),
                              pokerAttribution (net vs players / vs bots per hand), careerView (privacy, leaderboard)
    src/rooms/BlackjackRoom.ts  Blackjack loop: betting window, spot claims, bot fill (spots 1–3), insurance, turns, money
    src/rooms/BlackjackRoomManager.ts  Same as RoomManager for blackjack (seeds "Owl's Nest" $10 and "High Limit" $100)
    src/economy/HouseBank.ts  Source/sink for bot chips (keeps total chips constant)
packages/
  game-engine/                Pure rules: no React/Pixi/Express/Socket.IO imports
    src/cards/Deck.ts         createDeck, shuffle (injectable RNG)
    src/poker/PokerTable.ts   Hold'em state machine; returns PokerEvent[] from every mutation
    src/poker/pots.ts         Side-pot builder
    src/poker/evaluate.ts     pokersolver wrapper (has a local pokersolver.d.ts + triple-slash reference)
    src/blackjack/            Shoe (persistent multi-deck shoe, cut card, discard tray), hand helpers,
                              BlackjackTable state machine returning BlackjackEvent[] (like PokerTable)
  shared/                     Types + constants used by client and server
    src/poker.ts              Views (PokerTableView, PokerSeatView, PokerRoomSummary), constants, formatDD, describeAction, STAGE_LABEL
    src/blackjack.ts          BlackjackTableView/SpotView/RoomSummary, BJ_* constants and labels
    src/career.ts             PokerStats, BlackjackStats, TableSession, hand records, CareerView, LeaderboardRow
    src/events.ts             ClientToServerEvents / ServerToClientEvents (Socket.IO generics on both ends)
scripts/                      bots.mjs, blackjack-bots.mjs (e2e smokes), generate-placeholder-cards.mjs
```

---

## Architecture essentials

- **Server-authoritative.** The client only sends intents (`poker:act`, `poker:ready`, `poker:rebuy`, `poker:leave`, ...).
  The server validates them with zod and sends each human its own `PokerTableView`.
- **Privacy.** `PokerRoom.viewFor(playerId)` includes hole cards only for that player. Other players' cards appear only as
  `revealedCards` after a showdown. **Bots get the exact same per-seat view.** Never give a strategy more.
- **Events → animation.** Engine mutations return `PokerEvent[]` (handStarted, blindPosted, holeCardsDealt, playerActed,
  uncalledReturned, betsCollected, communityDealt, showdown, potAwarded, handEnded). These events contain no hidden information.
  The server sends `{ view, events, seq }`. The renderer animates the events, then calls `sync(view)`. When messages back up
  it speeds the timeline up, and it only jumps to the end once it's more than 3 messages behind.
- **Player abstraction.** On every turn the room calls `player.requestAction(view, abortSignal)` and races it against the clock.
  Humans resolve the promise from a socket message; bots resolve it from their strategy. Bots are asked **at turn start**
  and the answer is applied once their "thinking" pause is over (so an LLM call overlaps the pause).
- **One bot class, two modes.** `BotPlayer` holds a `script` (RuleBasedStrategy) and an `llm` (LlmStrategy) strategy and a
  mutable `mode: "script" | "llm"` (`BotMode` in shared). The mode is read per decision, so `PokerRoom.setBotMode` /
  `RoomManager.setBotMode(botId, mode)` (the hook for the future admin panel) switch a seated bot without re-seating it.
  `PokerSeatView.botMode` shows it to clients.
- **Hand action log.** `PokerTableView.handActions` lists every public betting action of the hand (blinds included, by street).
  Everyone gets the same log; it's what the LLM reads as "the action so far".
- **One Pixi app.** Creating and destroying a Pixi Application per page visit froze browsers (leaked WebGL contexts, plus a
  teardown-order crash). Keep using `getPixiApp()`.
- **pokerStore keeps the last state after `poker:left`.** This lets a cashed-out player watch their final hand.
  `App` calls `pokerStore.reset()` when they go back to the lobby.

---

## Game rules (agreed with the user, keep these)

**Seating & bots**
- 8 seats max. Bots fill each table up to **4** players (`bots = max(0, 4 − humans)`).
- Bots buy in for **60 BB** from the HouseBank. A bot below 1 BB is re-stacked between hands.
- **Bot stack cap:** at tables with **no humans** (seated or waiting), bot stacks above **200 BB** go back to the house
  between hands. The cap never applies while any human is present, so nobody's totals change under them.
- A joining human waits for the next hand. At the gap between hands they **replace the bot whose stack is closest to their buy-in**.
- At least **2 rooms** are always open. The server seeds "Freshman Meal Plan" ($5/$10) and "Unlimited Swipes" ($50/$100).
  An empty extra room closes at its next gap.
- Bot-only rooms play **1 hand per minute**.

**LLM bots (agreed with the user, keep these)**
- Two bot types in one class: **script** (deterministic rule-based) and **LLM** (Claude). Switchable per bot (admin panel later).
- An LLM decision runs the local **Claude Code CLI headlessly**, one process per decision: `claude -p --model <model>
  --output-format json --json-schema <action schema> --tools "" --strict-mcp-config --setting-sources "" --no-session-persistence`.
  The prompt goes on stdin; the action comes back in `structured_output` (`{type, to?}`). ~2–6s with Haiku, ~$0.0006 per call.
- The prompt is **only** what the seat sees: own hole cards, board, each player's stack / bet / in-pot / status / position,
  and `handActions`. **No long-term memory and no reasoning text** (token cost); both are possible later.
- Any failure (CLI missing, timeout, bad JSON) falls back to the script for that decision; `legalize()` clamps every answer.
  The server logs one `[llm]` line per decision (latency, fallback reason).
- **Env vars:** `OWL_LLM_BOTS` = how many of each table's bots are seated in LLM mode (`0`–`4` or `all`, **default 0**),
  `OWL_LLM_MODEL` (default `claude-haiku-5-5`), `OWL_LLM_TIMEOUT_MS` (15000), `OWL_CLAUDE_BIN` (`claude`).
- **LLM bots play by script at tables with no humans** (seated or waiting), so bot-only rooms spend no tokens.
- UI: LLM bots' seat plates carry a gold **AI** tag (script bots: grey **BOT**); the strip's "To act" cell shows a small AI tag.

**Money**
- Every name gets **$10,000 Dining Dollars**, held in server memory only (a restart resets everything).
- Buy-in is 20–100 BB, capped by bankroll. The High Roller badge appears when the big blind is ≥ $100 (based on stakes, not chips on the table).
- Display every amount with `formatDD` (`$1,234`).

**Hand flow**
- The button moves each hand. Heads-up, the button posts the SB and acts first preflop.
  Only the designated SB and BB post blinds. Folded players can legitimately show "in pot $10" if they called first.
- Raises: the minimum raise is the size of the last raise, all-in is always allowed, and a short all-in doesn't reopen betting.
  Side pots are layered by contribution. In a split pot, the odd chip goes to the first winner left of the button.
- **Clock (humans only):** +20s each turn, capped at 120s; it starts at 0. At 0 the player auto-checks, or folds if checking isn't possible.
  Bots have no visible clock: they "think" for 1.5–3s (plus 1.5s after a deal so the animation finishes), with a hidden 30s safety cap.

**Between hands (only at tables with humans)**
- Everyone sees the result. Seated, connected humans must **ready up**. The grace period is 5s **plus** an estimated
  end-of-hand animation time (`animationAllowanceMs`). After that, a not-ready player's clock runs, and at 0 they're auto-readied.
  The hand deals 1s after everyone is ready.
- **Busted** (stack $0): the player can't ready up. A dialog ("Your meal plan is empty") gives **30s**, independent of the
  clock, to **Reload** (which also readies them) or **Cash out**. If they don't choose, they're removed.

**Leaving**
- The leave button always opens a dialog that states the **30-minute rejoin lockout** for that table.
- Between hands, or if you weren't dealt in: you leave immediately.
- Mid-hand: the cash-out is **queued and irreversible**. You play the hand out, others see **LAST HAND** on your seat, and you're
  removed when it ends. You still see the final result with a "Back to lobby" button. Queued cash-out seats count as free,
  so outsiders can join a "full" table.
- Every removal (cash out, bust-and-leave, rebuy timeout, kicked while away) carries the **30-min penalty for that table**.
  Leaving the waiting list before you've been dealt in is free.
- Disconnects: the seat is held while the clock runs in real time, and turns auto check/fold. When the clock hits 0 you're
  kicked at the next gap. Reconnecting with the same browser (token) reclaims the seat.

**Blackjack (agreed with the user, keep these)**
- 7 spots. Spot 1 is first base (dealer's left = right side of the screen) and acts first.
- A player may bet on up to **3** spots. Bots **only ever sit in spots 1–3**, and only in free ones (filled at the start of
  each betting round). Betting on a bot's spot takes it over immediately (the bot's bet goes back to the house).
- **6-deck shoe, dealer stands on all 17s, blackjack pays 3:2**, double on any two (also after split), split up to 4 hands,
  split aces once with one card each (21 there isn't blackjack), insurance 2:1 on a dealer ace, dealer peeks on A/10,
  **late surrender** (first decision only, not after a split). 21 auto-stands.
- **Card counting is secretly supposed to work.** The shoe persists across rounds and is only reshuffled between rounds after the
  cut card (70–80% penetration); one card is burned after each shuffle; every card (including the hole card at the end) is shown
  face up; the canvas shows the shoe and discard-tray levels. The server only sends those levels **to the nearest quarter
  deck** (never exact card counts), and the strip only says **Fresh / Early / Middle / Late**: the user found an exact
  "decks left" too easy. Limits are min to
  **50× min**, with no penalty for spreading. **Never show the count, and don't add continuous shuffling or a bet-spread penalty.**
  No hint copy (the user didn't want one).
- Bets come straight from the bankroll (no buy-in). The HouseBank is the dealer: stakes go to the house at settlement and it pays
  payouts. Bot stakes come from and return to the house. `BlackjackRoom.onTable()` + bankrolls + house is conserved.
- Rounds: a **15s betting window** (closes early once every connected human holding a spot has pressed Deal). Players who had
  a bet **last round** and still hold a spot can keep betting past the window **on their clock** (it drains, like poker's
  ready-up; Deal stops it; at 0 bets close). New players get only the window. Then the deal,
  an 8s insurance window when the dealer shows an ace, then turns. Human turns use a clock with **blackjack-specific refills**:
  **+30s when the turn passes to you** from someone else, **+5s for each further decision** you make in a row (hits, your next
  hand or spot), **capped at 60s**, auto-stand at 0 (`BJ_TURN_REFILL_MS`, `BJ_DECISION_REFILL_MS`, `BJ_TIME_BANK_MAX_MS`). Bots think 0.8–1.6s. Results stay up 3s (after their animation),
  then cards are swept to the tray. Bot-only tables deal one round per 20s.
- **Blackjack table margin:** the renderer fits the 1200×720 design plus a 28px margin on every side (`BlackjackRenderer.MARGIN`), so the rail never touches the canvas edge.
- **Blackjack felt text:** small "SHOE" / "DISCARD" labels and "DEALER" are always shown; "BLACKJACK PAYS 3 TO 2" and
  "DEALER STANDS ON ALL 17S · INSURANCE PAYS 2 TO 1" only during the betting round (hidden as soon as cards are dealt).
  The acting player is shown by the spot box, name plate and clock; **no outline around the hand's cards** (it moved as
  cards were added).
- Spots you didn't bet on are released when betting closes. Rebet repeats last round's bets.
- **Giving up a spot** (`blackjack:leave-spot`, e.g. to scale down so others can sit): during betting it's immediate and
  the bet is refunded ("Leave spot" in the bet panel); mid-round the spot plays out and is freed when the round ends
  (the "Free a spot after this round" row, shown when you hold 2+ spots, one equal column per spot; the seat shows
  LAST ROUND). A spot given up mid-round is **blocked for you for the next betting round** (shown "Freed", Rebet skips
  it) so someone else can take it; it opens to you again after that.
- Bet panel: selecting a spot you've bet on puts its bet in the amount box / slider, and "Change $X" stays disabled
  while the amount equals that bet.
- The label under each seat after a round is the spot's **net** for the round across all its hands and insurance:
  "Won $10" (profit, not payout), "Lost $20", "Push", "Blackjack · won $15".
- Leaving: between rounds it's immediate (pre-deal bets refunded). With hands in play it's queued ("Leave after this round"
  dialog) and you're removed when the round ends. **No rejoin lockout in blackjack.** Disconnected players' hands auto-stand;
  after 60s away they're removed at the next betting round.
- One table at a time across both games (`HumanPlayer.game` + `roomId`; `Session.game` tells the client which page to show).

**Career & leaderboard (agreed with the user, keep these)**
- **Stored in memory only** (`MemoryStatsStore`), like bankrolls: a restart wipes both. Rooms report to the `StatsStore`
  interface, so a SQLite implementation can replace it in one place. Hand records are capped at 5,000 per player;
  totals never are.
- Recorded per player: **table sessions** (game, table, stakes, joined/left, poker buy-in incl. rebuys → cash-out,
  hands, wagered, net, end reason: left / busted / removed / table closed) and **every hand**: poker (hole cards, board,
  position, last action, showdown hand, pot, wagered, net, result, net vs players / vs bots) and blackjack rounds (each
  spot's hands, cards, bet, doubled/split, result, payout, insurance, dealer cards).
- **Rates:** poker = won / split pot / lost / folded (+ showdowns won). Blackjack (per hand) = won / push / lost, plus
  blackjack, bust, double and surrender % (per hand) and split and insurance % (per round). Blackjack money is vs the house.
- **Vs players / vs bots (poker):** each hand's losses are spread over its winners in proportion to their profit
  (`pokerAttribution.ts`); the two always add up to the hand's net.
- **Chips-over-time chart** (`components/ChipChart.tsx`, plain SVG, between the career totals and the game panels):
  total Dining Dollars after every hand (`CareerView.chipHistory`: starting bankroll + running net, kept by the store,
  last 5,000 points). One gold 2px line; each hand is a node, the game told apart by **shape + fill, not a second hue**
  (poker = solid gold square, blackjack = hollow gold diamond; KSU gold fails the categorical lightness band, so no
  gold-vs-other-colour pair). $10,000 start reference line, end label, crosshair + tooltip that also works with
  arrow keys / Home / End, Last 50 / Last 200 / All once there are 50+ hands, nodes hidden below 6px per hand.
- **Leaderboard ranks by Dining Dollars only** (bankroll + chips at a poker table). Everyone who picked a name this
  server run is listed.
- **Privacy:** chosen on the name page (Public / Private, saved in localStorage `owl-in:career-public`). Changeable on
  your own career page. Private careers still appear on the leaderboard (name + money) but can't be opened. On someone
  else's career, poker hole cards are hidden unless they were shown at a showdown.

**Identity (agreed with the user, keep these)**
- Identity belongs to the **browser token** (localStorage `owl-in:token`, 32 hex chars; a malformed one is replaced).
- **Verified with the server on every load / reconnect.** On connect the server attaches a known token's socket (so a
  refresh keeps a seat) but **never sends `session`** until `identify` passes; the client also ignores `session` pushes
  until then. `identify({ name, careerPublic })` checks, in order: token (`code: "token"` → client makes a new token and
  reconnects), name (`code: "name"`: invalid or taken → editable name page with the error), privacy (`code: "careerPublic"`:
  missing/garbage → name shown **locked and greyed**, only Public / Private asked, nothing preselected).
- **Names are unique per server run**, case-insensitive: a name belongs to the first token that claims it, even while
  that player is offline (`PlayerRegistry.nameTaken`). Renaming frees your old name. A restart clears all names.
- **Renaming:** click your name in the navbar (away from tables only; while seated or waiting for a seat it shows the
  "leave your table first" hint, and the server's `rename` refuses with `code: "seated"`). A small popover in the nav-hint
  style with an input + Save; `name:check` runs as you type, and a taken or invalid name turns the box red with the
  reason. Enter saves, Escape / × / click outside cancels. The new name is saved to localStorage.

---

## Implementation checklist

**Done**
- [x] Monorepo, per-workspace tsconfigs, typed Socket.IO events, LAN-ready Vite
- [x] Pure Hold'em engine: blinds/button, betting rules, side pots, showdown via pokersolver, chip-conservation fuzz test
- [x] Player abstraction (Human/Bot), RuleBasedStrategy, LlmStrategy stub with fallback
- [x] Rooms: bot fill to 4, closest-stack replacement, ≥2 rooms, bot-only pacing, bot stack cap (no-human tables only)
- [x] Player clock, disconnect hold/drain/kick, seat reclaim on refresh
- [x] Ready-up between hands with grace + drain + animation allowance
- [x] Bust → 30s reload-or-leave dialog; rejoin penalties; queued irreversible cash-out with LAST HAND tag and result view
- [x] Lobby: name entry, home, room list sortable by every column + "Open seats only", create table, buy-in dialog, stage column
- [x] Pixi table: dealing/betting/collect/flip/showdown/payout animations; D/SB/BB markers; "in pot", last action,
      "thinking…", pot + side pots, hand-name pills; live clocks in seconds
- [x] Even seat spacing by occupancy; pot centered (moves above the board post-flop); top-seat labels above the plate
- [x] Action bar with presets, slider, typed amount (Enter submits); phone layout (controls first, Fold/Check visible)
- [x] Dining Dollars currency + light humor
- [x] Black & gold sharp/flat redesign site-wide; black felt
- [x] Shared fixed-grid table strip (identical for all players, no shifting); sidebar with static info top / controls bottom;
      clock + "+20s next turn" preview between turns
- [x] Git repo on `main` (history: initial commit → UI rework → UI improvements → sidebar → table/sidebar polish)
- [x] Tests: 108 Vitest tests (poker + blackjack engines, rooms with fake timers incl. soaks); `scripts/bots.mjs` and
      `scripts/blackjack-bots.mjs` e2e
- [x] Blackjack: engine (shoe, S17, 3:2, double/split/insurance/late surrender), BlackjackRoom (spots, bot fill 1–3,
      betting window, insurance, clock), lobby + table page + Pixi renderer (shoe/tray levels, deal/flip/payout/sweep/shuffle
      animations), basic-strategy bots

**Not done / known gaps**
- [ ] Real card and chip art (placeholders are SVGs; swap the files and keep the names, change `CARD_EXT` for PNGs)
- [x] LLM bots: headless Claude Code CLI per decision, script/LLM mode per bot, `OWL_LLM_BOTS`, AI tag, script fallback
- [x] Career page (rates, totals, vs players/bots, table history with every hand) and leaderboard (by Dining Dollars),
      public/private careers
- [ ] Persistence (bankrolls, penalties, rooms and career stats are in memory; a server restart wipes them)
- [ ] `npm audit` reports high-severity advisories (not investigated)
- [ ] Admin dashboard (deliberately skipped so far)

---

## Roadmap

1. **Hackathon MVP: done.** Multiplayer Hold'em with deterministic bots, polished table, LAN play.
2. **AI players (the hackathon centerpiece).**
   - Done: LLM bots via the headless Claude Code CLI (`claudeCli.ts`), mixed with script bots per table.
   - Give bots personalities (tight/loose/aggressive) through prompts.
   - Optional: show a bot's one-line "reasoning" or table talk after its action (only public info, never hole cards).
   - Respect the time budget: the room aborts slow decisions and falls back automatically.
3. **Persistence & identity.** SQLite (e.g. Drizzle) for bankrolls, penalties and career stats / hand history
   (implement `StatsStore`). The career page and leaderboard already exist, in memory.
4. **Content & polish.** Real card art, sounds, chat/emotes, hand history panel, spectator mode.
5. **Blackjack: done.** Possible follow-ups: LLM blackjack bots (`BlackjackStrategy`), a card-counting bot that spreads its bets.
6. **Ops.** Admin dashboard (rooms, players, house bank), production build served by Express, deploy notes.

---

## Next steps (add new items here)

- [ ] Admin panel: switch individual bots between script and LLM (call `RoomManager.setBotMode`; no socket event exists yet)
- [ ] LLM bots: optional one-line reasoning / table talk (costs tokens), long-term opponent memory, personalities
- [ ] LLM bots: a waiting human replaces the closest-stack bot, which may be an LLM bot; refills seat LLM bots again up to `OWL_LLM_BOTS`
- [ ] Replace placeholder card SVGs with real art
- [ ] Implement `StatsStore` (and bankroll storage) on SQLite so careers survive restarts
- [ ] Names are reserved for the whole server run: someone who loses their browser data can't reclaim their name until
      a restart. Consider a recovery code if that becomes a problem
- [ ] Consider a short "Folded · $10 in pot" style label so dead money on folded seats isn't confusing
- [ ] Blackjack: the canvas is small at phone width (sidebar controls are the primary UI there); consider a phone-specific layout
- [ ] Blackjack: 3:2 is verified by tests. If it looks wrong in play, check for insured blackjacks (even money) or 21 after a split (pays 1:1)
- [ ] Blackjack: insurance and split flows are covered by engine/room tests but were not screenshot-checked in a browser

---

## Conventions & gotchas

- **Shell:** Windows. Use the Bash tool for POSIX commands. Python is available and works well for multi-site scripted edits.
  When writing such scripts, put them in a file rather than an inline heredoc if they contain `"""`.
- **Engine purity:** `packages/game-engine` must not import React, Pixi, Express or Socket.IO.
- **Shared types first:** add or rename socket events and views in `packages/shared`, then the server, then the client.
  The typecheck catches mismatches.
- **pokersolver** has no types. `evaluate.ts` uses `/// <reference path="./pokersolver.d.ts" />` so other workspaces typecheck.
  Ranks map `"10"` → `"T"`.
- **Never use `structuredClone`** in the engine (its tsconfig has no DOM lib). Copy manually.
- **Room tests** use `vi.useFakeTimers()` and `advanceTimersByTimeAsync`. Helpers in `PokerRoom.test.ts` create humans with
  fake connected sockets. Private methods are reached with `(room as unknown as {...})` when needed.
- **Copy tone:** keep jokes rare (see Project goals). Amounts always go through `formatDD`.
- **Wording: it's "your clock".** The per-player decision timer is called the **clock** everywhere players or readers see it
  ("Your clock", "Clock full", "Not ready · clock running", "Betting on your clock"). Never "time bank" or "time reserve"
  ("bank" clashes with the money terms: bankroll, HouseBank). Code identifiers (`timeBankMs`, `TIME_BANK_*`, the `"bank"`
  clock kind) keep their old names.
- **UI checks:** action buttons are `--control-h` (52px). Test at 390px wide; Fold/Check must stay visible.
  Check that nothing shifts while values change (strip cells, sidebar info, amount buttons).
- **Git workflow:** the user asks for commits explicitly. Do feature work on a branch off `main`
  (e.g. `ui-rework`, `ui-improvements`), commit there, and merge into `main` (fast-forward) only when asked.
  No remote is configured, so nothing gets pushed. End commit messages with the Co-Authored-By line.
- **Keep this file current.** Update the rules, checklist and next steps here whenever behaviour or design changes.
- `npm install` warns that esbuild's install script was blocked. Harmless: Vite and tsx work.
