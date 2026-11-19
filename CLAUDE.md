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
| `OWL_LLM_BOTS=0 npm run dev` | Same, with no AI bots on new tables (see **LLM bots** below); env vars override `.env` for one run |
| `npm run it:live` | itcan.do bridge: feeds the `owl-live` chat page's live data from the management API every 2s (see **Management API**) |
| `node scripts/generate-placeholder-cards.mjs` | Regenerates placeholder card/chip SVGs into `apps/client/public/assets` |

- **Server settings live in `apps/server/.env`** (git-ignored; copy `apps/server/.env.example`). The server's `dev` / `start`
  scripts load it with `--env-file-if-exists`; real environment variables win. `.env` only holds machine settings and the
  *defaults* for new tables; each table's bot / AI counts are changed live from the admin panel. Long term, game settings
  move to the database (with persistence).
- **Admin panel:** `http://localhost:5173/admin.html`, on the server's computer only (see **Management API**).
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
    src/hardware/              Owl Dial: Web Serial connection, protocol + gestures, useDial hooks (see **Owl Dial**)
    src/components/DialControl.tsx  Nav "Connect dial" control
    src/components/ChipChart.tsx   Career chips-over-time chart (SVG, hover/keyboard tooltip)
    src/admin/                Admin panel (second Vite entry, admin.html): AdminApp (Overview / Tables / Players / Timeouts /
                              AI log tabs, dialogs), api.ts (fetch wrapper with X-Owl-Admin), admin.css
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
    src/admin/                Management API: AdminService (every admin operation + the snapshot), adminRoutes (/api/admin/*,
                              zod), security (loopback + local-origin + X-Owl-Admin guard), Moderation (bans, sitewide and
                              per-table timeouts, incl. the poker rejoin lockout)
    src/ai/                   PokerStrategy interface, RuleBasedStrategy (deterministic), LlmStrategy (prompt + parse + fallback),
                              claudeCli (headless `claude -p` CompleteFn + cost), llmConfig (OWL_* env vars), LlmTelemetry
                              (last 500 decisions, latency, cost);
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
    src/admin.ts              Management API types (AdminSnapshot, AdminTable/Seat/Player/Timeout, LlmStats, TableSettings)
    src/career.ts             PokerStats, BlackjackStats, TableSession, hand records, CareerView, LeaderboardRow
    src/events.ts             ClientToServerEvents / ServerToClientEvents (Socket.IO generics on both ends)
scripts/                      bots.mjs, blackjack-bots.mjs (e2e smokes), it-live.mjs (itcan.do bridge), generate-placeholder-cards.mjs
it/owl-live/index.html        The itcan.do chat query page (live stats strip, chat, live chart specs), fed by it-live.mjs
hardware/owl-dial/            Owl Dial firmware (Arduino sketch + README) for the MEGA2560 controller (see **Owl Dial**)
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
- **One bot class, two modes.** `BotPlayer` holds a `script` (RuleBasedStrategy) and an `llm` (LlmStrategy) strategy, a
  mutable `mode: "script" | "llm"` (`BotMode` in shared) and an admin `override: BotMode | null`. The mode is read per
  decision. `PokerRoom.balanceAi()` keeps `settings.maxAi` bots in LLM mode by switching only bots with no override;
  `setBotOverride(botId, mode | null)` pins one (null hands it back). `PokerSeatView.botMode` shows the mode to clients.
- **Management API = one service, two front ends.** `AdminService` holds every admin operation; `/api/admin/*` exposes it.
  The admin panel and the itcan.do bridge (and Claude, via curl) all use the same API. Rooms expose `admin()` (an
  `AdminTable` without hidden cards), `kick`, `requestClose`, `updateSettings`, `refresh`.
- **Hand action log.** `PokerTableView.handActions` lists every public betting action of the hand (blinds included, by street).
  Everyone gets the same log; it's what the LLM reads as "the action so far".
- **One Pixi app.** Creating and destroying a Pixi Application per page visit froze browsers (leaked WebGL contexts, plus a
  teardown-order crash). Keep using `getPixiApp()`.
- **pokerStore keeps the last state after `poker:left`.** This lets a cashed-out player watch their final hand.
  `App` calls `pokerStore.reset()` when they go back to the lobby.

---

## Game rules (agreed with the user, keep these)

**Seating & bots**
- 8 seats max. Bots fill each poker table up to its **max bots** (default **4**): `bots = max(0, maxBots − humans)`.
  Max bots and **max AI** (default **2**) are per-table settings, editable live from the admin panel; new tables use
  `OWL_DEFAULT_BOTS` / `OWL_LLM_BOTS`. A max-AI change applies at once; a max-bots change at the next gap.
- Bots buy in for **60 BB** from the HouseBank. A bot below 1 BB is re-stacked between hands.
- **Bot stack cap:** at tables with **no humans** (seated or waiting), bot stacks above **200 BB** go back to the house
  between hands. The cap never applies while any human is present, so nobody's totals change under them.
- A joining human waits for the next hand. At the gap between hands they **replace the bot whose stack is closest to their buy-in**.
- At least **2 rooms** are always open. The server seeds "Freshman Meal Plan" ($5/$10) and "Unlimited Swipes" ($50/$100).
  An empty extra room closes at its next gap.
- Bot-only rooms play **1 hand per minute**.

**LLM bots (agreed with the user, keep these)**
- Two bot types in one class: **script** (deterministic rule-based) and **LLM** (Claude). Each table keeps **max AI** of
  its bots in LLM mode; the admin panel can also **pin** a single bot to Script or AI (override), or set it back to Auto.
- An LLM decision runs the local **Claude Code CLI headlessly**, one process per decision: `claude -p --model <model>
  --output-format json --json-schema <action schema> --tools "" --strict-mcp-config --setting-sources "" --no-session-persistence`.
  The prompt goes on stdin; the action comes back in `structured_output` (`{type, to?}`). ~2–6s with Haiku, ~$0.0006 per call.
- The prompt is **only** what the seat sees: own hole cards, board, each player's stack / bet / in-pot / status / position,
  and `handActions`. **No long-term memory and no reasoning text** (token cost); both are possible later.
- Any failure (CLI missing, timeout, bad JSON) falls back to the script for that decision; `legalize()` clamps every answer.
  The server logs one `[llm]` line per decision (latency, fallback reason).
- **Env vars** (defaults for new tables): `OWL_DEFAULT_BOTS` (0–8, default 4), `OWL_LLM_BOTS` (number or `all`,
  **default 2**), `OWL_LLM_MODEL` (default `claude-haiku-5-5`), `OWL_LLM_TIMEOUT_MS` (15000), `OWL_CLAUDE_BIN` (`claude`).
- The AI count is kept at every gap: when a human replaces an LLM bot (closest-stack rule), an auto bot is switched to LLM.
  Pinned bots are never switched, and a pin counts toward the table's AI count (a pin to AI can push an auto bot to script).
- **LLM bots play by script at tables with no humans** (seated or waiting), so bot-only rooms spend no tokens.
- UI: LLM bots' seat plates carry a gold **AI** tag (script bots: grey **BOT**); the strip's "To act" cell shows a small AI tag
  (or a grey BOT tag for a script bot; the blackjack strip shows BOT for bots too).

**Admin & moderation (agreed with the user, keep these)**
- **Admin panel** at `localhost:5173/admin.html`, **this computer only**. Separate from the player site (no socket, no identity).
  Tabs: Overview (money with a conservation check, people, AI stats), Tables (create; per-table max bots / max AI; close;
  per-bot Auto / Script / AI), Players (kick, timeout, bankroll, rename, ban/unban; click a name for their full career: the
  Career page's `CareerDetails` with the same actions on top, private careers included), Timeouts, AI log. Polls `/snapshot` every 1s.
- **Kick:** like a cash-out (queued mid-hand / mid-round), with an optional per-table timeout (0 = none).
- **Ban** is by browser token (the identity): removed from their table, disconnected, refused at connect and at `identify`
  (`code: "banned"`); the client shows a plain "You've been banned" screen. Unban lifts it. Clearing site data dodges it
  (accepted).
- **Timeouts:** per-table (the 30-min poker rejoin lockout lives here too, reason "Left the table") and **sitewide** (can
  browse, can't sit anywhere; ends by itself). Admins view, edit, remove and add them; adding one removes the player from
  that table / every table. Blackjack still has **no automatic** lockout, only admin-added ones.
- **Bankroll adjust** moves money to/from the HouseBank (conserved), never below $0. **Rename** works while seated, frees the old
  name, and the client saves the new name from its session.
- **Close table:** at once between hands, else after the current hand / round; everyone cashed out. At least 2 tables of each
  game stay open (closing the last 2 is refused).
- Blackjack tables have a **max bots** setting (0–3, spots 1–3 only) and no AI count yet (`maxAi: null`).

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
- [x] Git repo on `main`, pushed to GitHub (`origin` → BigJella/owl-in)
- [x] Tests: 127 Vitest tests (poker + blackjack engines, rooms with fake timers incl. soaks); `scripts/bots.mjs` and
      `scripts/blackjack-bots.mjs` e2e
- [x] Blackjack: engine (shoe, S17, 3:2, double/split/insurance/late surrender), BlackjackRoom (spots, bot fill 1–3,
      betting window, insurance, clock), lobby + table page + Pixi renderer (shoe/tray levels, deal/flip/payout/sweep/shuffle
      animations), basic-strategy bots

**Not done / known gaps**
- [ ] Real card and chip art (placeholders are SVGs; swap the files and keep the names, change `CARD_EXT` for PNGs)
- [x] LLM bots: headless Claude Code CLI per decision, script/LLM mode per bot, per-table max AI, AI tag, script fallback
- [x] Management API (`/api/admin`, localhost only) + admin panel (players, tables, totals, bans, timeouts, bot overrides,
      AI log) + itcan.do chat query page with live charts and its bridge (`npm run it:live`)
- [x] Career page (rates, totals, vs players/bots, table history with every hand) and leaderboard (by Dining Dollars),
      public/private careers
- [ ] Persistence (bankrolls, penalties, rooms and career stats are in memory; a server restart wipes them)
- [x] `npm audit`: 0 vulnerabilities after the dependency refresh (Nov 2026)

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
6. **Ops.** Done: admin panel + management API + itcan.do live view. Next: production build served by Express, deploy notes.

---

## Next steps (add new items here)

- [ ] LLM bots: optional one-line reasoning / table talk (costs tokens), long-term opponent memory, personalities
- [ ] LLM blackjack bots (`BlackjackStrategy` + a per-table max AI; the admin panel already shows "n/a" for it)
- [ ] Admin panel has no login: it relies on "this computer only". Add a password if the server ever runs on a shared machine
- [ ] Flaky test: `BlackjackRoom.test.ts` "queues a mid-round leave" fails ~1 in 20 runs when the dealer peeks a blackjack
      (the round ends at once). Rig the shoe in that test
- [ ] Replace placeholder card SVGs with real art
- [ ] Implement `StatsStore` (and bankroll storage) on SQLite so careers survive restarts
- [ ] Names are reserved for the whole server run: someone who loses their browser data can't reclaim their name until
      a restart. Consider a recovery code if that becomes a problem
- [ ] Consider a short "Folded · $10 in pot" style label so dead money on folded seats isn't confusing
- [ ] Blackjack: the canvas is small at phone width (sidebar controls are the primary UI there); consider a phone-specific layout
- [ ] Blackjack: 3:2 is verified by tests. If it looks wrong in play, check for insured blackjacks (even money) or 21 after a split (pays 1:1)
- [ ] Blackjack: insurance and split flows are covered by engine/room tests but were not screenshot-checked in a browser
- [ ] **Owl Dial** firmware in `hardware/owl-dial/` (hardware session), then a full test with the real board (the browser side
      is done and was tested with `owlDial.emit`)

---

## Management API (localhost only)

The game server exposes `/api/admin/*` (`apps/server/src/admin/`). **Only requests from this computer** are served
(loopback check, never `X-Forwarded-For`); a browser request must come from a local origin; **every write needs the
header `X-Owl-Admin: 1`**. Responses never contain browser tokens, IPs or hidden cards (keep it that way).

| Method & path | Does |
|---|---|
| `GET /snapshot` | Everything: totals (with `conserved`), tables + seats, players, timeouts, LLM stats |
| `GET /tables`, `/tables/:id`, `/players`, `/timeouts`, `/llm?limit=` | Parts of the snapshot (`/llm` has up to 500 decisions) |
| `POST /tables` | `{game, name, bigBlind \| minBet, maxBots?, maxAi?}` |
| `PATCH /tables/:id` | `{maxBots?, maxAi?}` |
| `POST /tables/:id/close` | Close after the current hand / round |
| `POST /bots/:id/mode` | `{mode: "auto" \| "script" \| "llm"}` (poker bots) |
| `GET /players/:id/career` | Their career, exactly what the in-game Career page shows (`careerView`, viewer = admin; private careers too; no cards): totals, `poker` / `blackjack` stats, sessions, `chipHistory` (total after every hand) |
| `GET /players/:id/sessions/:sessionId` | One table session's hands (the history rows' expansion); unshown poker hole cards are `null` |
| `POST /players/:id/kick` | `{timeoutMinutes?}` |
| `POST /players/:id/ban` · `/unban` | `{reason?}` |
| `POST /players/:id/bankroll` | `{delta}` (whole Dining Dollars, ±) |
| `POST /players/:id/rename` | `{name}` |
| `PUT /timeouts` · `DELETE /timeouts` | `{playerId, scope: "table" \| "site", roomId?, minutes, reason?}` (delete: no minutes) |

Examples (Git Bash): `curl -s localhost:3000/api/admin/snapshot`, and
`curl -s -X POST localhost:3000/api/admin/players/<id>/kick -H "Content-Type: application/json" -H "X-Owl-Admin: 1" -d '{"timeoutMinutes":10}'`.

**itcan.do (It) = a chat query tool.** `it/owl-live/index.html` is a chat page: a small live stats strip on top, a
scrollable chat, and an input at the bottom. **Design exception (user request):** this page uses a *softer*, more spaced-out
take on black & gold (rounded bubbles/cards/pills, warm dark greys, faint borders, sentence-case labels). The sharp, flat
rules above still apply to the game site and the admin panel. Same fonts as the site (Inter + Oswald woff2 files in
`it/owl-live/fonts/`, copied from `@fontsource`). The top of the chat is an intro (4 stat tiles + "Players online" and
"Chips at each table" live charts) that scrolls away with the conversation; message times sit under each bubble.
Line charts are interactive like the game's chip chart (crosshair, dots and a tooltip on hover/touch; focus + ←/→/Home/End
on the keyboard), and keep the hovered point through the 2s redraws; bars and table rows highlight on hover. The user asks questions; **the Claude Code session that owns the page
answers** in the chat with text and **live charts** (chart specs the page redraws from fresh data every 2s). Answers
only arrive while that session is open.
- Publish from the conversation that will answer: `it read owl-live` (if `not_found`: `it create "OWL IN Live" --id owl-live
  --dir it/owl-live --open`), or `it open owl-live` to take over the existing page. After editing the page: `it update owl-live
  --dir it/owl-live`. **Taking over only works when Claude runs it inside a session**: `it open` from a plain terminal
  just shows the page and leaves it unowned. A page the bridge (re)published is unowned too (It then says "Your agent gets
  this when it next waits on this page"): questions queue until a session runs `it open owl-live`, then answer the queue
  (`it actions`, `it ack <id>`).
- `npm run it:live [apiBase] [pageId]` (scripts/it-live.mjs) pushes `state.live` every 2s (only when changed, plus a 15s
  heartbeat). It never touches `state.chat`. `live` holds `totals`, `tables[]` (with `seats[]`, `maxBots`, `maxAi`),
  `players[]` (all: `id, name, online, bankroll, atTable, total, net, table, game, banned, timedOut`), `timeouts[]`,
  `ai` (`calls, fallbacks, fallbackRate, avgMs, p95Ms, costUsd, recent[]`, and from the last 500 decisions `byBot[]`,
  `byAction[]`, `byTable[]` with `name, calls, avgMs, fallbacks, costUsd`) and `history` (one sample per 10s, 15 min:
  `at, online, atTables, house, bankrolls, aiCalls, aiMs, aiCost`, plus keyed series `players.<playerId>` (total),
  `tables.<tableId>` (chips) and `pots.<tableId>`).
- **`state.chat`** (Claude's): an object keyed by message id, sorted on the page by `at` (ms), so **append with one
  `it patch` and no read**. Items: `{role:"user", text, at, ref}` (echo of the question; `ref` clears the page's pending
  bubble), `{role:"claude", text, at}`, `{role:"claude", chart:{…}, text?, at}`, `{role:"claude", status:"thinking", at}`.
  Remove an item with `null`; clear the chat with `{"chat":null}`.
- **Chart specs** (paths are into `state.live`; add `data` instead of a path for a one-off "Snapshot" chart that doesn't update):
  - `{type:"line", title, series:[{label, path:"history.online"}, …], format}` (up to 4 series; x is `history.at`)
  - `{type:"bar", title, source:"players" | "tables" | "ai.byBot" | …, label:"name", value:"total", sort:"desc", limit, where:{game:"poker"}, format}`
    (negative values draw red from zero)
  - `{type:"stat", title, path:"totals.house", history:"history.house", format}` (big number + change over the window)
  - `{type:"table", title, source, columns:[{field, label, format}], sort, sortBy, limit, where}`
  - `format`: `dd` (Dining Dollars), `int`, `ms`, `usd`, `pct`.
- **Answering** (actions arrive as `[It] "OWL IN Live" (owl-live): ask` with `{text, ref}`; It's own box above the page
  arrives as `it:message`):
  1. At once, one patch: the user echo (with `ref`) plus `{role:"claude", status:"thinking"}`.
  2. Query the API (`curl -s localhost:3000/api/admin/...`).
  3. One patch: the answer item(s) plus the thinking item set to `null`.
  Write patches to a temp JSON file and run `it patch owl-live --file <file>` (no shell-quoting problems on Windows).
  Build that file with a small `.mjs` script written with the Write tool (`JSON.stringify` of the patch), not inline
  `node -e '…'`: an apostrophe in the answer text ("he's") ends the shell's single-quoted string.
  Use ids like `c<at>-q` / `c<at>-a` and `at` = `Date.now()`, answer items a millisecond later than the echo.
  Example answer item: `{"role":"claude","at":…,"text":"Chips at every table, live:","chart":{"type":"bar","title":"Chips by
  table","source":"tables","label":"name","value":"chips","sort":"desc","format":"dd"}}`.
- **Snapshot refresh:** charts with inline `data` / `values` show "Snapshot · <time>" and a ↻ button. Give them
  `query` (how to rebuild them, e.g. `"career <playerId>: chipHistory"`) and `asOf` (ms). A click sends
  `It.action("refresh", {id, title, query, question})`. Rebuild from the API and patch **the same id in place**:
  `{"chat":{"<id>":{"chart":{"data":…, "series":…, "asOf":<now>}}}}` (objects merge; arrays are replaced). The page's
  spinner stops once `asOf` is newer than the click.
- **Career questions** (all-time chip history, poker vs blackjack): `GET /players/:id/career`, then post a chart with inline
  `data` (a "Snapshot": careers aren't in `live`), e.g. `{type:"line", title, data:{x:["Start", "Hand 1 · poker", "Hand 2 · blackjack", …]}, series:[{label, values:[10000, …totals]}], format:"dd"}`
  (`chipHistory` has one point per poker hand and per blackjack round, each with its `game`). **`data.x` must be strings:**
  the line chart formats numeric x values as clock times.
  or a `bar` with `data:[{name:"Poker", value:net}, {name:"Blackjack", value:net}]`. The player client keeps using the
  `career:get` socket event; both call the same `careerView`.
- **How to answer (the tone the user expects):**
  - **Short and concise.** Lead with the answer (the number, the name, yes/no). No preamble, no restating the question,
    no sign-off. Plain and friendly; no jokes, hype or emoji.
  - **Analysis is a short paragraph of prose** (one to three sentences), not one fact per line. Never the
    `Label: value` line-per-item style ("Blackjack: busuf, +$450…\nPoker: APPLEBOY, …"): write "busuf is the best at
    blackjack, up $450 over 15 hands, and APPLEBOY is the best at poker, …". Use bullets only for a real list of
    separate items (e.g. what a Confirm button will do).
  - **Assume a smart admin.** Don't explain the obvious: never say a chart "updates live", what a snapshot is, or how
    to read a chart. Mention a limit only when it changes the answer (e.g. "nobody is seated, so the AI bots are on
    script right now").
  - **Numbers:** Dining Dollars as `$1,234` (`−$900` for losses), times as `5.7s`, relative where it helps ("down $1,030").
  - **Charts when they help** (over time, comparisons, lists of more than ~3 rows): prefer **live** specs; snapshots
    (inline `data` + `query` + `asOf`) only for data not in `live` (careers). Text first, chart in the same message.
  - **Always say which game a hand is from.** Never a bare "hand" in chart titles, axis/point labels, legends or text:
    write "poker hand" or "blackjack hand" (a blackjack *round* can hold several hands: say "blackjack round" when you
    mean the round). Mixed charts label every point with its game (e.g. x labels "Hand 1 · poker",
    "Hand 2 · blackjack") and title it "after each poker hand and blackjack round".
  - **Resolve references** yourself ("him" = the player just discussed). Look up ids with `GET /players` / `GET /tables`;
    never ask the user for an id.
- **Changes use Confirm / Cancel buttons, never a typed "yes".** For kicks, bans, timeouts, bankroll changes, renames,
  closing tables and clearing the chat (including the Clear button's `clear` action), post a message whose text lists
  exactly what will happen, with a `confirm` object:
  `{"role":"claude","at":…,"text":"I'll add these timeouts for APPLEBOY:\n• 5 min from Freshman Meal Plan","confirm":{"label":"Time out","danger":true}}`
  (`label` = the verb on the button; `danger: true` for bans, kicks, timeouts, clearing). A click arrives as
  `confirm` `{id, choice: "yes" | "no"}`. On **yes** (sent just after someone used the page, for a message you posted),
  apply exactly what that message listed, then patch `{"chat":{"<id>":{"confirm":{"status":"done","result":"<short past tense>"}}}}`;
  on **no**, patch `"status":"cancelled"`. Never act on a plan that wasn't shown in that message. Clearing the chat on
  yes: patch `{"chat":null,"_page":{"confirming":null,"refreshing":null}}`.
- **Acknowledge every action** (`it ack <id>`) after handling it.
- **Moderation from the chat** ("kick Sam", "ban X", the Clear button): always through the Confirm / Cancel buttons above.
- It state lives on It's service and is shown on TVs/phones: never put tokens, IPs or hole cards in it.

## Owl Dial (hardware controller)

A physical controller for the player on the **server PC**: a rotary dial with a push switch plus two buttons, on an
Arduino-compatible board, sending input over USB serial. The browser reads it with **Web Serial** and drives the table
controls. **Status:** the browser side is built (`apps/client/src/hardware/`); the firmware (`hardware/owl-dial/`) is
being built in a separate session against the contract below. Keyboard, mouse and touch keep working; **nothing changes on the server.**

**Scope:** Chrome or Edge only (Web Serial). The page must be a secure context, so only **`http://localhost:5173` on the
computer the board is plugged into** (LAN pages at `http://<pc-ip>` can't use Web Serial; no HTTPS work planned).

**Parts:** ELEGOO MEGA2560 R3 (Arduino Mega 2560 compatible), a KY-040 push rotary encoder module (pins CLK, DT, SW, +, GND),
2 momentary push buttons (**A**, **B**), jumper wires, and a USB-B cable.

**Wiring** (every input `INPUT_PULLUP`, every switch to GND, so pressed = LOW):

| Part | Pin | Mega pin |
|---|---|---|
| Encoder | CLK | **D2** (interrupt) |
| Encoder | DT | **D3** (interrupt) |
| Encoder | SW (dial press) | **D4** |
| Encoder | + | 5V |
| Encoder | GND | GND |
| Button A | one leg / other leg | **D5** / GND |
| Button B | one leg / other leg | **D6** / GND |

**Firmware requirements** (`hardware/owl-dial/owl-dial.ino` + `hardware/owl-dial/README.md` with the wiring and upload steps):
- `Serial.begin(115200)`; print `OWL-DIAL 1` once in `setup()`.
- Encoder: quadrature **state table** driven by interrupts on D2 and D3 (CHANGE), one event per **detent** (4 valid
  transitions; invalid transitions ignored), so fast turns never skip or double-count. Counting happens in the ISR; `loop()`
  prints the pending steps (an ISR never calls `Serial`).
- Buttons (SW, A, B): 20 ms debounce in `loop()` with `millis()`, an event on **press and release**. **No hold timing in
  firmware**: the browser times holds (it draws the hold progress and owns the 1 s threshold).
- Never block `loop()` (no `delay()`).

**Serial protocol v1** (the contract between firmware and browser): 115200 baud, ASCII, one event per line, ending in `\n`
(a `\r` before it is tolerated).

| Line | Meaning |
|---|---|
| `OWL-DIAL 1` | Hello (sent on boot; `1` = protocol version) |
| `R+1` / `R-1` | One detent clockwise / counter-clockwise (the firmware may send `R+3` for 3 detents at once) |
| `P1` / `P0` | Dial pressed / released |
| `A1` / `A0` | Button A pressed / released |
| `B1` / `B0` | Button B pressed / released |

The browser ignores any other line. Opening the port **resets the Mega** (DTR), so the hello line arrives about 1.5 s after
connecting; that's expected. If clockwise comes out as `R-1`, fix it in the firmware (swap the CLK/DT roles), not in the
browser.

**Testing the board on its own:** Arduino IDE → board "Arduino Mega or Mega 2560", the board's COM port, upload. Serial Monitor
at 115200, "Newline": you see `OWL-DIAL 1`, one `R+1` per click clockwise, `R-1` counter-clockwise, `P1`/`P0` for a dial
press, and `A1`/`A0`, `B1`/`B0`. **Close the Serial Monitor before connecting the browser** (only one program can hold a COM
port).

**What each input does in the game** (the browser side; agreed with the user):
- **A = yes / okay / hit** (does the highlighted or default action). **B = no / back / stand.** **Holding B for 1 s = fold
  or leave** (a filling bar on the target button shows the hold; it fires once per hold). **Turning** changes an amount or
  moves a highlight. **Pressing the dial** only commits a dialed amount (poker raise, blackjack bet).
- Poker, your turn: turn = raise amount (±1 big blind per detent, faster when turned quickly), **press = raise**,
  **A = check / call**, B = reset the dial to the min raise, **hold B = fold** (never folds a free check).
  Between hands: A = ready, hold B = Leave dialog.
- Blackjack betting: step 1, turn = highlight a seat (then **Deal** at the end once you've bet), A = choose the seat (or
  deal); step 2, turn = bet amount, **press = bet**, B = back to step 1. Hold B = **leave that seat** if the highlighted seat is
  yours (bet refunded), else the table Leave dialog.
- Blackjack, your turn: turn = highlight Hit / Double / Split / Surrender (starts on Hit), **A = do it (Hit)**, **B = Stand**.
  Insurance: A = insure, B = no. Hold B = Leave dialog.
- Any dialog: A = its main button (Leave / Reload / Cash out), B = cancel. Rebuy dialog: turn = amount, A = reload,
  hold B = cash out.

**Browser side** (`apps/client/src/hardware/`):
- `dialProtocol.ts`: `parseDialLine`, `createLineSplitter`, and `createGestures` (taps fire on release; B held
  `DIAL_HOLD_MS` = 1 s fires `holdB` once and swallows its release; detents < 40 ms apart count ×5). Tested in
  `dialProtocol.test.ts`.
- `dial.ts`: the Web Serial connection (115200 baud, auto-reconnects to an already-allowed port on load and on plug-in)
  and dispatch. Handlers have a **priority** (`DIAL_PRIORITY`: dialog 2 > panel 1 > page 0); an event goes down the list
  until a handler returns `true`. `holdStart` / `holdEnd` drive the hold bar; `holdEnd` is broadcast to everyone.
  Dialogs return `true` for everything (modal).
- `useDial.ts`: `useDial(handler, priority, active)`, `useDialConnected`, `useHoldState` (the hold bar), `useDialMenu` /
  `stepIndex` (highlights that skip disabled entries).
- UI: "Connect dial" in the nav (`components/DialControl.tsx`; hidden without Web Serial and below 760px). `.dial-focus`
  (1px gold outline) marks what the dial / A will trigger, only while connected. `.has-hold` + `.hold-fill` is the flat 3px
  bar that fills over 1 s (the CSS duration must match `DIAL_HOLD_MS`).
- **Testing without the board:** in dev, `owlDial.emit("R+1", "A1", "A0")` in the console (or puppeteer) feeds protocol
  lines as if they came from the board, connected or not.

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
  The remote is GitHub (`origin` → `BigJella/owl-in`); push only when the user asks, and delete merged feature branches
  (local and on `origin`) when asked. End commit messages with the Co-Authored-By line.
- **Keep this file current.** Update the rules, checklist and next steps here whenever behaviour or design changes.
- **Vitest and the drive letter:** if the shell's cwd starts with a lowercase `c:` every suite fails to load
  ("failed to find the runner" / "reading 'config'"): vitest loads itself twice. `cd "C:/Users/..."` first.
- **Bet chips avoid the board:** `PokerRenderer.betSpot()` places each seat's bet 60% toward the centre, sliding it sideways
  or toward the plate when the chip + amount would overlap the board row, the seat's hole cards or the dealer button.
- `npm install` warns that esbuild's install script was blocked. Harmless: Vite and tsx work.
- **If the repo folder is moved or renamed, run `npm install`**: the workspace links in `node_modules/@owl-in` are absolute
  junctions and keep pointing at the old path (every `@owl-in/*` import then fails to resolve).
- Puppeteer: set a fake player's localStorage from `/admin.html` (same origin, opens no game socket). Setting it on the
  player page races that page's own socket, which can sign in under the old token and take the name.
