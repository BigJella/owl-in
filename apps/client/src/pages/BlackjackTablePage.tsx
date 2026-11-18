import { useEffect, useState } from "react";
import {
  BJ_ACTION_LABEL,
  BJ_MAX_SPOTS_PER_PLAYER,
  BJ_SPOTS,
  BJ_STAGE_LABEL,
  BJ_TIME_BANK_MAX_MS,
  BJ_TURN_REFILL_MS,
  formatDD,
  type BlackjackAction,
  type BlackjackTableView,
} from "@owl-in/shared";
import { ClockBlock, useNow, type Clock } from "../components/ClockBlock";
import { BlackjackScene } from "../game/blackjack/BlackjackScene";
import { useBlackjackState, type ReceivedBlackjack } from "../networking/blackjackStore";
import { socket } from "../networking/socket";

const fmt = formatDD;
const seconds = (ms: number) => Math.max(0, Math.ceil(ms / 1000));

/** Roughly where we are in the shoe. Deliberately vague: estimating decks left is the player's job. */
function shoeStage(view: BlackjackTableView): string {
  const level = view.shoe.level;
  if (level >= 0.8) return "Fresh";
  if (level >= 0.55) return "Early";
  if (level >= 0.4) return "Middle";
  return "Late";
}

/** The shared strip across the top: table-wide information only (identical for everyone). */
function TableStrip({ received, now }: { received: ReceivedBlackjack; now: number }) {
  const { view } = received.message;
  const elapsed = now - received.receivedAt;
  const acting = view.toAct ? view.spots[view.toAct.spot] : null;
  const dealer =
    view.dealer.total === null ? "—" : `${view.dealer.total}${view.dealer.cards.includes(null) ? " showing" : ""}`;
  let status: React.ReactNode = "—";
  if (view.stage === "betting" && view.phaseRemainingMs !== null) {
    status = (
      <>
        Bets close<b className="strip-clock">{seconds(view.phaseRemainingMs - elapsed)}s</b>
      </>
    );
  } else if (view.stage === "betting" && view.waitingFor.length > 0) {
    status = `Waiting for ${view.waitingFor.join(", ")}`;
  } else if (view.stage === "insurance" && view.phaseRemainingMs !== null) {
    status = (
      <>
        Insurance<b className="strip-clock">{seconds(view.phaseRemainingMs - elapsed)}s</b>
      </>
    );
  } else if (acting && view.toAct) {
    const clock = acting.kind === "bot" ? "thinking" : view.turnRemainingMs !== null ? `${seconds(view.turnRemainingMs - elapsed)}s` : null;
    status = (
      <>
        {acting.name} · spot {view.toAct.spot + 1}
        {clock && <b className={`strip-clock ${clock === "thinking" ? "muted" : ""}`}>{clock}</b>}
      </>
    );
  } else if (view.stage === "playing") {
    status = "Dealing";
  } else if (view.nextRoundInMs !== null) {
    status = `Next round in ${seconds(view.nextRoundInMs - elapsed)}s`;
  } else if (view.stage === "settled") {
    status = "Paying out";
  }

  return (
    <header className="table-strip bj-strip" aria-label="Table information">
      <div className="strip-cell strip-title" title={view.name}>
        {view.name}
      </div>
      <div className="strip-cell">
        <small>Limits</small>
        <span>
          {fmt(view.minBet)}–{fmt(view.maxBet)}
        </span>
      </div>
      <div className="strip-cell">
        <small>Round</small>
        <span>{view.roundId > 0 ? `#${view.roundId}` : "—"}</span>
      </div>
      <div className="strip-cell">
        <small>Stage</small>
        <span>{BJ_STAGE_LABEL[view.stage]}</span>
      </div>
      <div className="strip-cell">
        <small>Shoe</small>
        <span title={`${view.shoe.decks}-deck shoe`}>{shoeStage(view)}</span>
      </div>
      <div className="strip-cell">
        <small>Dealer</small>
        <span>{dealer}</span>
      </div>
      <div className="strip-cell strip-acting">
        <small>{view.toAct ? "To act" : "Status"}</small>
        <span>{status}</span>
      </div>
    </header>
  );
}

