import { useEffect, useState, type FormEvent } from "react";
import {
  BJ_ALLOWED_MIN_BETS,
  BJ_MAX_BET_MULT,
  BJ_SPOTS,
  BJ_STAGE_LABEL,
  formatDD,
  type BlackjackRoomSummary,
  type BlackjackStage,
  type Session,
} from "@owl-in/shared";
import { socket } from "../networking/socket";
import { Modal } from "./PokerLobbyPage";

const fmt = formatDD;

type SortKey = "name" | "limits" | "stage" | "spots" | "players";
const STAGE_ORDER: BlackjackStage[] = ["playing", "insurance", "betting", "settled", "waiting"];
const COLUMNS: { key: SortKey; label: string }[] = [
  { key: "name", label: "Table" },
  { key: "limits", label: "Limits" },
  { key: "stage", label: "Stage" },
  { key: "spots", label: "Spots" },
  { key: "players", label: "Players" },
];

/** Spots a human could bet on: anything not already played by a human (bots give way). */
const openSpots = (room: BlackjackRoomSummary) => room.spots.filter((s) => s !== "human").length;

function compareRooms(key: SortKey, a: BlackjackRoomSummary, b: BlackjackRoomSummary): number {
  switch (key) {
    case "name":
      return a.name.localeCompare(b.name);
    case "limits":
      return a.minBet - b.minBet;
    case "stage":
      return STAGE_ORDER.indexOf(a.stage) - STAGE_ORDER.indexOf(b.stage);
    case "spots":
      return openSpots(a) - openSpots(b);
    case "players":
      return a.humans - b.humans;
  }
}

