import { Fragment, useEffect, useState } from "react";
import {
  BJ_RESULT_LABEL,
  formatDD,
  type BlackjackRoundRecord,
  type BlackjackStats,
  type CareerView,
  type HandRecord,
  type PlayingCard,
  type PokerHandRecord,
  type PokerStats,
  type TableSession,
} from "@owl-in/shared";
import { socket } from "../networking/socket";
import { ChipChart } from "../components/ChipChart";
import { PrivacyToggle } from "./NamePage";

const fmt = formatDD;
/** "+$10" / "-$20" / "$0". */
const signed = (n: number) => (n > 0 ? `+${fmt(n)}` : n < 0 ? `-${fmt(-n)}` : fmt(0));
const tone = (n: number) => (n > 0 ? "gold" : n < 0 ? "loss" : "");
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
const pct = (part: number, whole: number) => (whole > 0 ? `${Math.round((part / whole) * 100)}%` : "—");

const SUIT = { spades: "♠", hearts: "♥", diamonds: "♦", clubs: "♣" } as const;

export function Cards({ cards }: { cards: PlayingCard[] | null }) {
  if (cards === null) return <span className="muted">Hidden</span>;
  if (cards.length === 0) return <span className="muted">—</span>;
  return (
    <span className="text-cards">
      {cards.map((c, i) => (
        <b key={i} className={c.suit === "hearts" || c.suit === "diamonds" ? "red" : ""}>
          {c.rank}
          {SUIT[c.suit]}
        </b>
      ))}
    </span>
  );
}

function when(ms: number): string {
  const d = new Date(ms);
  const today = new Date().toDateString() === d.toDateString();
  const time = d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  return today ? time : `${d.toLocaleDateString([], { month: "short", day: "numeric" })} ${time}`;
}

function duration(from: number, to: number): string {
  const minutes = Math.max(0, Math.round((to - from) / 60_000));
  return minutes < 60 ? `${minutes} min` : `${Math.floor(minutes / 60)} h ${minutes % 60} min`;
}

/** One flat horizontal bar per outcome: count and share of the total. */
function RateBars({ rows, total }: { rows: { label: string; count: number; kind: "win" | "loss" | "neutral" }[]; total: number }) {
  return (
    <div className="rate-bars">
      {rows.map((r) => (
        <div className="rate-row" key={r.label}>
          <span className="rate-label">{r.label}</span>
          <span className="rate-track">
            <i className={r.kind} style={{ width: total > 0 ? `${(r.count / total) * 100}%` : 0 }} />
          </span>
          <span className="rate-value">
            {pct(r.count, total)} <small>{r.count}</small>
          </span>
        </div>
      ))}
    </div>
  );
}

function Money({ items }: { items: { label: string; value: number; signed?: boolean }[] }) {
  return (
    <div className="money-grid">
      {items.map((m) => (
        <div key={m.label}>
          <small>{m.label}</small>
          <strong className={m.signed ? tone(m.value) : ""}>{m.signed ? signed(m.value) : fmt(m.value)}</strong>
        </div>
      ))}
    </div>
  );
}

function PokerPanel({ s }: { s: PokerStats }) {
  return (
    <article className="career-panel">
      <header>
        <h2>Texas Hold'em</h2>
        <span className="muted">{plural(s.hands, "hand")}</span>
      </header>
      <RateBars
        total={s.hands}
        rows={[
          { label: "Won", count: s.won, kind: "win" },
          { label: "Split pot", count: s.splitPot, kind: "neutral" },
          { label: "Lost", count: s.lost, kind: "loss" },
          { label: "Folded", count: s.folded, kind: "neutral" },
        ]}
      />
      <p className="career-note">
        Showdowns won <b>{pct(s.showdownsWon, s.showdowns)}</b> <span className="muted">({s.showdownsWon} of {s.showdowns})</span>
      </p>
      <Money
        items={[
          { label: "Wagered", value: s.wagered },
          { label: "Won back", value: s.returned },
          { label: "Net", value: s.net, signed: true },
          { label: "Vs players", value: s.netVsPlayers, signed: true },
          { label: "Vs bots", value: s.netVsBots, signed: true },
        ]}
      />
    </article>
  );
}