function myClock(received: ReceivedBlackjack, now: number): Clock | null {
  const { view } = received.message;
  const elapsed = now - received.receivedAt;
  const myTurn = view.toAct !== null && view.mySpots.includes(view.toAct.spot) && view.turnRemainingMs !== null;
  if (myTurn) return { kind: "turn", seconds: seconds(view.turnRemainingMs! - elapsed) };
  // Played last round and still betting: the window, then your time bank keeps bets open.
  if (view.myBettingClock === "window" && view.phaseRemainingMs !== null) {
    const windowLeft = view.phaseRemainingMs - elapsed;
    if (windowLeft > 0) return { kind: "grace", seconds: seconds(windowLeft), bank: Math.floor(view.myTimeBankMs / 1000) };
    return { kind: "draining", seconds: seconds(view.myTimeBankMs + windowLeft) };
  }
  if (view.myBettingClock === "bank") return { kind: "draining", seconds: seconds(view.myTimeBankMs - elapsed) };
  return { kind: "bank", seconds: Math.floor(view.myTimeBankMs / 1000) };
}

export function BlackjackTablePage({ onLeave, playerName }: { onLeave: () => void; playerName: string }) {
  const received = useBlackjackState();
  const view = received?.message.view ?? null;
  const now = useNow(view !== null);
  const [error, setError] = useState<string | null>(null);
  const [confirmLeave, setConfirmLeave] = useState(false);
  const [selected, setSelected] = useState<number | null>(null);

  const showError = (message: string) => {
    setError(message);
    window.setTimeout(() => setError(null), 3000);
  };
  useEffect(() => {
    socket.on("error-message", showError);
    return () => {
      socket.off("error-message", showError);
    };
  }, []);

  // Keep a sensible spot selected for betting: one of yours, else the first spot you could take.
  useEffect(() => {
    if (!view) return;
    const free = (i: number) => {
      const s = view.spots[i];
      return !s || s.kind === "bot" || view.mySpots.includes(i);
    };
    if (selected !== null && free(selected)) return;
    const first = view.mySpots[0] ?? [3, 4, 5, 6, 0, 1, 2].find((i) => !view.spots[i]) ?? [0, 1, 2].find(free) ?? null;
    setSelected(first);
  }, [view, selected]);

  const clock = received ? myClock(received, now) : null;
  const inPlay = view
    ? view.mySpots.reduce((sum, spot) => {
        const s = view.spots[spot];
        if (!s || view.stage === "settled") return sum;
        return sum + (s.hands.length > 0 ? s.hands.reduce((m, h) => m + h.bet, 0) : s.bet) + (s.insurance ?? 0);
      }, 0)
    : 0;
  const myTurn = view?.myLegal != null;
  const actingSpot = view?.toAct ? view.spots[view.toAct.spot] : null;
  const myHands = view ? view.mySpots.some((spot) => (view.spots[spot]?.hands.length ?? 0) > 0) : false;

  function leave() {
    if (view?.leaveMode === "now") onLeave();
    else setConfirmLeave(true);
  }

  return (
    <section className="poker-screen">
      {received && <TableStrip received={received} now={now} />}

      <div className="table-main">
        <BlackjackScene selectedSpot={view?.stage === "betting" ? selected : null} onSpotClick={setSelected} />

        <aside className="player-panel" aria-label="Your spots">
          <div className="panel-info">
            <div className="panel-head">
              <small>You</small>
              <div className="panel-name-row">
                <strong>{playerName}</strong>
                <div className="panel-tags">
                  {view?.leaveMode === "queued" && <span className="tag danger">Last round</span>}
                  {view && view.mySpots.length > 0 && (
                    <span className="tag">
                      {view.mySpots.length === 1 ? "Spot" : "Spots"} {view.mySpots.map((s) => s + 1).join(", ")}
                    </span>
                  )}
                </div>
              </div>
            </div>

            <div className="panel-stats">
              <div>
                <small>Bankroll</small>
                <strong className="gold">{fmt(view?.myBankroll ?? 0)}</strong>
              </div>
              <div>
                <small>In play</small>
                <strong>{fmt(inPlay)}</strong>
              </div>
            </div>

            {clock && (
              <ClockBlock
                clock={clock}
                timeoutNote="Auto stand at 0"
                graceLabel="Place bets"
                drainLabel="Betting on your time bank"
                drainNote="Press Deal to stop the drain"
                refillMs={BJ_TURN_REFILL_MS}
                maxMs={BJ_TIME_BANK_MAX_MS}
              />
            )}
          </div>

          <div className="panel-controls">
            {view && view.stage === "betting" && <BetPanel view={view} selected={selected} onSelect={setSelected} onError={showError} />}
            {view?.myInsurance && (
              <InsurancePanel
                cost={view.myInsurance.cost}
                hands={view.myInsurance.spots.length}
                blackjack={view.myInsurance.spots.some((s) => view.spots[s]?.hands[0]?.status === "blackjack")}
              />
            )}
            {view && myTurn && <PlayPanel view={view} />}
            {view && !myTurn && myHands && view.stage === "playing" && (
              <p className="muted waiting-note">
                {actingSpot ? `Waiting for ${actingSpot.name}…` : "Dealer's turn…"}
              </p>
            )}
            <button className="secondary cashout" onClick={leave} disabled={view?.leaveMode === "queued"}>
              {view?.leaveMode === "queued"
                ? "Leaving after this round"
                : view?.leaveMode === "after-hand"
                  ? "Leave after this round"
                  : "Leave table"}
            </button>
          </div>
        </aside>
      </div>

      {confirmLeave && view && view.leaveMode === "after-hand" && (
        <div className="modal-backdrop" onClick={() => setConfirmLeave(false)}>
          <div className="modal leave-dialog" onClick={(e) => e.stopPropagation()}>
            <div className="modal-head">
              <h2>Leave after this round?</h2>
            </div>
            <p className="muted">
              Your hands this round play out (any you don't finish will stand), then you leave the table.{" "}
              <b>This can't be undone.</b>
            </p>
            <div className="dialog-actions">
              <button type="button" className="secondary" onClick={() => setConfirmLeave(false)} autoFocus>
                Stay
              </button>
              <button
                type="button"
                className="primary danger"
                onClick={() => {
                  setConfirmLeave(false);
                  onLeave();
                }}
              >
                Leave after this round
              </button>
            </div>
          </div>
        </div>
      )}
      {error && <div className="toast">{error}</div>}
    </section>
  );
}

/** Pick a spot (1-7), an amount, and bet. Deal when you're done. */
function BetPanel(props: {
  view: BlackjackTableView;
  selected: number | null;
  onSelect: (spot: number) => void;
  onError: (message: string) => void;
}) {
  const { view, selected, onSelect, onError } = props;
  const max = Math.min(view.maxBet, view.myBankroll);
  const spot = selected === null ? null : view.spots[selected];
  const mine = selected !== null && view.mySpots.includes(selected);
  const currentBet = mine && spot ? spot.bet : 0;
  const lastForSpot = view.myLastBets.find((b) => b.spot === selected)?.amount;
  const [amount, setAmountState] = useState(Math.max(view.minBet, Math.min(max, lastForSpot ?? view.minBet)));
  const [typed, setTyped] = useState(String(amount));
  const setAmount = (n: number) => {
    setAmountState(n);
    setTyped(String(n));
  };
  const clamp = (n: number) => Math.max(view.minBet, Math.min(Math.max(view.minBet, max + currentBet), Math.round(n)));
  const affordable = view.myBankroll + currentBet >= view.minBet;
  const atCap = !mine && view.mySpots.length >= BJ_MAX_SPOTS_PER_PLAYER;
  const takenByHuman = spot !== null && spot !== undefined && spot.kind === "human" && !mine;
  const hasBets = view.mySpots.some((s) => (view.spots[s]?.bet ?? 0) > 0);
  const typedValue = Number(typed.replace(/[^\d]/g, ""));
  const typedInvalid = typed !== "" && (typedValue < view.minBet || typedValue > view.maxBet);

  function placeBet(value = amount) {
    if (selected === null) return;
    socket.emit("blackjack:bet", { spot: selected, amount: value }, (result) => {
      if (!result.ok) onError(result.error);
    });
  }

  return (
    <div className="bet-panel">
      <div className="spot-picker" role="group" aria-label="Spot">
        {Array.from({ length: BJ_SPOTS }, (_, i) => {
          const s = view.spots[i];
          const isMine = view.mySpots.includes(i);
          const blocked = s?.kind === "human" && !isMine;
          return (
            <button
              key={i}
              className={`spot-btn ${selected === i ? "selected" : ""} ${isMine ? "mine" : ""} ${s?.kind === "bot" ? "bot" : ""}`}
              disabled={blocked}
              onClick={() => onSelect(i)}
              title={blocked ? `${s!.name}'s spot` : s?.kind === "bot" ? `${s.name} (bot) gives up this spot if you bet` : `Spot ${i + 1}`}
            >
              {i + 1}
              <small>{isMine ? (s && s.bet > 0 ? "Bet" : "Yours") : s?.kind === "bot" ? "Bot" : blocked ? "Taken" : "Open"}</small>
            </button>
          );
        })}
      </div>

      <div className="raise-control">
        <div className="raise-presets">
          <button onClick={() => setAmount(clamp(view.minBet))}>Min</button>
          <button onClick={() => setAmount(clamp(view.minBet * 5))}>5×</button>
          <button onClick={() => setAmount(clamp(view.minBet * 10))}>10×</button>
          <button onClick={() => setAmount(clamp(view.maxBet))}>Max</button>
        </div>
        <div className="raise-slider">
          <input
            type="range"
            aria-label="Bet amount slider"
            min={view.minBet}
            max={Math.max(view.minBet, Math.min(view.maxBet, max + currentBet))}
            step={view.minBet}
            value={amount}
            onChange={(e) => setAmount(clamp(Number(e.target.value)))}
          />
        </div>
        <label className={`amount-input ${typedInvalid ? "invalid" : ""}`} title={`${fmt(view.minBet)} – ${fmt(view.maxBet)}`}>
          <span>$</span>
          <input
            type="text"
            inputMode="numeric"
            aria-label="Bet amount"
            value={typed}
            onChange={(e) => {
              const next = e.target.value.replace(/[^\d]/g, "");
              setTyped(next);
              const n = Number(next);
              if (next !== "" && n >= view.minBet && n <= view.maxBet) setAmountState(n);
            }}
            onBlur={() => setAmount(clamp(typed === "" ? view.minBet : typedValue))}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                const value = clamp(typed === "" ? view.minBet : typedValue);
                setAmount(value);
                placeBet(value);
              }
            }}
            onFocus={(e) => e.target.select()}
          />
        </label>
        <button
          className="action raise amount-btn"
          disabled={selected === null || !affordable || atCap || takenByHuman}
          onClick={() => placeBet()}
        >
          {currentBet > 0 ? "Change" : "Bet"} {fmt(amount)}
        </button>
      </div>

      <div className="bet-actions three">
        <button
          className="action"
          disabled={!mine || currentBet === 0}
          onClick={() => selected !== null && socket.emit("blackjack:clear-bet", selected)}
        >
          Clear
        </button>
        <button
          className="action"
          disabled={view.myLastBets.length === 0}
          onClick={() =>
            socket.emit("blackjack:rebet", (result) => {
              if (!result.ok) onError(result.error);
            })
          }
        >
          Rebet
        </button>
        {view.amReady ? (
          <span className="bj-ready tag gold">✓ Ready</span>
        ) : (
          <button className="action raise" disabled={!hasBets} onClick={() => socket.emit("blackjack:ready")}>
            Deal
          </button>
        )}
      </div>
    </div>
  );
}

