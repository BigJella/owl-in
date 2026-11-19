import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import {
  ALLOWED_BIG_BLINDS,
  BJ_ALLOWED_MIN_BETS,
  BJ_BOT_SPOTS,
  POKER_MAX_SEATS,
  formatDD,
  type AdminPlayer,
  type AdminSeat,
  type AdminSnapshot,
  type AdminTable,
  type AdminTimeout,
  type LlmStats,
} from "@owl-in/shared";
import { api, ApiError, isLocalPage } from "./api";

type Tab = "overview" | "tables" | "players" | "timeouts" | "ai";
const TABS: { id: Tab; label: string }[] = [
  { id: "overview", label: "Overview" },
  { id: "tables", label: "Tables" },
  { id: "players", label: "Players" },
  { id: "timeouts", label: "Timeouts" },
  { id: "ai", label: "AI log" },
];

/** Runs an admin action: shows the result as a toast and refreshes the snapshot. Resolves true on success. */
type Run = (action: () => Promise<unknown>, done: string) => Promise<boolean>;
type OpenDialog = (dialog: ReactNode) => void;

const range = (n: number) => Array.from({ length: n + 1 }, (_, i) => i);

/** "12m 05s", "1h 04m". */
function duration(ms: number): string {
  const s = Math.max(0, Math.ceil(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h > 0) return `${h}h ${String(m).padStart(2, "0")}m`;
  return `${m}m ${String(s % 60).padStart(2, "0")}s`;
}

const clock = (at: number) => new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
const usd = (n: number | null) => (n === null ? "—" : `$${n.toFixed(n < 0.01 ? 4 : 2)}`);

export function AdminApp() {
  const [tab, setTab] = useState<Tab>("overview");
  const [snapshot, setSnapshot] = useState<AdminSnapshot | null>(null);
  const [offline, setOffline] = useState<string | null>(null);
  const [locked, setLocked] = useState(!isLocalPage());
  const [toast, setToast] = useState<{ text: string; bad: boolean } | null>(null);
  const [dialog, setDialog] = useState<ReactNode>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const refresh = useCallback(async () => {
    try {
      setSnapshot(await api.snapshot());
      setOffline(null);
    } catch (error) {
      if (error instanceof ApiError && error.status === 403) setLocked(true);
      else setOffline(error instanceof Error ? error.message : "Can't reach the server.");
    }
  }, []);

  useEffect(() => {
    if (locked) return;
    void refresh();
    const timer = setInterval(() => void refresh(), 1000);
    return () => clearInterval(timer);
  }, [locked, refresh]);

  const showToast = (text: string, bad = false) => {
    if (toastTimer.current) clearTimeout(toastTimer.current);
    setToast({ text, bad });
    toastTimer.current = setTimeout(() => setToast(null), 3500);
  };

  const run: Run = async (action, done) => {
    try {
      await action();
      showToast(done);
      void refresh();
      return true;
    } catch (error) {
      showToast(error instanceof Error ? error.message : "That didn't work.", true);
      return false;
    }
  };

  if (locked) {
    return (
      <section className="lobby name-screen">
        <div className="name-card">
          <p className="eyebrow">OWL IN ADMIN</p>
          <h1>This computer only.</h1>
          <p className="muted">The admin panel only works on the computer running the OWL IN server. Open localhost:5173/admin.html there.</p>
        </div>
      </section>
    );
  }

  const close = () => setDialog(null);
  const open: OpenDialog = (node) => setDialog(node);

  return (
    <div className="adm">
      <header className="adm-bar">
        <div className="brand">
          <span className="owl-mark">O</span>
          <span className="display adm-brand">OWL IN <span className="gold">ADMIN</span></span>
        </div>
        <nav className="adm-tabs" aria-label="Admin sections">
          {TABS.map((t) => (
            <button key={t.id} className={tab === t.id ? "on" : ""} aria-current={tab === t.id ? "page" : undefined} onClick={() => setTab(t.id)}>
              {t.label}
              {t.id === "timeouts" && snapshot && snapshot.timeouts.length > 0 && <span className="adm-count">{snapshot.timeouts.length}</span>}
            </button>
          ))}
        </nav>
        <span className={`adm-live ${offline ? "bad" : ""}`} title={offline ?? undefined}>
          {offline ? "Offline" : snapshot ? `Live · ${clock(snapshot.at)}` : "Connecting…"}
        </span>
      </header>

      <main className="adm-main">
        {offline && <p className="adm-banner">{offline} Showing the last data received; retrying every second.</p>}
        {!snapshot ? (
          <p className="muted">Loading…</p>
        ) : tab === "overview" ? (
          <Overview s={snapshot} />
        ) : tab === "tables" ? (
          <Tables s={snapshot} run={run} open={open} close={close} />
        ) : tab === "players" ? (
          <Players s={snapshot} run={run} open={open} close={close} />
        ) : tab === "timeouts" ? (
          <Timeouts s={snapshot} run={run} open={open} close={close} />
        ) : (
          <AiLog />
        )}
      </main>

      {dialog && (
        <div className="modal-backdrop" onClick={close}>
          <div className="modal" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true">
            {dialog}
          </div>
        </div>
      )}
      {toast && <div className={`adm-toast ${toast.bad ? "bad" : ""}`} role="status">{toast.text}</div>}
    </div>
  );
}

// ---------- Overview ----------

function Stat({ label, value, note, tone }: { label: string; value: ReactNode; note?: ReactNode; tone?: "gold" | "bad" | "ok" }) {
  return (
    <div className="adm-stat">
      <small>{label}</small>
      <strong className={tone ?? ""}>{value}</strong>
      <span className="muted">{note ?? " "}</span>
    </div>
  );
}

function Overview({ s }: { s: AdminSnapshot }) {
  const t = s.totals;
  const llm = s.llm;
  return (
    <>
      <h2 className="adm-h">Money</h2>
      <div className="adm-stats">
        <Stat
          label="All Dining Dollars"
          value={formatDD(t.total)}
          note={t.conserved ? "Conserved ✓" : `Expected ${formatDD(t.expected)} (off by ${formatDD(t.total - t.expected)})`}
          tone={t.conserved ? "gold" : "bad"}
        />
        <Stat label="House bank" value={formatDD(t.house)} />
        <Stat label="Player bankrolls" value={formatDD(t.bankrolls)} />
        <Stat label="On poker tables" value={formatDD(t.onPokerTables)} />
        <Stat label="On blackjack tables" value={formatDD(t.onBlackjackTables)} />
      </div>
      <h2 className="adm-h">People & tables</h2>
      <div className="adm-stats">
        <Stat label="Players online" value={t.playersOnline} note={`${t.playersKnown} known this run`} />
        <Stat label="At tables" value={t.playersAtTables} />
        <Stat label="Banned" value={t.banned} tone={t.banned > 0 ? "bad" : undefined} />
        <Stat label="Timeouts" value={s.timeouts.length} />
        <Stat label="Tables" value={t.pokerTables + t.blackjackTables} note={`${t.pokerTables} poker · ${t.blackjackTables} blackjack`} />
      </div>
      <h2 className="adm-h">AI players</h2>
      <div className="adm-stats">
        <Stat label="Claude" value={llm.available ? "Ready" : "Not found"} note={llm.model} tone={llm.available ? "ok" : "bad"} />
        <Stat label="LLM decisions" value={llm.calls} note={`${llm.fallbacks} fell back to script`} />
        <Stat label="Avg / p95 latency" value={`${(llm.avgMs / 1000).toFixed(1)}s`} note={`p95 ${(llm.p95Ms / 1000).toFixed(1)}s`} />
        <Stat label="Spent" value={usd(llm.totalCostUsd)} note="Reported by the CLI" />
        <Stat label="AI bots seated" value={s.tables.reduce((n, table) => n + table.aiBots, 0)} note={`${s.tables.reduce((n, table) => n + table.bots, 0)} bots in all`} />
      </div>
      <div className="adm-split">
        <div>
          <h2 className="adm-h">Richest players</h2>
          <div className="adm-list">
            {s.players.slice(0, 6).map((p, i) => (
              <div key={p.id} className="adm-row adm-rank">
                <span className="muted">{i + 1}</span>
                <span className="adm-ellipsis">{p.name}</span>
                <span className="num gold">{formatDD(p.total)}</span>
              </div>
            ))}
            {s.players.length === 0 && <p className="adm-empty muted">Nobody has picked a name yet.</p>}
          </div>
        </div>
        <div>
          <h2 className="adm-h">Latest AI decisions</h2>
          <div className="adm-list">
            {llm.recent.slice(0, 6).map((d, i) => (
              <div key={`${d.at}-${i}`} className="adm-row adm-recent">
                <span className="adm-ellipsis">{d.bot}</span>
                <span className="adm-ellipsis">{d.action}</span>
                <span className={`num ${d.fallback ? "bad" : "muted"}`}>{d.fallback ? "script" : `${(d.ms / 1000).toFixed(1)}s`}</span>
              </div>
            ))}
            {llm.recent.length === 0 && <p className="adm-empty muted">No AI decisions yet (AI bots only use Claude while a human is at their table).</p>}
          </div>
        </div>
      </div>
    </>
  );
}

// ---------- Tables ----------

interface ActionProps {
  s: AdminSnapshot;
  run: Run;
  open: OpenDialog;
  close: () => void;
}

function Tables({ s, run, open, close }: ActionProps) {
  return (
    <>
      <div className="adm-toolbar">
        <h2 className="adm-h">Tables</h2>
        <button className="primary" onClick={() => open(<CreateTableDialog run={run} close={close} />)}>+ Create table</button>
      </div>
      {s.tables.map((table) => (
        <TableCard key={table.id} table={table} run={run} open={open} close={close} />
      ))}
    </>
  );
}

function TableCard({ table, run, open, close }: { table: AdminTable; run: Run; open: OpenDialog; close: () => void }) {
  const poker = table.game === "poker";
  const maxBots = poker ? POKER_MAX_SEATS : BJ_BOT_SPOTS;
  return (
    <section className="adm-table">
      <div className="adm-table-head">
        <div className="adm-table-title">
          <span className="room-name adm-ellipsis" title={table.name}>{table.name}</span>
          <span className="tag">{poker ? "Poker" : "Blackjack"}</span>
          {table.closing && <span className="tag danger">Closing</span>}
        </div>
        <span className="num">{table.stakes}</span>
        <span className="adm-ellipsis">
          {table.stage}
          {table.handId > 0 && <span className="muted"> · #{table.handId}</span>}
        </span>
        <span className="num">
          {table.humans} <span className="muted">{table.humans === 1 ? "human" : "humans"}</span> · {table.bots}{" "}
          <span className="muted">{table.bots === 1 ? "bot" : "bots"}</span>
          {poker && <> · <span className="gold">{table.aiBots}</span> <span className="muted">AI</span></>}
        </span>
        <span className="num">{formatDD(table.chips)}</span>
      </div>
      <div className="adm-table-settings">
        <label>
          Max bots
          <select
            value={table.settings.maxBots}
            onChange={(e) => void run(() => api.updateTable(table.id, { maxBots: Number(e.target.value) }), `${table.name}: max bots ${e.target.value} (from the next hand)`)}
          >
            {range(maxBots).map((n) => (
              <option key={n} value={n}>{n}</option>
            ))}
          </select>
        </label>
        <label>
          Max AI
          {table.settings.maxAi === null ? (
            <select disabled value="na" title="Blackjack bots have no AI mode yet">
              <option value="na">n/a</option>
            </select>
          ) : (
            <select
              value={table.settings.maxAi}
              onChange={(e) => void run(() => api.updateTable(table.id, { maxAi: Number(e.target.value) }), `${table.name}: max AI ${e.target.value}`)}
            >
              {range(table.settings.maxBots).map((n) => (
                <option key={n} value={n}>{n}</option>
              ))}
            </select>
          )}
        </label>
        <span className="muted adm-note">{poker ? "AI count applies now; bot count at the next hand." : "Applies when the next betting round opens."}</span>
        <button
          className="secondary adm-small"
          disabled={table.closing}
          onClick={() =>
            open(
              <Confirm
                title={`Close ${table.name}?`}
                body={`It closes ${poker ? "after the current hand" : "after the current round"}. Everyone is cashed out to their bankroll.`}
                confirm="Close table"
                danger
                onConfirm={() => run(() => api.closeTable(table.id), `${table.name} is closing`)}
                close={close}
              />,
            )
          }
        >
          Close table
        </button>
      </div>
      <div className="adm-seats">
        <div className="adm-seat adm-seat-head">
          <span>{poker ? "Seat" : "Spot"}</span>
          <span>Player</span>
          <span>{poker ? "Stack" : ""}</span>
          <span>Bet</span>
          <span>Status</span>
          <span>{poker ? "Mode" : ""}</span>
        </div>
        {table.seats.map((seat) => (
          <SeatRow key={seat.playerId} seat={seat} poker={poker} run={run} />
        ))}
        {table.seats.length === 0 && <p className="adm-empty muted">Empty.</p>}
      </div>
    </section>
  );
}

function SeatRow({ seat, poker, run }: { seat: AdminSeat; poker: boolean; run: Run }) {
  const kindTag =
    seat.kind === "human" ? (
      <span className={`tag ${seat.connected ? "" : "danger"}`}>{seat.connected ? "Human" : "Away"}</span>
    ) : (
      <span className={`tag ${seat.botMode === "llm" ? "gold" : ""}`}>{seat.botMode === "llm" ? "AI" : "Bot"}</span>
    );
  const current = seat.botOverride ?? "auto";
  return (
    <div className="adm-seat">
      <span className="num muted">{seat.seat + 1}</span>
      <span className="adm-seat-name">
        {kindTag}
        <span className="adm-ellipsis" title={seat.name}>{seat.name}</span>
      </span>
      <span className="num">{seat.stack === null ? "" : formatDD(seat.stack)}</span>
      <span className="num">{seat.bet > 0 ? formatDD(seat.bet) : "—"}</span>
      <span className="adm-ellipsis muted" title={seat.lastAction ?? seat.status}>{seat.lastAction ?? seat.status}</span>
      <span>
        {poker && seat.aiCapable && (
          <span className="segmented adm-mode" role="radiogroup" aria-label={`${seat.name} mode`}>
            {(["auto", "script", "llm"] as const).map((mode) => (
              <button
                key={mode}
                role="radio"
                aria-checked={current === mode}
                className={current === mode ? (mode === "auto" ? "on" : "on pinned") : ""}
                title={mode === "auto" ? "Follow the table's max AI" : mode === "llm" ? "Always Claude" : "Always the script"}
                onClick={() => current !== mode && void run(() => api.botMode(seat.playerId, mode), `${seat.name}: ${mode === "llm" ? "AI" : mode}`)}
              >
                {mode === "llm" ? "AI" : mode}
              </button>
            ))}
          </span>
        )}
      </span>
    </div>
  );
}

function CreateTableDialog({ run, close }: { run: Run; close: () => void }) {
  const [game, setGame] = useState<"poker" | "blackjack">("poker");
  const [name, setName] = useState("");
  const [bigBlind, setBigBlind] = useState(10);
  const [minBet, setMinBet] = useState(10);
  const [maxBots, setMaxBots] = useState(4);
  const [maxAi, setMaxAi] = useState(2);
  const poker = game === "poker";
  const bots = poker ? maxBots : Math.min(maxBots, BJ_BOT_SPOTS);
  return (
    <form
      onSubmit={async (e) => {
        e.preventDefault();
        const ok = await run(
          () => api.createTable(poker ? { game, name, bigBlind, maxBots: bots, maxAi: Math.min(maxAi, bots) } : { game, name, minBet, maxBots: bots }),
          `Created ${name}`,
        );
        if (ok) close();
      }}
    >
      <div className="modal-head">
        <h2>Create table</h2>
        <button type="button" className="close" onClick={close} aria-label="Close">×</button>
      </div>
      <div className="segmented" role="radiogroup" aria-label="Game">
        {(["poker", "blackjack"] as const).map((g) => (
          <button key={g} type="button" role="radio" aria-checked={game === g} className={game === g ? "on" : ""} onClick={() => setGame(g)}>
            {g === "poker" ? "Poker" : "Blackjack"}
          </button>
        ))}
      </div>
      <label>
        Name
        <input value={name} maxLength={24} onChange={(e) => setName(e.target.value)} autoFocus />
      </label>
      {poker ? (
        <label>
          Blinds
          <select value={bigBlind} onChange={(e) => setBigBlind(Number(e.target.value))}>
            {ALLOWED_BIG_BLINDS.map((bb) => (
              <option key={bb} value={bb}>{formatDD(bb / 2)}/{formatDD(bb)}</option>
            ))}
          </select>
        </label>
      ) : (
        <label>
          Minimum bet
          <select value={minBet} onChange={(e) => setMinBet(Number(e.target.value))}>
            {BJ_ALLOWED_MIN_BETS.map((bet) => (
              <option key={bet} value={bet}>{formatDD(bet)}</option>
            ))}
          </select>
        </label>
      )}
      <div className="adm-pair">
        <label>
          Max bots
          <select value={bots} onChange={(e) => setMaxBots(Number(e.target.value))}>
            {range(poker ? POKER_MAX_SEATS : BJ_BOT_SPOTS).map((n) => (
              <option key={n} value={n}>{n}</option>
            ))}
          </select>
        </label>
        <label>
          Max AI
          <select value={poker ? Math.min(maxAi, bots) : "na"} disabled={!poker} onChange={(e) => setMaxAi(Number(e.target.value))}>
            {poker ? range(bots).map((n) => <option key={n} value={n}>{n}</option>) : <option value="na">n/a</option>}
          </select>
        </label>
      </div>
      <div className="dialog-actions">
        <button type="button" className="secondary" onClick={close}>Cancel</button>
        <button className="primary" disabled={!name.trim()}>Create</button>
      </div>
    </form>
  );
}

// ---------- Players ----------

function Players({ s, run, open, close }: ActionProps) {
  const [query, setQuery] = useState("");
  const players = s.players.filter((p) => p.name.toLowerCase().includes(query.trim().toLowerCase()));
  return (
    <>
      <div className="adm-toolbar">
        <h2 className="adm-h">Players</h2>
        <input className="adm-search" placeholder="Search names" value={query} onChange={(e) => setQuery(e.target.value)} aria-label="Search players" />
      </div>
      <div className="adm-list">
        <div className="adm-player adm-player-head">
          <span>Player</span>
          <span>Table</span>
          <span className="num">Bankroll</span>
          <span className="num">At table</span>
          <span className="num">Total</span>
          <span className="adm-actions">Actions</span>
        </div>
        {players.map((p) => (
          <PlayerRow key={p.id} p={p} s={s} run={run} open={open} close={close} />
        ))}
        {players.length === 0 && <p className="adm-empty muted">{s.players.length === 0 ? "Nobody has picked a name yet." : "No match."}</p>}
      </div>
    </>
  );
}

function PlayerRow({ p, s, run, open, close }: ActionProps & { p: AdminPlayer }) {
  return (
    <div className="adm-player">
      <span className="adm-player-name">
        <span className={`adm-dot ${p.online ? "on" : ""}`} title={p.online ? "Online" : "Offline"} />
        <span className="adm-ellipsis" title={p.name}>{p.name}</span>
        {p.banned && <span className="tag danger">Banned</span>}
        {!p.banned && p.timeout && <span className="tag danger" title={p.timeout.reason ?? undefined}>Timed out</span>}
      </span>
      <span className="adm-ellipsis muted" title={p.table?.name}>{p.table ? p.table.name : "—"}</span>
      <span className="num">{formatDD(p.bankroll)}</span>
      <span className="num">{p.atTable > 0 ? formatDD(p.atTable) : "—"}</span>
      <span className="num gold">{formatDD(p.total)}</span>
      <span className="adm-actions">
        <button className="secondary adm-small" disabled={!p.table} onClick={() => open(<KickDialog p={p} run={run} close={close} />)}>Kick</button>
        <button className="secondary adm-small" onClick={() => open(<TimeoutDialog s={s} playerId={p.id} run={run} close={close} />)}>Timeout</button>
        <button className="secondary adm-small" onClick={() => open(<BankrollDialog p={p} run={run} close={close} />)}>$</button>
        <button className="secondary adm-small" onClick={() => open(<RenameDialog p={p} run={run} close={close} />)}>Rename</button>
        {p.banned ? (
          <button
            className="secondary adm-small"
            onClick={() =>
              open(<Confirm title={`Unban ${p.name}?`} body="They can sign in and play again." confirm="Unban" onConfirm={() => run(() => api.unban(p.id), `${p.name} unbanned`)} close={close} />)
            }
          >
            Unban
          </button>
        ) : (
          <button className="secondary adm-small adm-danger" onClick={() => open(<BanDialog p={p} run={run} close={close} />)}>Ban</button>
        )}
      </span>
    </div>
  );
}

function DialogHead({ title, close }: { title: string; close: () => void }) {
  return (
    <div className="modal-head">
      <h2>{title}</h2>
      <button type="button" className="close" onClick={close} aria-label="Close">×</button>
    </div>
  );
}

function Confirm(props: { title: string; body: string; confirm: string; danger?: boolean; onConfirm: () => Promise<boolean>; close: () => void }) {
  return (
    <>
      <DialogHead title={props.title} close={props.close} />
      <p>{props.body}</p>
      <div className="dialog-actions">
        <button className="secondary" onClick={props.close}>Cancel</button>
        <button className={`primary ${props.danger ? "danger" : ""}`} onClick={async () => (await props.onConfirm()) && props.close()} autoFocus>
          {props.confirm}
        </button>
      </div>
    </>
  );
}

function KickDialog({ p, run, close }: { p: AdminPlayer; run: Run; close: () => void }) {
  const [minutes, setMinutes] = useState(0);
  return (
    <form
      onSubmit={async (e) => {
        e.preventDefault();
        if (await run(() => api.kick(p.id, minutes), `${p.name} kicked${minutes > 0 ? ` (${minutes} min timeout)` : ""}`)) close();
      }}
    >
      <DialogHead title={`Kick ${p.name}?`} close={close} />
      <p className="dialog-note">
        They're cashed out from {p.table?.name ?? "their table"}. Mid-hand they play the hand out first.
      </p>
      <label>
        Timeout from this table (minutes, 0 = none)
        <input type="number" min={0} max={10080} value={minutes} onChange={(e) => setMinutes(Math.max(0, Number(e.target.value)))} />
      </label>
      <div className="dialog-actions">
        <button type="button" className="secondary" onClick={close}>Cancel</button>
        <button className="primary danger">Kick</button>
      </div>
    </form>
  );
}

function BanDialog({ p, run, close }: { p: AdminPlayer; run: Run; close: () => void }) {
  const [reason, setReason] = useState("");
  return (
    <form
      onSubmit={async (e) => {
        e.preventDefault();
        if (await run(() => api.ban(p.id, reason), `${p.name} banned`)) close();
      }}
    >
      <DialogHead title={`Ban ${p.name}?`} close={close} />
      <p className="dialog-note">They're removed from their table and disconnected, and this browser can't sign in again until you unban it.</p>
      <label>
        Reason (shown to them, optional)
        <input value={reason} maxLength={200} onChange={(e) => setReason(e.target.value)} autoFocus />
      </label>
      <div className="dialog-actions">
        <button type="button" className="secondary" onClick={close}>Cancel</button>
        <button className="primary danger">Ban</button>
      </div>
    </form>
  );
}

function BankrollDialog({ p, run, close }: { p: AdminPlayer; run: Run; close: () => void }) {
  const [delta, setDelta] = useState(0);
  const after = p.bankroll + delta;
  return (
    <form
      onSubmit={async (e) => {
        e.preventDefault();
        if (await run(() => api.bankroll(p.id, delta), `${p.name}: ${delta > 0 ? "+" : ""}${formatDD(delta)}`)) close();
      }}
    >
      <DialogHead title={`Adjust ${p.name}'s bankroll`} close={close} />
      <p className="dialog-note">Positive gives Dining Dollars, negative takes them. The house bank covers the difference.</p>
      <label>
        Amount
        <input type="number" step={1} value={delta} onChange={(e) => setDelta(Math.trunc(Number(e.target.value)))} autoFocus />
      </label>
      <p className="adm-preview">
        {formatDD(p.bankroll)} → <strong className={after < 0 ? "bad" : "gold"}>{formatDD(after)}</strong>
      </p>
      <div className="dialog-actions">
        <button type="button" className="secondary" onClick={close}>Cancel</button>
        <button className="primary" disabled={delta === 0 || after < 0}>Apply</button>
      </div>
    </form>
  );
}

function RenameDialog({ p, run, close }: { p: AdminPlayer; run: Run; close: () => void }) {
  const [name, setName] = useState(p.name);
  return (
    <form
      onSubmit={async (e) => {
        e.preventDefault();
        if (await run(() => api.rename(p.id, name), `${p.name} is now ${name.trim()}`)) close();
      }}
    >
      <DialogHead title={`Rename ${p.name}`} close={close} />
      <p className="dialog-note">Works while they're seated. Their old name is freed.</p>
      <label>
        New name
        <input value={name} maxLength={16} onChange={(e) => setName(e.target.value)} autoFocus />
      </label>
      <div className="dialog-actions">
        <button type="button" className="secondary" onClick={close}>Cancel</button>
        <button className="primary" disabled={!name.trim() || name.trim() === p.name}>Rename</button>
      </div>
    </form>
  );
}

// ---------- Timeouts ----------

function TimeoutDialog({ s, playerId, existing, run, close }: { s: AdminSnapshot; playerId?: string; existing?: AdminTimeout; run: Run; close: () => void }) {
  const player = s.players.find((p) => p.id === (existing?.playerId ?? playerId));
  const [who, setWho] = useState(existing?.playerId ?? playerId ?? s.players[0]?.id ?? "");
  const [scope, setScope] = useState<"table" | "site">(existing?.scope ?? "site");
  const [roomId, setRoomId] = useState(existing?.roomId ?? player?.table?.id ?? s.tables[0]?.id ?? "");
  const [minutes, setMinutes] = useState(existing ? Math.ceil(existing.remainingMs / 60_000) : 30);
  const [reason, setReason] = useState(existing?.reason ?? "");
  const name = s.players.find((p) => p.id === who)?.name ?? "player";
  return (
    <form
      onSubmit={async (e) => {
        e.preventDefault();
        const ok = await run(
          () => api.setTimeout({ playerId: who, scope, roomId: scope === "table" ? roomId : null, minutes, reason }),
          `${name}: ${minutes} min timeout`,
        );
        if (ok) close();
      }}
    >
      <DialogHead title={existing ? `Edit ${existing.playerName}'s timeout` : "Timeout"} close={close} />
      {!existing && !playerId && (
        <label>
          Player
          <select value={who} onChange={(e) => setWho(e.target.value)}>
            {s.players.map((p) => (
              <option key={p.id} value={p.id}>{p.name}</option>
            ))}
          </select>
        </label>
      )}
      {!existing && (
        <div className="segmented" role="radiogroup" aria-label="Scope">
          {(["site", "table"] as const).map((sc) => (
            <button key={sc} type="button" role="radio" aria-checked={scope === sc} className={scope === sc ? "on" : ""} onClick={() => setScope(sc)}>
              {sc === "site" ? "Every table" : "One table"}
            </button>
          ))}
        </div>
      )}
      {scope === "table" && !existing && (
        <label>
          Table
          <select value={roomId} onChange={(e) => setRoomId(e.target.value)}>
            {s.tables.map((t) => (
              <option key={t.id} value={t.id}>{t.name} ({t.game})</option>
            ))}
          </select>
        </label>
      )}
      <p className="dialog-note">
        {scope === "site"
          ? "They can browse but can't sit at any table until it runs out. If they're seated, they're cashed out."
          : "They can't join this table until it runs out. If they're at it, they're cashed out."}
      </p>
      <label>
        Minutes {existing && <span className="muted">(from now)</span>}
        <input type="number" min={1} max={10080} value={minutes} onChange={(e) => setMinutes(Math.max(1, Math.trunc(Number(e.target.value))))} />
      </label>
      <label>
        Reason (optional)
        <input value={reason} maxLength={200} onChange={(e) => setReason(e.target.value)} />
      </label>
      <div className="dialog-actions">
        <button type="button" className="secondary" onClick={close}>Cancel</button>
        <button className="primary" disabled={!who || (scope === "table" && !roomId)}>{existing ? "Save" : "Time out"}</button>
      </div>
    </form>
  );
}

function Timeouts({ s, run, open, close }: ActionProps) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(timer);
  }, []);
  return (
    <>
      <div className="adm-toolbar">
        <h2 className="adm-h">Timeouts</h2>
        <button className="primary" disabled={s.players.length === 0} onClick={() => open(<TimeoutDialog s={s} run={run} close={close} />)}>+ Add timeout</button>
      </div>
      <div className="adm-list">
        <div className="adm-timeout adm-timeout-head">
          <span>Player</span>
          <span>Where</span>
          <span className="num">Time left</span>
          <span>Reason</span>
          <span className="adm-actions">Actions</span>
        </div>
        {s.timeouts.map((t) => (
          <div key={`${t.playerId}-${t.scope}-${t.roomId}`} className="adm-timeout">
            <span className="adm-ellipsis">{t.playerName}</span>
            <span className="adm-ellipsis">{t.scope === "site" ? <span className="tag danger">Every table</span> : t.roomName}</span>
            <span className="num">{duration(t.until - now)}</span>
            <span className="adm-ellipsis muted" title={t.reason ?? undefined}>{t.reason ?? "—"}</span>
            <span className="adm-actions">
              <button className="secondary adm-small" onClick={() => open(<TimeoutDialog s={s} existing={t} run={run} close={close} />)}>Edit</button>
              <button
                className="secondary adm-small"
                onClick={() => void run(() => api.clearTimeout({ playerId: t.playerId, scope: t.scope, roomId: t.roomId }), `${t.playerName}'s timeout removed`)}
              >
                Remove
              </button>
            </span>
          </div>
        ))}
        {s.timeouts.length === 0 && <p className="adm-empty muted">No timeouts. Players who leave a poker table get a 30-minute one for that table automatically.</p>}
      </div>
    </>
  );
}

