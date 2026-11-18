import { useEffect, useState, type FormEvent } from "react";
import { formatDD, STAGE_LABEL, type PokerTableView } from "@owl-in/shared";
import { socket } from "../networking/socket";
import { usePokerState, type ReceivedMessage } from "../networking/pokerStore";
import { PokerScene } from "../game/poker/PokerScene";
import { ActionBar } from "../game/poker/ActionBar";

const fmt = formatDD;

/** Re-render a few times a second so countdowns tick. */
function useNow(active: boolean) {
  const [now, setNow] = useState(() => performance.now());
  useEffect(() => {
    if (!active) return;
    const id = window.setInterval(() => setNow(performance.now()), 200);
    return () => window.clearInterval(id);
  }, [active]);
  return now;
}

type Clock =
  | { kind: "rebuy"; seconds: number }
  | { kind: "turn"; seconds: number }
  | { kind: "grace"; seconds: number; bank: number }
  | { kind: "draining"; seconds: number }
  | { kind: "bank"; seconds: number };

/** Your own clock: your turn, the ready-up grace/drain between hands, or just your banked time. */
function myClock(received: ReceivedMessage, now: number): Clock | null {
  const { view } = received.message;
  const me = view.mySeat === null ? null : view.seats[view.mySeat];
  if (!me) return null;
  const elapsed = now - received.receivedAt;
  if (view.rebuy) return { kind: "rebuy", seconds: Math.max(0, Math.ceil((view.rebuy.remainingMs - elapsed) / 1000)) };
  if (view.toAct === view.mySeat && view.turnRemainingMs !== null) {
    return { kind: "turn", seconds: Math.max(0, Math.ceil((view.turnRemainingMs - elapsed) / 1000)) };
  }
  if (me.ready === false && view.readyGraceRemainingMs !== null) {
    const graceLeft = view.readyGraceRemainingMs - elapsed;
    if (graceLeft > 0) return { kind: "grace", seconds: Math.ceil(graceLeft / 1000), bank: Math.floor(me.timeBankMs / 1000) };
    // Server's timeBankMs already includes any drain up to send time.
    const drainedSinceSend = Math.max(0, elapsed - Math.max(0, view.readyGraceRemainingMs));
    return { kind: "draining", seconds: Math.max(0, Math.ceil((me.timeBankMs - drainedSinceSend) / 1000)) };
  }
  return { kind: "bank", seconds: Math.floor(me.timeBankMs / 1000) };
}

/** Shared "between hands" status for the strip (same for everyone). */
function idleStatus(view: PokerTableView, elapsed: number): string {
  const notReady = view.seats.filter((s) => s?.ready === false).length;
  if (view.nextHandInMs !== null) {
    const seconds = Math.max(0, Math.ceil((view.nextHandInMs - elapsed) / 1000));
    return seconds > 1 ? `Next hand in ${seconds}s` : "Dealing";
  }
  if (notReady > 0) return `Waiting for ${notReady} to ready`;
  return "—";
}

/**
 * The shared strip across the top. Built ONLY from table-wide fields, so every player at the
 * table sees exactly the same thing (nothing about "me": no stack, hole cards, actions or clock).
 */
