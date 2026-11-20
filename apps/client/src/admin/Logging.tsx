import { Fragment, useEffect, useRef, useState } from "react";
import {
  ADMIN_ACTION_LABEL,
  ADMIN_LOG_KIND_LABEL,
  ADMIN_LOG_KINDS,
  BJ_RESULT_LABEL,
  formatDD,
  type AdminLogEntry,
  type AdminLogKind,
  type AdminLogPlayer,
  type AdminLogQuery,
  type AdminSnapshot,
  type BlackjackRoundLog,
  type GameType,
  type LlmLog,
  type PokerHandLog,
} from "@owl-in/shared";
import { Cards } from "../pages/CareerPage";
import { api } from "./api";

const PAGE = 100;
const POLL_MS = 2000;

const clock = (at: number) => new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
const usd = (n: number | null) => (n === null ? "—" : `$${n.toFixed(n < 0.01 ? 4 : 2)}`);
const signed = (n: number) => (n > 0 ? `+${formatDD(n)}` : n < 0 ? `−${formatDD(-n)}` : formatDD(0));
const tone = (n: number) => (n > 0 ? "gold" : n < 0 ? "loss" : "muted");
const KIND_TAG: Record<AdminLogKind, string> = { hand: "Hand", llm: "AI", admin: "Admin" };
const POKER_RESULT: Record<PokerHandLog["seats"][number]["result"], string> = { won: "Won", split: "Split pot", lost: "Lost", folded: "Folded" };

type OpenCareer = (playerId: string) => void;

/** The filters survive leaving the tab (e.g. opening a player's career and coming back). */
const saved = {
  kinds: [...ADMIN_LOG_KINDS] as AdminLogKind[],
  game: "" as GameType | "",
  tableId: "",
  q: "",
  humansOnly: false,
};

/** A player's name: humans open their career, bots are plain text. */
function PlayerName({ player, open }: { player: AdminLogPlayer; open: OpenCareer }) {
  if (player.playerId === null) return <span className="adm-log-bot" title="Bot">{player.name}</span>;
  const id = player.playerId;
  return (
    <button
      className="adm-link"
      title={`${player.name}: career and hand history`}
      onClick={(e) => {
        e.stopPropagation();
        open(id);
      }}
    >
      {player.name}
    </button>
  );
}

function Players({ players, open }: { players: AdminLogPlayer[]; open: OpenCareer }) {
  if (players.length === 0) return <span className="muted">—</span>;
  // Humans first: they're the ones you can click.
  const sorted = [...players].sort((a, b) => Number(b.kind === "human") - Number(a.kind === "human"));
  return (
    <span className="adm-log-players">
      {sorted.map((p, i) => (
        <Fragment key={`${p.playerId ?? p.name}-${i}`}>
          {i > 0 && <span className="muted">, </span>}
          <PlayerName player={p} open={open} />
        </Fragment>
      ))}
    </span>
  );
}