function InsurancePanel({ cost, hands, blackjack }: { cost: number; hands: number; blackjack: boolean }) {
  return (
    <div className="ready-panel">
      <div>
        <strong>Dealer shows an ace.</strong>{" "}
        <span className="muted">
          Insure {hands === 1 ? "your hand" : `your ${hands} hands`} for {fmt(cost)}? Pays 2 to 1.
          {blackjack && " Insuring a blackjack locks in even money instead of 3:2."}
        </span>
      </div>
      <div className="bet-actions">
        <button className="action" onClick={() => socket.emit("blackjack:insurance", false)}>
          No
        </button>
        <button className="action raise amount-btn" onClick={() => socket.emit("blackjack:insurance", true)}>
          Insure {fmt(cost)}
        </button>
      </div>
    </div>
  );
}

const PLAY_ORDER: BlackjackAction[] = ["hit", "stand", "double", "split", "surrender"];

/** Hit / Stand / Double / Split / Surrender: always all five, in fixed slots, disabled when not allowed. */
function PlayPanel({ view }: { view: BlackjackTableView }) {
  const legal = view.myLegal!;
  const ref = view.toAct!;
  const spot = view.spots[ref.spot]!;
  const hand = spot.hands[ref.hand]!;
  const act = (action: BlackjackAction) => socket.emit("blackjack:act", action);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement) return;
      const key = { h: "hit", s: "stand", d: "double", p: "split", r: "surrender" }[e.key.toLowerCase()] as BlackjackAction | undefined;
      if (key && legal[key]) act(key);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [legal]);

  return (
    <div className="bj-play">
      <p className="bj-hand-note">
        Spot {ref.spot + 1}
        {spot.hands.length > 1 && ` · hand ${ref.hand + 1} of ${spot.hands.length}`}
        <b>{hand.soft && hand.total < 21 ? `Soft ${hand.total}` : hand.total}</b>
      </p>
      <div className="bj-actions">
        {PLAY_ORDER.map((action) => (
          <button
            key={action}
            className={`action bj-${action} ${action === "hit" ? "raise" : ""}`}
            disabled={!legal[action]}
            onClick={() => act(action)}
          >
            {BJ_ACTION_LABEL[action]}
            {(action === "double" || action === "split") && legal[action] ? ` ${fmt(hand.bet)}` : ""}
          </button>
        ))}
      </div>
    </div>
  );
}