function BlackjackPanel({ s }: { s: BlackjackStats }) {
  return (
    <article className="career-panel">
      <header>
        <h2>Blackjack</h2>
        <span className="muted">
          {plural(s.hands, "hand")} · {plural(s.rounds, "round")}
        </span>
      </header>
      <RateBars
        total={s.hands}
        rows={[
          { label: "Won", count: s.wins, kind: "win" },
          { label: "Push", count: s.pushes, kind: "neutral" },
          { label: "Lost", count: s.losses, kind: "loss" },
        ]}
      />
      <div className="mini-rates">
        <span>Blackjack <b>{pct(s.blackjacks, s.hands)}</b></span>
        <span>Bust <b>{pct(s.busts, s.hands)}</b></span>
        <span>Split <b>{pct(s.splits, s.rounds)}</b></span>
        <span>Double <b>{pct(s.doubles, s.hands)}</b></span>
        <span>Surrender <b>{pct(s.surrenders, s.hands)}</b></span>
        <span>Insurance <b>{pct(s.insurances, s.rounds)}</b></span>
      </div>
      <Money
        items={[
          { label: "Wagered", value: s.wagered },
          { label: "Won back", value: s.returned },
          { label: "Net vs house", value: s.net, signed: true },
        ]}
      />
    </article>
  );
}

const END_LABEL = { left: "Left", busted: "Busted", removed: "Removed (away)", "table closed": "Table closed" } as const;

