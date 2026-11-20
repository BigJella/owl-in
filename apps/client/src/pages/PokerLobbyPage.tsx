import { useEffect, useState, type FormEvent } from "react";
import {
  formatDD,
  ALLOWED_BIG_BLINDS,
  MAX_BUY_IN_BB,
  MIN_BUY_IN_BB,
  STAGE_LABEL,
  type PokerRoomSummary,
  type Session,
  type TableStage,
} from "@owl-in/shared";
import { socket } from "../networking/socket";
import { HOOTBOX_PRIORITY, useHootBox } from "../hardware/useHootBox";

const fmt = formatDD;

interface PokerLobbyPageProps {
  session: Session;
  onBack: () => void;
}

type Dialog = { kind: "join"; room: PokerRoomSummary } | { kind: "create" } | null;

type SortKey = "name" | "blinds" | "stage" | "seats" | "chips";
const STAGE_ORDER: TableStage[] = ["preflop", "flop", "turn", "river", "showdown", "hand-over", "waiting"];
const COLUMNS: { key: SortKey; label: string }[] = [
  { key: "name", label: "Table" },
  { key: "blinds", label: "Blinds" },
  { key: "stage", label: "Stage" },
  { key: "seats", label: "Seats" },
  { key: "chips", label: "On table" },
];

/** A table you could sit at right now (bots count as open: you'd replace one). */
const isOpen = (room: PokerRoomSummary) => room.humans - room.cashingOut + room.waiting < room.maxSeats;

function compareRooms(key: SortKey, a: PokerRoomSummary, b: PokerRoomSummary): number {
  switch (key) {
    case "name":
      return a.name.localeCompare(b.name);
    case "blinds":
      return a.bigBlind - b.bigBlind;
    case "stage":
      return STAGE_ORDER.indexOf(a.stage) - STAGE_ORDER.indexOf(b.stage);
    case "seats":
      return a.humans - b.humans || a.humans + a.bots - (b.humans + b.bots);
    case "chips":
      return a.chipsOnTable - b.chipsOnTable;
  }
}

export function PokerLobbyPage({ session, onBack }: PokerLobbyPageProps) {
  const [rooms, setRooms] = useState<PokerRoomSummary[] | null>(null);
  const [dialog, setDialog] = useState<Dialog>(null);
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 }>({ key: "blinds", dir: 1 });
  const [openOnly, setOpenOnly] = useState(false);

  useEffect(() => {
    socket.on("poker:rooms", setRooms);
    socket.emit("poker:subscribe-rooms");
    const resubscribe = () => socket.emit("poker:subscribe-rooms");
    socket.on("connect", resubscribe);
    return () => {
      socket.off("poker:rooms", setRooms);
      socket.off("connect", resubscribe);
      socket.emit("poker:unsubscribe-rooms");
    };
  }, []);

  const toggleSort = (key: SortKey) =>
    setSort((current) => (current.key === key ? { key, dir: current.dir === 1 ? -1 : 1 } : { key, dir: 1 }));

  const visible = (rooms ?? [])
    .filter((room) => !openOnly || isOpen(room) || room.id === session.roomId)
    .sort((a, b) => sort.dir * compareRooms(sort.key, a, b) || a.name.localeCompare(b.name));

  return (
    <section className="lobby">
      <button className="back" data-hb-back onClick={onBack}>← Games</button>
      <div className="hero room-hero">
        <div>
          <p className="eyebrow">TEXAS HOLD'EM</p>
          <h1>Pick a table.</h1>
          <p>Bots keep every table at four players. Sit down and you'll replace one at the next hand.</p>
        </div>
        <button className="primary" data-hb="lobby:create" onClick={() => setDialog({ kind: "create" })}>+ Create Table</button>
      </div>

      <div className="room-toolbar">
        <label className="checkbox" data-hb="lobby:open-only">
          <input type="checkbox" checked={openOnly} onChange={(e) => setOpenOnly(e.target.checked)} />
          Open seats only
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
          <p className="muted room-empty">No open seats right now. Create a table to start one.</p>
        )}
        {visible.map((room, i) => {
          const seated = room.humans + room.bots;
          const full = !isOpen(room);
          const here = session.roomId === room.id;
          return (
            <div className="room-row" key={room.id} data-hb={`room:${room.id}`} data-hb-activate=".join" data-hb-initial={i === 0 ? "" : undefined}>
              <span className="room-name">
                {room.name}
                {room.highRoller && <em className="badge-high">HIGH ROLLER</em>}
              </span>
              <span className="cell-blinds">{fmt(room.smallBlind)}/{fmt(room.bigBlind)}</span>
              <span className={`stage stage-${room.stage}`}>{STAGE_LABEL[room.stage]}</span>
              <span className="seat-pips" title={`${room.humans} players, ${room.bots} bots, ${room.waiting} waiting`}>
                {Array.from({ length: room.maxSeats }, (_, i) => (
                  <i key={i} className={i < room.humans ? "human" : i < seated ? "bot" : ""} />
                ))}
                <small>
                  {room.humans} {room.humans === 1 ? "player" : "players"} · {room.bots} {room.bots === 1 ? "bot" : "bots"}
                  {room.waiting ? ` · ${room.waiting} waiting` : ""}
                  {room.cashingOut ? ` · ${room.cashingOut} leaving` : ""}
                </small>
              </span>
              <span className="chips">{fmt(room.chipsOnTable)}</span>
              <span className="cell-join">
                <button className="join" disabled={full && !here} onClick={() => setDialog({ kind: "join", room })}>
                  {here ? "Return" : full ? "Full" : "Join"}
                </button>
              </span>
            </div>
          );
        })}
      </div>

      {dialog?.kind === "join" && <BuyInDialog session={session} room={dialog.room} onClose={() => setDialog(null)} />}
      {dialog?.kind === "create" && <CreateDialog session={session} onClose={() => setDialog(null)} />}
    </section>
  );
}