/** The Logging tab: every hand, AI decision and admin action, newest first, with filters. */
export function Logging({ s, openCareer }: { s: AdminSnapshot; openCareer: OpenCareer }) {
  const [kinds, setKinds] = useState<AdminLogKind[]>(saved.kinds);
  const [game, setGame] = useState<GameType | "">(saved.game);
  const [tableId, setTableId] = useState(saved.tableId);
  const [q, setQ] = useState(saved.q);
  const [humansOnly, setHumansOnly] = useState(saved.humansOnly);
  Object.assign(saved, { kinds, game, tableId, q, humansOnly });
  const [entries, setEntries] = useState<AdminLogEntry[] | null>(null);
  const [more, setMore] = useState(false);
  const [counts, setCounts] = useState<Record<AdminLogKind, number> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  const [loadingOlder, setLoadingOlder] = useState(false);

  const query: AdminLogQuery = {
    kinds,
    ...(game ? { game } : {}),
    ...(tableId ? { tableId } : {}),
    ...(q.trim() ? { q: q.trim() } : {}),
    humansOnly,
  };
  const queryKey = JSON.stringify(query);
  const entriesRef = useRef<AdminLogEntry[] | null>(null);
  entriesRef.current = entries;

  // First page whenever the filters change, then poll for newer entries.
  useEffect(() => {
    let live = true;
    const base = JSON.parse(queryKey) as AdminLogQuery;
    setEntries(null);
    setExpanded(new Set());
    const first = () =>
      api.log({ ...base, limit: PAGE }).then(
        (page) => {
          if (!live) return;
          setEntries(page.entries);
          setMore(page.more);
          setCounts(page.counts);
          setError(null);
        },
        (e: unknown) => live && setError(e instanceof Error ? e.message : "Couldn't load the log."),
      );
    const poll = () => {
      const current = entriesRef.current;
      if (current === null) return void first();
      const newest = current[0]?.id ?? 0;
      api.log({ ...base, after: newest, limit: PAGE }).then(
        (page) => {
          if (!live) return;
          setCounts(page.counts);
          setError(null);
          if (page.more) return void first(); // too many new ones: start over from the top
          if (page.entries.length > 0) setEntries((list) => [...page.entries, ...(list ?? [])]);
        },
        (e: unknown) => live && setError(e instanceof Error ? e.message : "Couldn't load the log."),
      );
    };
    void first();
    const timer = setInterval(poll, POLL_MS);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [queryKey]);

  function loadOlder() {
    const oldest = entries?.at(-1)?.id;
    if (oldest === undefined) return;
    setLoadingOlder(true);
    api
      .log({ ...query, before: oldest, limit: PAGE })
      .then(
        (page) => {
          setEntries((list) => [...(list ?? []), ...page.entries]);
          setMore(page.more);
        },
        (e: unknown) => setError(e instanceof Error ? e.message : "Couldn't load older entries."),
      )
      .finally(() => setLoadingOlder(false));
  }

  const toggleKind = (kind: AdminLogKind) =>
    setKinds((list) => {
      if (list.includes(kind)) return list.length === 1 ? list : list.filter((k) => k !== kind);
      return ADMIN_LOG_KINDS.filter((k) => k === kind || list.includes(k));
    });
  const toggleRow = (id: number) =>
    setExpanded((set) => {
      const next = new Set(set);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const llm = s.llm;
  const reasons = Object.entries(llm.fallbackReasons);
  const tables = [...s.tables].sort((a, b) => a.game.localeCompare(b.game) || a.name.localeCompare(b.name));

  return (
    <>
      <div className="adm-toolbar">
        <h2 className="adm-h">Logging</h2>
        {kinds.includes("llm") && (
          <span className="muted adm-note">
            AI: {llm.calls} decisions · {llm.fallbacks} fallbacks{reasons.length > 0 && ` (${reasons.map(([r, n]) => `${r}: ${n}`).join(", ")})`} ·{" "}
            avg {(llm.avgMs / 1000).toFixed(1)}s · {usd(llm.totalCostUsd)}
          </span>
        )}
      </div>

      <div className="adm-log-filters">
        <div className="adm-kinds" role="group" aria-label="Event types">
          {ADMIN_LOG_KINDS.map((kind) => (
            <button key={kind} type="button" className={kinds.includes(kind) ? "on" : ""} aria-pressed={kinds.includes(kind)} onClick={() => toggleKind(kind)}>
              {ADMIN_LOG_KIND_LABEL[kind]}
              <span className="adm-kind-count">{counts ? counts[kind].toLocaleString() : "…"}</span>
            </button>
          ))}
        </div>
        <select value={game} onChange={(e) => setGame(e.target.value as GameType | "")} aria-label="Game">
          <option value="">All games</option>
          <option value="poker">Poker</option>
          <option value="blackjack">Blackjack</option>
        </select>
        <select value={tableId} onChange={(e) => setTableId(e.target.value)} aria-label="Table" className="adm-log-table-select">
          <option value="">All tables</option>
          {tables.map((t) => (
            <option key={t.id} value={t.id}>
              {t.name} ({t.game === "poker" ? "poker" : "blackjack"})
            </option>
          ))}
        </select>
        <input className="adm-search" placeholder="Search names, tables, text" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search the log" />
        <label className="checkbox adm-log-humans">
          <input type="checkbox" checked={humansOnly} onChange={(e) => setHumansOnly(e.target.checked)} />
          Only hands with players
        </label>
      </div>

      {error && <p className="adm-banner">{error}</p>}
      <div className="adm-list">
        <div className="adm-log adm-log-head">
          <span>Time</span>
          <span>Type</span>
          <span>Table</span>
          <span>Players</span>
          <span>What happened</span>
        </div>
        {entries === null && !error && <p className="adm-empty muted">Loading…</p>}
        {entries?.length === 0 && <p className="adm-empty muted">Nothing logged{kinds.length < 3 || game || tableId || q || humansOnly ? " that matches these filters" : " yet"}.</p>}
        {entries?.map((e) => {
          const open = expanded.has(e.id);
          const refused = e.admin && !e.admin.ok;
          return (
            <Fragment key={e.id}>
              <div
                className={`adm-log ${open ? "open" : ""}`}
                role="button"
                tabIndex={0}
                aria-expanded={open}
                onClick={() => toggleRow(e.id)}
                onKeyDown={(k) => {
                  if (k.target === k.currentTarget && (k.key === "Enter" || k.key === " ")) {
                    k.preventDefault();
                    toggleRow(e.id);
                  }
                }}
              >
                <span className="num muted">{clock(e.at)}</span>
                <span>
                  <span className={`tag adm-kind-tag ${e.kind === "admin" ? (refused ? "danger" : "gold") : ""}`}>
                    {refused ? "Refused" : e.kind === "hand" ? (e.game === "blackjack" ? "Blackjack" : "Poker") : KIND_TAG[e.kind]}
                  </span>
                </span>
                <span className="adm-ellipsis" title={e.table ? `${e.table.name} (${e.game})` : undefined}>
                  {e.table ? e.table.name : <span className="muted">—</span>}
                </span>
                <span className="adm-ellipsis">
                  <Players players={e.players} open={openCareer} />
                </span>
                <span className="adm-ellipsis adm-log-summary" title={e.summary}>
                  <i className="caret">{open ? "▾" : "▸"}</i>
                  {e.summary}
                </span>
              </div>
              {open && (
                <div className="adm-log-detail">
                  {e.hand?.game === "poker" && <PokerDetail hand={e.hand} open={openCareer} />}
                  {e.hand?.game === "blackjack" && <BlackjackDetail round={e.hand} open={openCareer} />}
                  {e.llm && <LlmDetail llm={e.llm} />}
                  {e.admin && (
                    <dl className="adm-log-facts">
                      <dt>Action</dt>
                      <dd>{ADMIN_ACTION_LABEL[e.admin.action]}</dd>
                      <dt>Player</dt>
                      <dd>{e.admin.target ? <PlayerName player={e.admin.target} open={openCareer} /> : "—"}</dd>
                      <dt>Result</dt>
                      <dd className={e.admin.ok ? "" : "loss"}>{e.admin.ok ? "Done" : `Refused: ${e.admin.error}`}</dd>
                      <dt>When</dt>
                      <dd>{new Date(e.at).toLocaleString()}</dd>
                    </dl>
                  )}
                </div>
              )}
            </Fragment>
          );
        })}
      </div>
      {more && entries && entries.length > 0 && (
        <div className="adm-log-more">
          <button className="secondary adm-small" disabled={loadingOlder} onClick={loadOlder}>
            {loadingOlder ? "Loading…" : "Load older"}
          </button>
        </div>
      )}
    </>
  );
}

function PokerDetail({ hand, open }: { hand: PokerHandLog; open: OpenCareer }) {
  return (
    <>
      <dl className="adm-log-facts">
        <dt>Poker hand</dt>
        <dd>#{hand.handId}</dd>
        <dt>Blinds</dt>
        <dd>{hand.stakes}</dd>
        <dt>Board</dt>
        <dd>
          <Cards cards={hand.board} />
        </dd>
        <dt>Pot</dt>
        <dd>{formatDD(hand.pot)}</dd>
      </dl>
      <div className="table-scroll">
        <table className="history-table adm-log-hand">
          <thead>
            <tr>
              <th>Player</th>
              <th>Pos</th>
              <th>Last action</th>
              <th>Shown</th>
              <th className="num">Wagered</th>
              <th className="num">Net</th>
              <th>Result</th>
            </tr>
          </thead>
          <tbody>
            {hand.seats.map((seat) => (
              <tr key={seat.seat}>
                <td>
                  <PlayerName player={seat.player} open={open} />
                </td>
                <td>{seat.position ?? ""}</td>
                <td>{seat.lastAction ?? "—"}</td>
                <td>
                  {seat.shown ? (
                    <>
                      <Cards cards={seat.shown} /> <span className="muted">{seat.showdownHand}</span>
                    </>
                  ) : (
                    <span className="muted">—</span>
                  )}
                </td>
                <td className="num">{formatDD(seat.wagered)}</td>
                <td className={`num ${tone(seat.net)}`}>{signed(seat.net)}</td>
                <td>{POKER_RESULT[seat.result]}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

function BlackjackDetail({ round, open }: { round: BlackjackRoundLog; open: OpenCareer }) {
  return (
    <>
      <dl className="adm-log-facts">
        <dt>Blackjack round</dt>
        <dd>#{round.roundId}</dd>
        <dt>Limits</dt>
        <dd>{round.stakes}</dd>
        <dt>Dealer</dt>
        <dd>
          <Cards cards={round.dealer.cards} /> <span className="muted">{round.dealer.total > 21 ? `bust (${round.dealer.total})` : round.dealer.total}</span>
        </dd>
      </dl>
      <div className="table-scroll">
        <table className="history-table adm-log-hand">
          <thead>
            <tr>
              <th>Spot</th>
              <th>Player</th>
              <th>Hands</th>
              <th className="num">Insurance</th>
              <th className="num">Net</th>
            </tr>
          </thead>
          <tbody>
            {round.spots.map((spot) => (
              <tr key={spot.spot}>
                <td>{spot.spot + 1}</td>
                <td>
                  <PlayerName player={spot.player} open={open} />
                </td>
                <td>
                  <div className="adm-bj-hands">
                    {spot.hands.map((h, i) => (
                      <span key={i}>
                        <Cards cards={h.cards} /> <span className="muted">{formatDD(h.bet)}{h.doubled ? " doubled" : ""}{h.split ? " split" : ""} · {BJ_RESULT_LABEL[h.result]}</span>
                      </span>
                    ))}
                  </div>
                </td>
                <td className="num">{spot.insurance > 0 ? `${formatDD(spot.insurance)} → ${formatDD(spot.insurancePayout)}` : "—"}</td>
                <td className={`num ${tone(spot.net)}`}>{spot.net === 0 ? "Push" : signed(spot.net)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

function LlmDetail({ llm }: { llm: LlmLog }) {
  return (
    <dl className="adm-log-facts">
      <dt>Bot</dt>
      <dd>{llm.bot.name}</dd>
      <dt>Poker hand</dt>
      <dd>#{llm.handId}</dd>
      <dt>Action</dt>
      <dd>{llm.action}</dd>
      <dt>Decided by</dt>
      <dd className={llm.fallback ? "loss" : ""}>{llm.fallback ? `Script (fallback: ${llm.fallback})` : "Claude"}</dd>
      <dt>Time taken</dt>
      <dd>{(llm.ms / 1000).toFixed(1)}s</dd>
      <dt>Cost</dt>
      <dd>{usd(llm.costUsd)}</dd>
    </dl>
  );
}
