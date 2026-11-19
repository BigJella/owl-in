#!/usr/bin/env node
/**
 * itcan.do bridge: keeps the "owl-live" It page (a chat query tool) fed with the game's live data.
 *
 *   node scripts/it-live.mjs [apiBase] [pageId]      (npm run it:live)
 *
 * Every 2s it reads GET <apiBase>/snapshot from the management API (localhost only), trims it, and pushes it into the
 * page's state under the key `live` with `it patch` (only when something changed). The page draws its header stats and
 * every chart in the chat from `live`, so charts Claude posted keep updating by themselves.
 * The chat itself (`state.chat`) belongs to Claude; this script never touches it.
 * It never sends browser tokens, IPs or hidden cards: the API has none of those to give.
 *
 * The page (it/owl-live/index.html) is published by Claude from a conversation (`it create ... --dir it/owl-live`),
 * so questions asked on it reach that conversation. If the page doesn't exist yet, this script publishes it.
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
/** Chart history: one sample every 10s, the last 15 minutes. */
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

// ---------- history (for line charts) ----------

/**
 * Every series is an array aligned with `history.at` (null where there was no value yet).
 * `players[id]` = that player's total Dining Dollars, `tables[id]` = chips at that table, `pots[id]` = its pot.
 */
const history = { at: [], online: [], atTables: [], house: [], bankrolls: [], aiCalls: [], aiMs: [], aiCost: [], players: {}, tables: {}, pots: {} };
/** Keyed series that disappeared (table closed): sent once as null so `it patch` deletes them. */
let dropped = { players: {}, tables: {}, pots: {} };
let lastSample = 0;

function pushSeries(series, value) {
  series.push(value);
  if (series.length > SAMPLES) series.shift();
}

function pushKeyed(group, values) {
  const length = history.at.length; // already includes this sample
  for (const [id, value] of Object.entries(values)) {
    const series = (history[group][id] ??= Array(length - 1).fill(null));
    pushSeries(series, value);
  }
  for (const [id, series] of Object.entries(history[group])) {
    if (id in values) continue;
    pushSeries(series, null);
    if (series.every((v) => v === null)) {
      delete history[group][id];
      dropped[group][id] = null;
    }
  }
}

function sample(s, now) {
  if (now - lastSample < SAMPLE_MS) return false;
  lastSample = now;
  pushSeries(history.at, s.at);
  pushSeries(history.online, s.totals.playersOnline);
  pushSeries(history.atTables, s.totals.playersAtTables);
  pushSeries(history.house, s.totals.house);
  pushSeries(history.bankrolls, s.totals.bankrolls);
  pushSeries(history.aiCalls, s.llm.calls);
  pushSeries(history.aiMs, s.llm.avgMs);
  pushSeries(history.aiCost, s.llm.totalCostUsd);
  pushKeyed("players", Object.fromEntries(s.players.map((p) => [p.id, p.total])));
  pushKeyed("tables", Object.fromEntries(s.tables.map((t) => [t.id, t.chips])));
  pushKeyed("pots", Object.fromEntries(s.tables.filter((t) => t.game === "poker").map((t) => [t.id, t.pot])));
  return true;
}

// ---------- AI breakdowns (from the last 500 decisions) ----------

let aiBreakdown = { byBot: [], byAction: [], byTable: [] };

async function refreshAi() {
  try {
    const response = await fetch(`${API}/llm?limit=500`);
    if (!response.ok) return;
    const { recent } = await response.json();
    const group = (key) => {
      const map = new Map();
      for (const d of recent) {
        const k = key(d);
        const row = map.get(k) ?? { name: k, calls: 0, totalMs: 0, fallbacks: 0, costUsd: 0 };
        row.calls += 1;
        row.totalMs += d.ms;
        row.fallbacks += d.fallback ? 1 : 0;
        row.costUsd += d.costUsd ?? 0;
        map.set(k, row);
      }
      return [...map.values()]
        .map(({ totalMs, ...row }) => ({ ...row, avgMs: Math.round(totalMs / row.calls), costUsd: Math.round(row.costUsd * 1e4) / 1e4 }))
        .sort((a, b) => b.calls - a.calls);
    };
    aiBreakdown = {
      byBot: group((d) => d.bot),
      // "raise to $60" -> "raise"
      byAction: group((d) => (d.fallback ? "fallback" : d.action.split(" ")[0])),
      byTable: group((d) => d.table),
    };
  } catch {
    // keep the last breakdown
  }
}