// ---------- AI log ----------

function AiLog() {
  const [stats, setStats] = useState<LlmStats | null>(null);
  useEffect(() => {
    const load = () => api.llm(200).then(setStats, () => {});
    void load();
    const timer = setInterval(load, 2000);
    return () => clearInterval(timer);
  }, []);
  if (!stats) return <p className="muted">Loading…</p>;
  const reasons = Object.entries(stats.fallbackReasons);
  return (
    <>
      <div className="adm-toolbar">
        <h2 className="adm-h">AI log</h2>
        <span className="muted adm-note">
          {stats.calls} decisions · {stats.fallbacks} fallbacks{reasons.length > 0 && ` (${reasons.map(([r, n]) => `${r}: ${n}`).join(", ")})`} · {usd(stats.totalCostUsd)}
        </span>
      </div>
      <div className="adm-list">
        <div className="adm-log adm-log-head">
          <span>Time</span>
          <span>Table</span>
          <span>Bot</span>
          <span className="num">Hand</span>
          <span>Action</span>
          <span className="num">Time taken</span>
          <span className="num">Cost</span>
          <span>Fallback</span>
        </div>
        {stats.recent.map((d, i) => (
          <div key={`${d.at}-${i}`} className="adm-log">
            <span className="num muted">{clock(d.at)}</span>
            <span className="adm-ellipsis">{d.table}</span>
            <span className="adm-ellipsis">{d.bot}</span>
            <span className="num muted">#{d.handId}</span>
            <span className="adm-ellipsis">{d.action}</span>
            <span className="num">{(d.ms / 1000).toFixed(1)}s</span>
            <span className="num muted">{usd(d.costUsd)}</span>
            <span className={`adm-ellipsis ${d.fallback ? "bad" : "muted"}`} title={d.fallback ?? undefined}>{d.fallback ?? "—"}</span>
          </div>
        ))}
        {stats.recent.length === 0 && <p className="adm-empty muted">No AI decisions yet. AI bots only ask Claude while a human is at their table.</p>}
      </div>
    </>
  );
}