function PokerHands({ hands }: { hands: PokerHandRecord[] }) {
  return (
    <table className="hand-table">
      <thead>
        <tr>
          <th>Hand</th>
          <th>Time</th>
          <th>Pos</th>
          <th>Cards</th>
          <th>Board</th>
          <th>Last action</th>
          <th>Result</th>
          <th className="num">Pot</th>
          <th className="num">Wagered</th>
          <th className="num">Net</th>
          <th className="num">Vs players</th>
          <th className="num">Vs bots</th>
        </tr>
      </thead>
      <tbody>
        {hands.map((h) => (
          <tr key={h.handId} data-hb={`hand:${h.handId}`}>
            <td>#{h.handId}</td>
            <td>{when(h.at)}</td>
            <td>{h.position ?? "—"}</td>
            <td>
              <Cards cards={h.holeCards} />
            </td>
            <td>
              <Cards cards={h.board} />
            </td>
            <td>{h.lastAction ?? "—"}</td>
            <td className={`result ${h.result}`}>
              {h.result === "split" ? "Split pot" : h.result[0]!.toUpperCase() + h.result.slice(1)}
              {h.showdownHand && <small>{h.showdownHand}</small>}
            </td>
            <td className="num">{fmt(h.pot)}</td>
            <td className="num">{fmt(h.wagered)}</td>
            <td className={`num ${tone(h.net)}`}>{signed(h.net)}</td>
            <td className={`num ${tone(h.vsPlayers)}`}>{signed(h.vsPlayers)}</td>
            <td className={`num ${tone(h.vsBots)}`}>{signed(h.vsBots)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function BlackjackRounds({ rounds }: { rounds: BlackjackRoundRecord[] }) {
  return (
    <table className="hand-table">
      <thead>
        <tr>
          <th>Round</th>
          <th>Time</th>
          <th>Your hands</th>
          <th>Dealer</th>
          <th className="num">Wagered</th>
          <th className="num">Won back</th>
          <th className="num">Net</th>
        </tr>
      </thead>
      <tbody>
        {rounds.map((r) => (
          <tr key={r.roundId} data-hb={`round:${r.roundId}`}>
            <td>#{r.roundId}</td>
            <td>{when(r.at)}</td>
            <td>
              <div className="bj-history">
                {r.spots.flatMap((spot) =>
                  spot.hands.map((h, i) => (
                    <div key={`${spot.spot}-${i}`}>
                      <span className="muted">Spot {spot.spot + 1}</span> <Cards cards={h.cards} />{" "}
                      <span className="muted">{fmt(h.bet)}{h.doubled ? " doubled" : ""}</span>{" "}
                      <span className={`result ${h.result}`}>{BJ_RESULT_LABEL[h.result]}</span>
                      {i === 0 && spot.insurance > 0 && (
                        <span className="muted"> · insured {fmt(spot.insurance)}{spot.insurancePayout > 0 ? " (paid)" : ""}</span>
                      )}
                    </div>
                  )),
                )}
              </div>
            </td>
            <td>
              <Cards cards={r.dealer.cards} /> <span className="muted">{r.dealer.total}</span>
            </td>
            <td className="num">{fmt(r.wagered)}</td>
            <td className="num">{fmt(r.returned)}</td>
            <td className={`num ${tone(r.net)}`}>{signed(r.net)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** One table visit; click to load its hands. */
/** Loads one table session's hands (the player site uses the socket, the admin panel the management API). */
export type LoadSession = (sessionId: string) => Promise<HandRecord[]>;

function SessionRow({ session, loadSession, first }: { session: TableSession; loadSession: LoadSession; first: boolean }) {
  const [open, setOpen] = useState(false);
  const [hands, setHands] = useState<HandRecord[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  function toggle() {
    const next = !open;
    setOpen(next);
    if (next) {
      loadSession(session.id).then(setHands, (e: unknown) => setError(e instanceof Error ? e.message : "Couldn't load the hands."));
    }
  }

  const s = session;
  return (
    <Fragment>
      <tr
        className={`session-row ${open ? "open" : ""}`}
        data-hb={`session:${session.id}`}
        data-hb-initial={first ? "" : undefined}
        onClick={toggle}
      >
        <td>
          <i className="caret">{open ? "▾" : "▸"}</i>
          {s.game === "poker" ? "Poker" : "Blackjack"}
        </td>
        <td className="session-table">{s.roomName}</td>
        <td>{s.stakes}</td>
        <td>{when(s.joinedAt)}</td>
        <td>{s.leftAt === null ? <span className="tag gold">Playing now</span> : when(s.leftAt)}</td>
        <td>{duration(s.joinedAt, s.leftAt ?? Date.now())}</td>
        <td className="num">{s.hands}</td>
        <td className="num">
          {s.buyIn === null ? "—" : `${fmt(s.buyIn)} → ${s.cashOut === null ? "…" : fmt(s.cashOut)}`}
        </td>
        <td className="num">{fmt(s.wagered)}</td>
        <td className={`num ${tone(s.net)}`}>{signed(s.net)}</td>
        <td>{s.endReason ? END_LABEL[s.endReason] : "—"}</td>
      </tr>
      {open && (
        <tr className="session-detail">
          <td colSpan={11}>
            {error && <p className="form-error">{error}</p>}
            {!error && hands === null && <p className="muted">Loading hands…</p>}
            {hands?.length === 0 && <p className="muted">No hands played at this table.</p>}
            {hands && hands.length > 0 && (
              <div className="table-scroll">
                {s.game === "poker" ? (
                  <PokerHands hands={hands.filter((h): h is PokerHandRecord => h.game === "poker").reverse()} />
                ) : (
                  <BlackjackRounds rounds={hands.filter((h): h is BlackjackRoundRecord => h.game === "blackjack").reverse()} />
                )}
              </div>
            )}
          </td>
        </tr>
      )}
    </Fragment>
  );
}

/** Everything below the career page's header: totals, chip chart, game panels and table history. */
export function CareerDetails({ career: c, loadSession }: { career: CareerView; loadSession: LoadSession }) {
  return (
    <>
      <div className="career-summary">
        <div>
          <small>Dining Dollars</small>
          <strong className="gold">{fmt(c.bankroll)}</strong>
        </div>
        <div>
          <small>Net, all games</small>
          <strong className={tone(c.net)}>{signed(c.net)}</strong>
        </div>
        <div>
          <small>Total wagered</small>
          <strong>{fmt(c.wagered)}</strong>
        </div>
        <div>
          <small>Hands played</small>
          <strong>{c.poker.hands + c.blackjack.hands}</strong>
        </div>
      </div>

      <ChipChart points={c.chipHistory} />

      <div className="career-games">
        <PokerPanel s={c.poker} />
        <BlackjackPanel s={c.blackjack} />
      </div>

      <h2 className="section-title">Table history</h2>
      {c.sessions.length === 0 ? (
        <p className="muted">No tables yet.</p>
      ) : (
        <div className="table-scroll history-wrap">
          <table className="history-table">
            <thead>
              <tr>
                <th>Game</th>
                <th>Table</th>
                <th>Stakes</th>
                <th>Joined</th>
                <th>Left</th>
                <th>Time</th>
                <th className="num">Hands</th>
                <th className="num">Buy-in → cash-out</th>
                <th className="num">Wagered</th>
                <th className="num">Net</th>
                <th>Ended</th>
              </tr>
            </thead>
            <tbody>
              {c.sessions.map((s, i) => (
                <SessionRow key={s.id} session={s} loadSession={loadSession} first={i === 0} />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

export function CareerPage(props: { playerId: string | null; onBack: () => void; onPrivacyChanged: (isPublic: boolean) => void }) {
  const { playerId, onBack, onPrivacyChanged } = props;
  const [career, setCareer] = useState<CareerView | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const load = () =>
      socket.emit("career:get", playerId, (result) => {
        if (result.ok) {
          setCareer(result.career);
          setError(null);
        } else setError(result.error);
      });
    load();
    const id = window.setInterval(load, 10_000);
    return () => window.clearInterval(id);
  }, [playerId]);

  function setPrivacy(isPublic: boolean) {
    socket.emit("career:set-privacy", isPublic, (result) => {
      if (!result.ok) return setError(result.error);
      onPrivacyChanged(isPublic);
      setCareer((c) => (c ? { ...c, isPublic } : c));
    });
  }

  const loadSession: LoadSession = (sessionId) =>
    new Promise((resolve, reject) =>
      socket.emit("career:session", { playerId, sessionId }, (result) => (result.ok ? resolve(result.hands) : reject(new Error(result.error)))),
    );

  const back = <button className="back" data-hb-back onClick={onBack}>{playerId ? "← Leaderboard" : "← Games"}</button>;
  if (!career) {
    return (
      <section className="lobby">
        {back}
        <div className="hero room-hero">
          <div>
            <p className="eyebrow">CAREER</p>
            {error ? <p className="form-error">{error}</p> : <p className="muted">Loading…</p>}
          </div>
        </div>
      </section>
    );
  }

  const c = career;
  return (
    <section className="lobby career">
      {back}
      <div className="hero room-hero">
        <div>
          <p className="eyebrow">{c.isMe ? "YOUR CAREER" : "CAREER"}</p>
          <h1>{c.name}</h1>
          <div className="career-tags">
            <span className="online">
              <i className={c.online ? "" : "off"} /> {c.online ? "Online" : "Offline"}
            </span>
            {!c.isMe && <span className="tag">{c.isPublic ? "Public" : "Private"}</span>}
          </div>
        </div>
        {c.isMe && (
          <div className="privacy-choice">
            <small>Career visibility</small>
            <PrivacyToggle value={c.isPublic} onChange={setPrivacy} />
          </div>
        )}
      </div>
      {error && <p className="form-error lobby-error">{error}</p>}

      <CareerDetails career={c} loadSession={loadSession} />
    </section>
  );
}
