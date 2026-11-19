#!/usr/bin/env node
/**
 * itcan.do bridge: keeps the "owl-live" It page fed with the game's live state.
 *
 *   node scripts/it-live.mjs [apiBase] [pageId]      (npm run it:live)
 *
 * Every 2s it reads GET <apiBase>/snapshot from the management API (localhost only), trims it to what the page
 * shows, and pushes it into the page's state under the key `live` with `it patch` (only when something changed).
 * It never sends browser tokens, IPs or hidden cards: the API has none of those to give.
 *
 * The page itself (it/owl-live/index.html) is published by Claude from a conversation (`it create ... --dir it/owl-live`),
 * so clicks and questions on it reach that conversation. If the page doesn't exist yet, this script publishes it.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const API = (process.argv[2] ?? process.env.OWL_ADMIN_API ?? "http://localhost:3000/api/admin").replace(/\/$/, "");
const PAGE = process.argv[3] ?? "owl-live";
const PAGE_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "it", "owl-live");
const POLL_MS = 2_000;
/** Push at least this often even when nothing changed, so the page's "updated" time stays fresh. */
const HEARTBEAT_MS = 15_000;
/** Chart points: one every 10s, the last 15 minutes. */
const SAMPLE_MS = 10_000;
const SAMPLES = 90;

const IT = (() => {
  for (const name of process.platform === "win32" ? ["it.exe", "it"] : ["it"]) {
    if (spawnSync(name, ["--version"], { stdio: "ignore", windowsHide: true }).status === 0) return name;
  }
  const fallback = join(homedir(), ".it", "bin", process.platform === "win32" ? "it.exe" : "it");
  return existsSync(fallback) ? fallback : null;
})();
if (!IT) {
  console.error("The `it` command wasn't found (looked on PATH and in ~/.it/bin). Install It first.");
  process.exit(1);
}

const temp = mkdtempSync(join(tmpdir(), "owl-live-"));
const statePath = join(temp, "state.json");

function it(args) {
  const result = spawnSync(IT, args, { encoding: "utf8", windowsHide: true });
  return { ok: result.status === 0, out: (result.stdout ?? "") + (result.stderr ?? "") };
}

/** Make sure the page exists (publishes it from it/owl-live if not). */
function ensurePage() {
  if (it(["read", PAGE]).ok) return true;
  console.log(`Publishing the "${PAGE}" page from ${PAGE_DIR} ...`);
  const created = it(["create", "OWL IN Live", "--id", PAGE, "--dir", PAGE_DIR]);
  if (!created.ok) console.error(created.out.trim());
  return created.ok;
}

const history = { at: [], online: [], atTables: [], house: [], aiCalls: [], aiMs: [] };
let lastSample = 0;

function sample(s, now) {
  if (now - lastSample < SAMPLE_MS) return;
  lastSample = now;
  const push = (key, value) => {
    history[key].push(value);
    if (history[key].length > SAMPLES) history[key].shift();
  };
  push("at", s.at);
  push("online", s.totals.playersOnline);
  push("atTables", s.totals.playersAtTables);
  push("house", s.totals.house);
  push("aiCalls", s.llm.calls);
  push("aiMs", s.llm.avgMs);
}

/** What the page shows. Arrays are replaced whole by `it patch`, so removed tables disappear. */
function live(s) {
  return {
    at: s.at,
    totals: {
      total: s.totals.total,
      conserved: s.totals.conserved,
      house: s.totals.house,
      bankrolls: s.totals.bankrolls,
      onTables: s.totals.onPokerTables + s.totals.onBlackjackTables,
      online: s.totals.playersOnline,
      atTables: s.totals.playersAtTables,
      known: s.totals.playersKnown,
      banned: s.totals.banned,
    },
    tables: s.tables.map((t) => ({
      id: t.id,
      game: t.game,
      name: t.name,
      stakes: t.stakes,
      stage: t.stage,
      handId: t.handId,
      pot: t.pot,
      chips: t.chips,
      closing: t.closing,
      humans: t.humans,
      bots: t.bots,
      aiBots: t.aiBots,
      seats: t.seats.map((seat) => ({
        name: seat.name,
        kind: seat.kind === "human" ? "human" : seat.botMode === "llm" ? "ai" : "bot",
        stack: seat.stack,
        bet: seat.bet,
        status: seat.status,
        action: seat.lastAction,
      })),
    })),
    players: s.players.slice(0, 12).map((p) => ({
      id: p.id,
      name: p.name,
      online: p.online,
      total: p.total,
      table: p.table?.name ?? null,
      banned: p.banned !== null,
      timedOut: p.timeout !== null,
    })),
    ai: {
      available: s.llm.available,
      model: s.llm.model,
      calls: s.llm.calls,
      fallbacks: s.llm.fallbacks,
      avgMs: s.llm.avgMs,
      p95Ms: s.llm.p95Ms,
      costUsd: s.llm.totalCostUsd,
      recent: s.llm.recent.slice(0, 8).map((d) => ({ at: d.at, table: d.table, bot: d.bot, action: d.action, ms: d.ms, fallback: d.fallback })),
    },
    history,
  };
}

let lastJson = "";
let lastPush = 0;
let failing = false;

async function tick() {
  let snapshot;
  try {
    const response = await fetch(`${API}/snapshot`);
    if (!response.ok) throw new Error(`HTTP ${response.status}: ${(await response.text()).slice(0, 120)}`);
    snapshot = await response.json();
  } catch (error) {
    if (!failing) console.error(`Can't read ${API}/snapshot (${error.message}). Is the server running? Retrying...`);
    failing = true;
    return;
  }
  if (failing) console.log("Server is back.");
  failing = false;

  const now = Date.now();
  sample(snapshot, now);
  const body = live(snapshot);
  const json = JSON.stringify({ ...body, at: 0 });
  if (json === lastJson && now - lastPush < HEARTBEAT_MS) return;
  writeFileSync(statePath, JSON.stringify({ live: body }));
  const result = it(["patch", PAGE, "--file", statePath]);
  if (!result.ok) {
    console.error(`it patch failed: ${result.out.trim().slice(0, 200)}`);
    if (/not.?found/i.test(result.out)) ensurePage();
    return;
  }
  lastJson = json;
  lastPush = now;
}

if (!ensurePage()) process.exit(1);
console.log(`Feeding It page "${PAGE}" from ${API} every ${POLL_MS / 1000}s. Ctrl+C to stop.`);
await tick();
setInterval(() => void tick(), POLL_MS);