function TableStrip({ received, now }: { received: ReceivedMessage; now: number }) {
  const { view } = received.message;
  const elapsed = now - received.receivedAt;
  const nameOf = (seat: number | null | undefined) => (seat == null ? "—" : (view.seats[seat]?.name ?? "—"));
  const collected = view.pots.reduce((s, p) => s + p.amount, 0);
  const pot = collected + view.seats.reduce((s, seat) => s + (seat?.bet ?? 0), 0);
  const sb = view.seats.find((s) => s?.blind === "SB")?.seat;
  const bb = view.seats.find((s) => s?.blind === "BB")?.seat;
  const acting = view.toAct === null ? null : (view.seats[view.toAct] ?? null);
  const actingClock =
    acting === null
      ? null
      : acting.kind === "bot"
        ? "thinking"
        : view.turnRemainingMs !== null
          ? `${Math.max(0, Math.ceil((view.turnRemainingMs - elapsed) / 1000))}s`
          : null;

  return (
    <header className="table-strip" aria-label="Table information">
      <div className="strip-cell strip-title">{view.name}</div>
      <div className="strip-cell">
        <small>Blinds</small>
        <span>{fmt(view.smallBlind)}/{fmt(view.bigBlind)}</span>
      </div>
      <div className="strip-cell">
        <small>Hand</small>
        <span>{view.handId > 0 ? `#${view.handId}` : "—"}</span>
      </div>
      <div className="strip-cell">
        <small>Stage</small>
        <span>{STAGE_LABEL[view.stage]}</span>
      </div>
      <div className="strip-cell">
        <small>Pot</small>
        <span className="gold">
          {fmt(pot)}
          {view.pots.length > 1 && (
            <em className="strip-sub">
              {" "}
              ({view.pots.map((p, i) => `${i === 0 ? "main" : `side ${i}`} ${fmt(p.amount)}`).join(", ")})
            </em>
          )}
        </span>
      </div>
      <div className="strip-cell">
        <small>Dealer</small>
        <span>{view.handId > 0 ? nameOf(view.button) : "—"}</span>
      </div>
      <div className="strip-cell">
        <small>SB / BB</small>
        <span>
          {nameOf(sb)} / {nameOf(bb)}
        </span>
      </div>
      <div className="strip-cell strip-acting">
        <small>{view.phase === "idle" ? "Status" : "To act"}</small>
        <span>
          {view.phase === "idle" ? (
            idleStatus(view, elapsed)
          ) : (
            <>
              {acting?.name ?? "—"}
              {actingClock && <b className={`strip-clock ${actingClock === "thinking" ? "muted" : ""}`}>{actingClock}</b>}
            </>
          )}
        </span>
      </div>
    </header>
  );
}

/**
 * `cashedOut`: you've already been removed after a queued cash-out. The table stays on screen so the
 * final hand's result can play out; the only control is going back to the lobby.
 */