function buyInRange(bigBlind: number, bankroll: number) {
  const min = bigBlind * MIN_BUY_IN_BB;
  const max = Math.min(bigBlind * MAX_BUY_IN_BB, bankroll);
  return { min, max, affordable: max >= min };
}

function BuyInDialog({ session, room, onClose }: { session: Session; room: PokerRoomSummary; onClose: () => void }) {
  const { min, max, affordable } = buyInRange(room.bigBlind, session.bankroll);
  const [buyIn, setBuyIn] = useState(Math.min(max, room.bigBlind * 60));
  const [error, setError] = useState<string | null>(null);

  function sitDown() {
    socket.emit("poker:join", { roomId: room.id, buyIn }, (result) => {
      if (!result.ok) setError(result.error);
    });
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    sitDown();
  }

  // HootBox: turn = buy-in (±1 big blind), A or press = sit down, B = cancel. Modal.
  useHootBox((event) => {
    if (event.kind === "turn" && affordable) {
      setBuyIn((n) => Math.min(max, Math.max(min, n + event.steps * room.bigBlind)));
    }
    if ((event.kind === "a" || event.kind === "press") && affordable) sitDown();
    if (event.kind === "b") onClose();
    return event.kind !== "holdEnd";
  }, HOOTBOX_PRIORITY.dialog);

  return (
    <Modal title={`Join ${room.name}`} onClose={onClose}>
      <form onSubmit={submit}>
        <p className="muted">Blinds {fmt(room.smallBlind)}/{fmt(room.bigBlind)}. You'll be dealt in at the next hand.</p>
        {affordable ? (
          <BuyInSlider min={min} max={max} value={buyIn} step={room.bigBlind} onChange={setBuyIn} />
        ) : (
          <p className="form-error">You need at least {fmt(min)} in Dining Dollars for this table.</p>
        )}
        {error && <p className="form-error">{error}</p>}
        <button className="primary amount-btn" disabled={!affordable}>Sit down with {fmt(buyIn)}</button>
      </form>
    </Modal>
  );
}

function CreateDialog({ session, onClose }: { session: Session; onClose: () => void }) {
  const [name, setName] = useState(`${session.name}'s Table`);
  const [bigBlind, setBigBlind] = useState<number>(ALLOWED_BIG_BLINDS[1]);
  const { min, max, affordable } = buyInRange(bigBlind, session.bankroll);
  const [buyIn, setBuyIn] = useState(Math.min(max, bigBlind * 60));
  const [error, setError] = useState<string | null>(null);

  useEffect(() => setBuyIn(Math.max(min, Math.min(max, bigBlind * 60))), [bigBlind, min, max]);

  function submit(event: FormEvent) {
    event.preventDefault();
    socket.emit("poker:create", { name, bigBlind, buyIn }, (result) => {
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
        <label data-hb="create:blinds" data-hb-adjust="select" data-hb-initial>
          Blinds
          <select value={bigBlind} onChange={(e) => setBigBlind(Number(e.target.value))}>
            {ALLOWED_BIG_BLINDS.map((bb) => (
              <option key={bb} value={bb}>
                {fmt(bb / 2)}/{fmt(bb)}
              </option>
            ))}
          </select>
        </label>
        {affordable ? (
          <BuyInSlider min={min} max={max} value={buyIn} step={bigBlind} onChange={setBuyIn} />
        ) : (
          <p className="form-error">You need at least {fmt(min)} in Dining Dollars for these blinds.</p>
        )}
        {error && <p className="form-error">{error}</p>}
        <button className="primary" data-hb="create:submit" disabled={!affordable || !name.trim()}>Create and sit down</button>
      </form>
    </Modal>
  );
}

function BuyInSlider(props: { min: number; max: number; value: number; step: number; onChange: (n: number) => void }) {
  return (
    <label data-hb="buy-in" data-hb-adjust="range">
      Buy-in <strong className="gold">{fmt(props.value)}</strong>
      <input
        type="range"
        min={props.min}
        max={props.max}
        step={props.step}
        value={props.value}
        onChange={(e) => props.onChange(Number(e.target.value))}
      />
      <span className="range-ends">
        <small>{fmt(props.min)}</small>
        <small>{fmt(props.max)}</small>
      </span>
    </label>
  );
}

export function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h2>{title}</h2>
          <button className="close" data-hb-back onClick={onClose} aria-label="Close">×</button>
        </div>
        {children}
      </div>
    </div>
  );
}