// ---------- what the page gets ----------

/** Arrays are replaced whole by `it patch`; objects are merged (hence `dropped`). */
function live(s) {
  return {
    at: s.at,
    totals: {
      total: s.totals.total,
      expected: s.totals.expected,
      conserved: s.totals.conserved,
      house: s.totals.house,
      bankrolls: s.totals.bankrolls,
      onTables: s.totals.onPokerTables + s.totals.onBlackjackTables,
      online: s.totals.playersOnline,
      atTables: s.totals.playersAtTables,
      known: s.totals.playersKnown,
      banned: s.totals.banned,
      pokerTables: s.totals.pokerTables,
      blackjackTables: s.totals.blackjackTables,
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
      maxBots: t.settings.maxBots,
      maxAi: t.settings.maxAi,
      seats: t.seats.map((seat) => ({
        name: seat.name,
        kind: seat.kind === "human" ? "human" : seat.botMode === "llm" ? "ai" : "bot",
        stack: seat.stack,
        bet: seat.bet,
        status: seat.status,
        action: seat.lastAction,
      })),
    })),
    players: s.players.map((p) => ({
      id: p.id,
      name: p.name,
      online: p.online,
      bankroll: p.bankroll,
      atTable: p.atTable,
      total: p.total,
      net: p.total - 10_000,
      table: p.table?.name ?? null,
      game: p.table?.game ?? null,
      banned: p.banned !== null,
      timedOut: p.timeout !== null,
    })),
    ai: {
      available: s.llm.available,
      model: s.llm.model,
      calls: s.llm.calls,
      fallbacks: s.llm.fallbacks,
      fallbackRate: s.llm.calls > 0 ? s.llm.fallbacks / s.llm.calls : 0,
      avgMs: s.llm.avgMs,
      p95Ms: s.llm.p95Ms,
      costUsd: s.llm.totalCostUsd,
      recent: s.llm.recent.slice(0, 20).map((d) => ({ at: d.at, table: d.table, bot: d.bot, handId: d.handId, action: d.action, ms: d.ms, fallback: d.fallback })),
      ...aiBreakdown,
    },
    timeouts: s.timeouts.map((t) => ({ player: t.playerName, where: t.scope === "site" ? "Every table" : t.roomName, until: t.until, reason: t.reason })),
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
  const sampled = sample(snapshot, now);
  if (sampled) await refreshAi();
  const body = live(snapshot);
  const json = JSON.stringify({ ...body, at: 0 });
  if (!sampled && json === lastJson && now - lastPush < HEARTBEAT_MS) return;
  // History only changes when sampled: send it then (it's the big part), plus any series to delete.
  const patch = { live: sampled ? { ...body, history: mergeDropped(history) } : body };
  writeFileSync(statePath, JSON.stringify(patch));
  const result = it(["patch", PAGE, "--file", statePath]);
  if (!result.ok) {
    console.error(`it patch failed: ${result.out.trim().slice(0, 200)}`);
    if (/not.?found/i.test(result.out)) ensurePage();
    return;
  }
  if (sampled) dropped = { players: {}, tables: {}, pots: {} };
  lastJson = json;
  lastPush = now;
}

function mergeDropped(h) {
  return {
    ...h,
    players: { ...dropped.players, ...h.players },
    tables: { ...dropped.tables, ...h.tables },
    pots: { ...dropped.pots, ...h.pots },
  };
}

if (!ensurePage()) process.exit(1);
console.log(`Feeding It page "${PAGE}" from ${API} every ${POLL_MS / 1000}s. Ctrl+C to stop.`);
await tick();
setInterval(() => void tick(), POLL_MS);