export function PokerTablePage({ onLeave, cashedOut = false }: { onLeave: () => void; cashedOut?: boolean }) {
  const received = usePokerState();
  const view = received?.message.view ?? null;
  const [error, setError] = useState<string | null>(null);
  const [confirmLeave, setConfirmLeave] = useState(false);
  const now = useNow(view !== null);

  useEffect(() => {
    const showError = (message: string) => {
      setError(message);
      window.setTimeout(() => setError(null), 3000);
    };
    socket.on("error-message", showError);
    return () => {
      socket.off("error-message", showError);
    };
  }, []);

  const me = view && view.mySeat !== null ? view.seats[view.mySeat] : null;
  const clock = received && !cashedOut ? myClock(received, now) : null;
  const acting = view?.toAct ?? null;
  const actingName = acting === null ? "—" : (view?.seats[acting]?.name ?? "—");

  return (
    <section className="poker-screen">
      {received && <TableStrip received={received} now={now} />}

      <div className="table-main">
        <PokerScene />

        <aside className="player-panel" aria-label="Your seat">
          <div className="panel-head">
            <small>You</small>
            <strong>{me?.name ?? "Waiting for a seat"}</strong>
            <div className="panel-tags">
              {view?.leaveMode === "queued" && !cashedOut && <span className="tag danger">Last hand</span>}
              {view?.amWaiting && <span className="tag">Seated next hand</span>}
              {me?.status === "waiting" && <span className="tag">Dealt in next hand</span>}
              {me?.status === "folded" && view?.phase !== "idle" && <span className="tag">Folded</span>}
              {me?.status === "allIn" && <span className="tag gold">All-in</span>}
            </div>
          </div>

          {me && (
            <div className="panel-stats">
              <div>
                <small>Stack</small>
                <strong className="gold">{fmt(me.stack)}</strong>
              </div>
              <div>
                <small>In pot</small>
                <strong>{fmt(me.contributed)}</strong>
              </div>
            </div>
          )}

          {clock && <ClockBlock clock={clock} />}

          <div className="panel-actions">
            {cashedOut && (
              <div className="ready-panel">
                <div>
                  <strong>You cashed out{me ? ` with ${fmt(me.stack)}` : ""}.</strong>
                  <span className="muted"> You can rejoin this table in 30 minutes.</span>
                </div>
                <button className="primary" onClick={onLeave}>
                  Back to lobby
                </button>
              </div>
            )}
            {view && !cashedOut && <ActionBar view={view} />}
            {view && !cashedOut && view.readyGraceRemainingMs !== null && <ReadyPanel view={view} clock={clock} />}
            {view && !cashedOut && me && view.myLegalActions === null && view.phase !== "idle" && acting !== null && (
              <p className="muted waiting-note">Waiting for {actingName}…</p>
            )}
          </div>

          <button
            className="secondary cashout"
            onClick={() => (cashedOut ? onLeave() : setConfirmLeave(true))}
            disabled={!cashedOut && view?.leaveMode === "queued"}
          >
            {cashedOut
              ? "Back to lobby"
              : view?.leaveMode === "queued"
                ? "Cashing out after this hand"
                : view?.leaveMode === "after-hand"
                  ? "Cash out after this hand"
                  : "Cash out"}
          </button>
        </aside>
      </div>

      {confirmLeave && view && view.leaveMode !== "queued" && (
        <LeaveDialog
          view={view}
          onCancel={() => setConfirmLeave(false)}
          onConfirm={() => {
            setConfirmLeave(false);
            onLeave();
          }}
        />
      )}
      {!cashedOut && view?.rebuy && clock?.kind === "rebuy" && (
        <RebuyDialog rebuy={view.rebuy} seconds={clock.seconds} bigBlind={view.bigBlind} onLeave={onLeave} />
      )}
      {error && <div className="toast">{error}</div>}
    </section>
  );
}

/** Your clock, big: turn countdown, ready-up grace/drain, rebuy decision, or banked time. */
function ClockBlock({ clock }: { clock: Clock }) {
  const label = {
    rebuy: "Meal plan empty",
    turn: "Your turn",
    grace: "Ready up",
    draining: "Not ready · bank draining",
    bank: "Time bank",
  }[clock.kind];
  const urgent = clock.kind === "rebuy" || clock.kind === "draining" || (clock.kind === "turn" && clock.seconds <= 5);
  const live = clock.kind !== "bank";
  return (
    <div className={`clock-block ${urgent ? "urgent" : live ? "live" : ""}`}>
      <small>{label}</small>
      <strong>{clock.seconds}s</strong>
      {clock.kind === "grace" && <em>then your bank ({clock.bank}s) drains</em>}
    </div>
  );
}

/** Between hands at tables with humans: everyone reviews the result, then readies up. */
function ReadyPanel({ view, clock }: { view: PokerTableView; clock: Clock | null }) {
  const humans = view.seats.filter((s) => s !== null && s.ready !== null);
  const notReady = humans.filter((s) => s!.ready === false).map((s) => s!.name);
  const me = view.mySeat === null ? null : view.seats[view.mySeat];
  const needMe = me?.ready === false;

  return (
    <div className="ready-panel">
      <div>
        <strong>Hand over.</strong>{" "}
        <span className="muted">
          {humans.length - notReady.length}/{humans.length} ready
          {notReady.length > 0 && ` · waiting for ${notReady.join(", ")}`}
        </span>
        {needMe && clock?.kind === "draining" && <div className="form-error">Your time bank is draining. Ready up!</div>}
      </div>
      {view.rebuy ? (
        <span className="tag danger">Meal plan empty</span>
      ) : needMe ? (
        <button className="primary" onClick={() => socket.emit("poker:ready")}>
          Ready for next hand
        </button>
      ) : (
        me && <span className="tag gold">✓ Ready</span>
      )}
    </div>
  );
}