export function BlackjackLobbyPage({ session, onBack }: { session: Session; onBack: () => void }) {
  const [rooms, setRooms] = useState<BlackjackRoomSummary[] | null>(null);
  const [creating, setCreating] = useState(false);
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 }>({ key: "limits", dir: 1 });
  const [openOnly, setOpenOnly] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    socket.on("blackjack:rooms", setRooms);
    socket.emit("blackjack:subscribe-rooms");
    const resubscribe = () => socket.emit("blackjack:subscribe-rooms");
    socket.on("connect", resubscribe);
    return () => {
      socket.off("blackjack:rooms", setRooms);
      socket.off("connect", resubscribe);
      socket.emit("blackjack:unsubscribe-rooms");
    };
  }, []);

  const toggleSort = (key: SortKey) =>
    setSort((current) => (current.key === key ? { key, dir: current.dir === 1 ? -1 : 1 } : { key, dir: 1 }));

  const visible = (rooms ?? [])
    .filter((room) => !openOnly || openSpots(room) > 0 || room.id === session.roomId)
    .sort((a, b) => sort.dir * compareRooms(sort.key, a, b) || a.name.localeCompare(b.name));

  function join(room: BlackjackRoomSummary) {
    setError(null);
    socket.emit("blackjack:join", { roomId: room.id }, (result) => {
      if (!result.ok) setError(result.error);
    });
  }

  return (
    <section className="lobby">
      <button className="back" data-hb-back onClick={onBack}>← Games</button>
      <div className="hero room-hero">
        <div>
          <p className="eyebrow">BLACKJACK</p>
          <h1>Pick a table.</h1>
          <p>Seven spots, six decks. Bet on up to three spots; bots hold spots 1–3 until you want them.</p>
        </div>
        <button className="primary" data-hb="lobby:create" onClick={() => setCreating(true)}>+ Create Table</button>
      </div>

      <div className="room-toolbar">
        <label className="checkbox" data-hb="lobby:open-only">
          <input type="checkbox" checked={openOnly} onChange={(e) => setOpenOnly(e.target.checked)} />
          Open spots only
        </label>
        <label className="sort-select" data-hb="lobby:sort" data-hb-adjust="select">
          Sort by
          <select
            value={`${sort.key}:${sort.dir}`}
            onChange={(e) => {
              const [key, dir] = e.target.value.split(":");
              setSort({ key: key as SortKey, dir: Number(dir) as 1 | -1 });
            }}
          >
            {COLUMNS.flatMap((c) => [
              <option key={`${c.key}:1`} value={`${c.key}:1`}>{c.label} ↑</option>,
              <option key={`${c.key}:-1`} value={`${c.key}:-1`}>{c.label} ↓</option>,
            ])}
          </select>
        </label>
      </div>
      {error && <p className="form-error lobby-error">{error}</p>}

      <div className="room-list">
        <div className="room-row room-head" role="row">
          {COLUMNS.map((c) => (
            <button
              key={c.key}
              className={`sort-head ${sort.key === c.key ? "active" : ""}`}
              data-hb={`sort:${c.key}`}
              aria-sort={sort.key === c.key ? (sort.dir === 1 ? "ascending" : "descending") : "none"}
              onClick={() => toggleSort(c.key)}
            >
              {c.label}
              <i>{sort.key === c.key ? (sort.dir === 1 ? "▲" : "▼") : "↕"}</i>
            </button>
          ))}
          <span />
        </div>
        {rooms === null && <p className="muted room-empty">Loading tables…</p>}
        {rooms !== null && visible.length === 0 && (
          <p className="muted room-empty">No open spots right now. Create a table to start one.</p>
        )}
        {visible.map((room, i) => {
          const here = session.roomId === room.id;
          const full = openSpots(room) === 0;
          return (
            <div className="room-row" key={room.id} data-hb={`room:${room.id}`} data-hb-activate=".join" data-hb-initial={i === 0 ? "" : undefined}>
              <span className="room-name">
                {room.name}
                {room.highRoller && <em className="badge-high">HIGH ROLLER</em>}
              </span>
              <span className="cell-blinds">
                {fmt(room.minBet)}–{fmt(room.maxBet)}
              </span>
              <span className={`stage stage-${room.stage === "settled" ? "hand-over" : room.stage}`}>
                {BJ_STAGE_LABEL[room.stage]}
              </span>
              <span className="seat-pips" title="Spots 1–7: gold = player, grey = bot">
                {Array.from({ length: BJ_SPOTS }, (_, i) => (
                  <i key={i} className={room.spots[i] ?? ""} />
                ))}
                <small>{openSpots(room)} open</small>
              </span>
              <span className="chips">
                {room.humans} {room.humans === 1 ? "player" : "players"} · {room.bots} {room.bots === 1 ? "bot" : "bots"}
              </span>
              <span className="cell-join">
                <button className="join" disabled={full && !here} onClick={() => join(room)}>
                  {here ? "Return" : full ? "Full" : "Join"}
                </button>
              </span>
            </div>
          );
        })}
      </div>

      {creating && <CreateDialog session={session} onClose={() => setCreating(false)} />}
    </section>
  );
}

function CreateDialog({ session, onClose }: { session: Session; onClose: () => void }) {
  const [name, setName] = useState(`${session.name}'s Table`);
  const [minBet, setMinBet] = useState<number>(BJ_ALLOWED_MIN_BETS[1]);
  const [error, setError] = useState<string | null>(null);
  const affordable = session.bankroll >= minBet;

  function submit(event: FormEvent) {
    event.preventDefault();
    socket.emit("blackjack:create", { name, minBet }, (result) => {
      if (!result.ok) setError(result.error);
    });
  }

  return (
    <Modal title="Create a table" onClose={onClose}>
      <form onSubmit={submit}>
        <label>
          Table name
          <input value={name} maxLength={24} onChange={(e) => setName(e.target.value)} />
        </label>
        <label data-hb="create:limits" data-hb-adjust="select" data-hb-initial>
          Limits
          <select value={minBet} onChange={(e) => setMinBet(Number(e.target.value))}>
            {BJ_ALLOWED_MIN_BETS.map((min) => (
              <option key={min} value={min}>
                {fmt(min)}–{fmt(min * BJ_MAX_BET_MULT)}
              </option>
            ))}
          </select>
        </label>
        {!affordable && <p className="form-error">You need at least {fmt(minBet)} in Dining Dollars for these limits.</p>}
        {error && <p className="form-error">{error}</p>}
        <button className="primary" data-hb="create:submit" disabled={!affordable || !name.trim()}>
          Create and sit down
        </button>
      </form>
    </Modal>
  );
}
