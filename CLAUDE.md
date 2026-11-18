# OWL IN — KSU Card Club

A multiplayer card-game website built for the **KSU AI Club Hackathon 2026**. Players join from any device on the LAN,
pick a name, and play Texas Hold'em against each other **and against AI bot players** for **KSU Dining Dollars**
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
- **Type:** Oswald (condensed, uppercase, letter-spaced) for headings, labels, numbers and buttons; Inter for body text.
  Both are bundled via `@fontsource` (works offline on LAN). Pixi waits for Oswald to load before drawing.
- Buttons: `.primary` (solid gold, black text), `.secondary` (black, gray border → gold on hover), `.primary.danger`.
  Tags: `.tag` / `.tag.gold` / `.tag.danger` (square, outlined).
- **Table screen layout:**
  - **`TableStrip`** across the top, between two gold rules with cells split by vertical bars. It shows **only
    table-wide info** (name, blinds, hand #, stage, pot, dealer, SB/BB, who's acting plus their clock, between-hands status).
    Every player must see the same strip, so never put personal data in it.
  - **`PlayerSidebar`** (right, 340px) holds everything personal: name, stack, in-pot, your clock, tags, actions,
    ready/rebuy, cash out. Below 900px it stacks under the table with the actions first.
  - The felt is black with a gold rail. The table name and blinds are **not** drawn on the canvas (they're in the strip).

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
| `node scripts/generate-placeholder-cards.mjs` | Regenerates placeholder card/chip SVGs into `apps/client/public/assets` |

- Server runs TypeScript directly via `tsx` (no build step). Workspace packages export raw `.ts` (`"exports": "./src/index.ts"`).
- LAN play: open `http://<pc-ip>:5173`. The client connects to `http://<same-host>:3000` (override with `VITE_SERVER_URL`).
  Windows Firewall may prompt for Node.
- **Before finishing work:** `npm run typecheck && npm test && npm run build`, and for gameplay changes run `scripts/bots.mjs`
  against `npm run dev`. For UI changes, check in a browser at desktop (1280px) **and** phone (390px) widths.
  Previous sessions drove headless Chrome with `puppeteer-core` installed in the session scratchpad (not a project dependency).
- Stop any dev server you started so ports 3000/5173 are free for the user.

---

## Repository layout

```
apps/
  client/                     React 19 + Vite + PixiJS 8 + gsap (player website)
    src/App.tsx               Screen routing: Name → Home → Poker lobby → Table; session + "left table" notice
    src/networking/socket.ts  Typed Socket.IO client; per-browser session token (localStorage) for seat reclaim
    src/networking/pokerStore.ts  Buffers every poker:state message outside React (animations never drop events)
    src/pages/                NamePage, HomePage, PokerLobbyPage (sortable/filterable room list, buy-in/create dialogs),
                              PokerTablePage (shared TableStrip + personal PlayerSidebar with clock/actions/ready-up,
                              rebuy dialog, leave dialog, cashed-out result view)
    src/game/poker/
      pixiApp.ts              ONE Pixi Application for the whole session (canvas is moved between pages; never destroyed)
      PokerScene.tsx          Mounts the shared canvas + creates a PokerRenderer per table visit
      PokerRenderer.ts        Imperative scene (black felt, gold rail): seats, cards, chips, pots; plays server events as gsap timelines,
                              then snaps to the authoritative view
      ActionBar.tsx           Fold / Check / Call / Raise (presets, slider, typed amount); uniform 52px controls
      assets.ts               Card/chip textures (public/assets/cards/{rank}{S|H|D|C}.svg + back.svg, chips/chip.svg)
  server/                     Express + Socket.IO, run with tsx
    src/index.ts              Wires registry, house bank, room manager, socket handlers
    src/networking/handlers/connectionHandler.ts  All socket events, zod-validated
    src/players/              Player (abstract) → HumanPlayer, BotPlayer; PlayerRegistry (token → human)
    src/ai/                   PokerStrategy interface, RuleBasedStrategy (deterministic), LlmStrategy (stub)
    src/rooms/PokerRoom.ts    The table loop: turns, time banks, ready-up, bot seating/pacing, cash-outs, penalties, views
    src/rooms/RoomManager.ts  Create/list rooms, keeps ≥2 open, batches room-list pushes
    src/economy/HouseBank.ts  Source/sink for bot chips (keeps total chips constant)
packages/
  game-engine/                Pure rules: no React/Pixi/Express/Socket.IO imports
    src/cards/Deck.ts         createDeck, shuffle (injectable RNG)
    src/poker/PokerTable.ts   Hold'em state machine; returns PokerEvent[] from every mutation
    src/poker/pots.ts         Side-pot builder
    src/poker/evaluate.ts     pokersolver wrapper (has a local pokersolver.d.ts + triple-slash reference)
    src/blackjack/index.ts    handValue only (blackjack not built yet)
  shared/                     Types + constants used by client and server
    src/poker.ts              Views (PokerTableView, PokerSeatView, PokerRoomSummary), constants, formatDD, describeAction, STAGE_LABEL
    src/events.ts             ClientToServerEvents / ServerToClientEvents (Socket.IO generics on both ends)
scripts/                      bots.mjs (e2e smoke), generate-placeholder-cards.mjs
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
  Humans resolve the promise from a socket message; bots resolve it from `strategy.decide(view)`. To plug in an LLM,
  implement `PokerStrategy` (see `LlmStrategy` and its `CompleteFn`); it falls back to the rule-based strategy on error or timeout.
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

**Money**
- Every name gets **$10,000 Dining Dollars**, held in server memory only (a restart resets everything).
- Buy-in is 20–100 BB, capped by bankroll. The High Roller badge appears when the big blind is ≥ $100 (based on stakes, not chips on the table).
- Display every amount with `formatDD` (`$1,234`).

**Hand flow**
- The button moves each hand. Heads-up, the button posts the SB and acts first preflop.
  Only the designated SB and BB post blinds. Folded players can legitimately show "in pot $10" if they called first.
- Raises: the minimum raise is the size of the last raise, all-in is always allowed, and a short all-in doesn't reopen betting.
  Side pots are layered by contribution. In a split pot, the odd chip goes to the first winner left of the button.
- **Time bank (humans only):** +20s each turn, capped at 120s; it starts at 0. At 0 the player auto-checks, or folds if checking isn't possible.
  Bots have no visible clock: they "think" for 1.5–3s (plus 1.5s after a deal so the animation finishes), with a hidden 30s safety cap.

**Between hands (only at tables with humans)**
- Everyone sees the result. Seated, connected humans must **ready up**. The grace period is 5s **plus** an estimated
  end-of-hand animation time (`animationAllowanceMs`). After that, a not-ready player's time bank drains, and at 0 they're auto-readied.
  The hand deals 1s after everyone is ready.
- **Busted** (stack $0): the player can't ready up. A dialog ("Your meal plan is empty") gives **30s**, independent of the
  time bank, to **Reload** (which also readies them) or **Cash out**. If they don't choose, they're removed.

**Leaving**
- The leave button always opens a dialog that states the **30-minute rejoin lockout** for that table.
- Between hands, or if you weren't dealt in: you leave immediately.
- Mid-hand: the cash-out is **queued and irreversible**. You play the hand out, others see **LAST HAND** on your seat, and you're
  removed when it ends. You still see the final result with a "Back to lobby" button. Queued cash-out seats count as free,
  so outsiders can join a "full" table.
- Every removal (cash out, bust-and-leave, rebuy timeout, kicked while away) carries the **30-min penalty for that table**.
  Leaving the waiting list before you've been dealt in is free.
- Disconnects: the seat is held while the time bank drains in real time, and turns auto check/fold. When the bank hits 0 you're
  kicked at the next gap. Reconnecting with the same browser (token) reclaims the seat.

---

## Implementation checklist

**Done**
- [x] Monorepo, per-workspace tsconfigs, typed Socket.IO events, LAN-ready Vite
- [x] Pure Hold'em engine: blinds/button, betting rules, side pots, showdown via pokersolver, chip-conservation fuzz test
- [x] Player abstraction (Human/Bot), RuleBasedStrategy, LlmStrategy stub with fallback
- [x] Rooms: bot fill to 4, closest-stack replacement, ≥2 rooms, bot-only pacing, bot stack cap (no-human tables only)
- [x] Time bank, disconnect hold/drain/kick, seat reclaim on refresh
- [x] Ready-up between hands with grace + drain + animation allowance
- [x] Bust → 30s reload-or-leave dialog; rejoin penalties; queued irreversible cash-out with LAST HAND tag and result view
- [x] Lobby: name entry, home, room list sortable by every column + "Open seats only", create table, buy-in dialog, stage column
- [x] Pixi table: dealing/betting/collect/flip/showdown/payout animations; D/SB/BB markers; "in pot", last action,
      "thinking…", centered pot + side pots, hand-name pills above cards; info strip; live clocks in seconds
- [x] Action bar with presets, slider, typed amount (Enter submits); mobile layout (sticky bar, Fold/Check first)
- [x] Dining Dollars currency + light humor
- [x] Black & gold sharp/flat redesign site-wide; shared table strip + personal sidebar; black felt
- [x] Git repo initialized on `main` with an initial commit; stray root `index.ts` removed
- [x] Tests: 37 Vitest tests (engine + rooms with fake timers incl. 30-min soak); `scripts/bots.mjs` e2e

**Not done / known gaps**
- [ ] Real card and chip art (placeholders are SVGs; swap the files and keep the names, change `CARD_EXT` for PNGs)
- [ ] LLM bots (wire `CompleteFn` in `LlmStrategy` to the Claude API and pick which bots use it)
- [ ] Persistence (bankrolls, penalties and rooms are in memory; a server restart wipes them)
- [ ] Blackjack (engine has `handValue` only; the UI card says "Coming soon")
- [ ] `npm audit` reports high-severity advisories (not investigated)
- [ ] Admin dashboard (deliberately skipped so far)

---

## Roadmap

1. **Hackathon MVP: done.** Multiplayer Hold'em with deterministic bots, polished table, LAN play.
2. **AI players (the hackathon centerpiece).**
   - Implement `CompleteFn` with the Anthropic SDK in `apps/server/src/ai/LlmStrategy.ts`.
     Use the latest Claude models, and load the `claude-api` skill before writing that code.
   - Give bots personalities (tight/loose/aggressive) through prompts. Mix LLM and rule-based bots per table.
   - Optional: show a bot's one-line "reasoning" or table talk after its action (only public info, never hole cards).
   - Respect the time budget: the room aborts slow decisions and falls back automatically.
3. **Persistence & identity.** SQLite (e.g. Drizzle) for bankrolls, penalties and hand history. Maybe a leaderboard
   (the nav already has a placeholder link).
4. **Content & polish.** Real card art, sounds, chat/emotes, hand history panel, spectator mode.
5. **Blackjack.** Add an engine in `packages/game-engine/src/blackjack`, reuse the room/player/bot patterns, and add a lobby card.
6. **Ops.** Admin dashboard (rooms, players, house bank), production build served by Express, deploy notes.

---

## Next steps (add new items here)

- [ ] Wire `LlmStrategy` to the Claude API behind an env var (e.g. `ANTHROPIC_API_KEY`). Keep `RuleBasedStrategy` as the fallback
- [ ] Decide how many bots per table are LLM-driven, and show which ones in the UI (e.g. a different badge)
- [ ] Replace placeholder card SVGs with real art
- [ ] Add a leaderboard (bankroll ranking), needs persistence first
- [ ] Consider a short "Folded · $10 in pot" style label so dead money on folded seats isn't confusing

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
- **UI checks:** every control in the action bar is `--control-h` (52px). Test at 390px wide; Fold/Check must stay visible.
- `npm install` warns that esbuild's install script was blocked. Harmless: Vite and tsx work.