/** Busted between hands: buy back in (which readies you) or cash out. 30 seconds, no time bank involved. */
function RebuyDialog(props: {
  rebuy: NonNullable<PokerTableView["rebuy"]>;
  seconds: number;
  bigBlind: number;
  onLeave: () => void;
}) {
  const { rebuy, seconds, bigBlind, onLeave } = props;
  const affordable = rebuy.max >= rebuy.min;
  const [amount, setAmount] = useState(Math.min(rebuy.max, Math.max(rebuy.min, bigBlind * 60)));
  const [error, setError] = useState<string | null>(null);

  function submit(event: FormEvent) {
    event.preventDefault();
    socket.emit("poker:rebuy", amount, (result) => {
      if (!result.ok) setError(result.error);
    });
  }

  return (
    <div className="modal-backdrop">
      <form className="modal" onSubmit={submit}>
        <div className="modal-head">
          <h2>Your meal plan is empty</h2>
          <span className={`tag ${seconds <= 10 ? "danger" : "gold"}`}>{seconds}s</span>
        </div>
        <p className="muted">Reload to play the next hand, or cash out.</p>
        {affordable ? (
          <label>
            Buy-in <strong className="gold">{fmt(amount)}</strong>
            <input
              type="range"
              min={rebuy.min}
              max={rebuy.max}
              step={bigBlind}
              value={amount}
              onChange={(e) => setAmount(Number(e.target.value))}
            />
            <span className="range-ends">
              <small>{fmt(rebuy.min)}</small>
              <small>{fmt(rebuy.max)}</small>
            </span>
          </label>
        ) : (
          <p className="form-error">You need at least {fmt(rebuy.min)} to reload here.</p>
        )}
        {error && <p className="form-error">{error}</p>}
        <p className="dialog-note">Leaving locks you out of this table for 30 minutes.</p>
        <div className="dialog-actions">
          <button type="button" className="secondary" onClick={onLeave}>
            Cash out
          </button>
          <button className="primary" disabled={!affordable}>
            Reload {fmt(amount)}
          </button>
        </div>
      </form>
    </div>
  );
}

/** Confirm cashing out. Mid-hand it's queued (and irreversible): you finish the hand, then you're removed. */
function LeaveDialog({ view, onCancel, onConfirm }: { view: PokerTableView; onCancel: () => void; onConfirm: () => void }) {
  const me = view.mySeat === null ? null : view.seats[view.mySeat];
  const queued = view.leaveMode === "after-hand";
  const takeHome = me ? me.stack + me.bet : 0;

  return (
    <div className="modal-backdrop" onClick={onCancel}>
      <div className="modal leave-dialog" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h2>{queued ? "Cash out after this hand?" : "Cash out?"}</h2>
        </div>
        <div className="lockout">
          <strong>30 min</strong>
          <span>
            You won't be able to rejoin <b>{view.name}</b> for 30 minutes.
          </span>
        </div>
        {queued ? (
          <p className="muted">
            You'll play out this hand, then leave with whatever you have when it ends. Everyone at the table will see
            it's your last hand. <b>This can't be undone.</b>
          </p>
        ) : (
          <p className="muted">
            You'll leave with <b className="gold">{fmt(takeHome)}</b>.
          </p>
        )}
        <div className="dialog-actions">
          <button type="button" className="secondary" onClick={onCancel} autoFocus>
            Stay
          </button>
          <button type="button" className="primary danger" onClick={onConfirm}>
            {queued ? "Cash out after this hand" : "Cash out"}
          </button>
        </div>
      </div>
    </div>
  );
}
