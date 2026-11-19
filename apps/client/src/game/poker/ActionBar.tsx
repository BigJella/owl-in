import { useEffect, useState } from "react";
import { formatDD as fmt, type PokerAction, type PokerTableView } from "@owl-in/shared";
import { socket } from "../../networking/socket";
import { DIAL_PRIORITY, useDial, useDialConnected, useHoldState } from "../../hardware/useDial";

/**
 * Fold / check / call / raise controls, shown only when it's your turn.
 * Every control is the same height; on phones the main actions come first.
 */
export function ActionBar({ view }: { view: PokerTableView }) {
  const legal = view.myLegalActions;
  const me = view.mySeat === null ? null : view.seats[view.mySeat];
  const [raiseTo, setRaiseToState] = useState(legal?.minRaiseTo ?? 0);
  /** What's typed in the amount box; only clamped on blur/Enter so typing isn't fought. */
  const [typed, setTyped] = useState(String(legal?.minRaiseTo ?? ""));
  const setRaiseTo = (n: number) => {
    setRaiseToState(n);
    setTyped(String(n));
  };

  // Reset the slider whenever a new decision comes up.
  useEffect(() => {
    if (legal) setRaiseTo(legal.minRaiseTo);
  }, [legal?.minRaiseTo, legal?.maxRaiseTo, view.handId, view.phase]);

  // Owl Dial: turn = raise amount, press = raise, A = check/call, B = reset the amount, hold B = fold.
  const dialOn = useDialConnected();
  const hold = useHoldState();
  useDial(
    (event) => {
      hold.track(event);
      if (!legal || !me) return false;
      const clampDial = (n: number) => Math.min(legal.maxRaiseTo, Math.max(legal.minRaiseTo, Math.round(n)));
      switch (event.kind) {
        case "turn":
          if (legal.canRaise) setRaiseTo(clampDial(raiseTo + event.steps * view.bigBlind));
          return true;
        case "press":
          if (legal.canRaise) socket.emit("poker:act", { type: "raise", to: raiseTo });
          return true;
        case "a":
          socket.emit("poker:act", { type: legal.canCheck ? "check" : "call" });
          return true;
        case "b":
          setRaiseTo(legal.minRaiseTo);
          return true;
        case "holdStart":
          // Never fold a free check: the hold does nothing then (and doesn't fall through to leaving).
          if (!legal.canCheck) hold.start();
          return true;
        case "holdB":
          if (!legal.canCheck) socket.emit("poker:act", { type: "fold" });
          return true;
        default:
          return false;
      }
    },
    DIAL_PRIORITY.panel,
    Boolean(legal && me),
  );

  if (!legal || !me) return null;

  const pot = view.pots.reduce((s, p) => s + p.amount, 0) + view.seats.reduce((s, seat) => s + (seat?.bet ?? 0), 0);
  const clamp = (n: number) => Math.min(legal.maxRaiseTo, Math.max(legal.minRaiseTo, Math.round(n)));
  const callIsAllIn = legal.callAmount > 0 && legal.callAmount >= me.stack;
  const raiseIsAllIn = raiseTo >= legal.maxRaiseTo;
  const typedValue = Number(typed.replace(/[^\d]/g, ""));
  const typedOutOfRange = typed !== "" && (typedValue < legal.minRaiseTo || typedValue > legal.maxRaiseTo);
  const commitTyped = () => {
    const amount = clamp(typed === "" ? legal.minRaiseTo : typedValue);
    setRaiseTo(amount);
    return amount;
  };
  const act = (action: PokerAction) => socket.emit("poker:act", action);
  const raise = (amount: number) => act({ type: "raise", to: amount });
  const verb = view.currentBet === 0 ? "Bet" : "Raise to";

  return (
    <div className="action-bar">
      <div className="action-main">
        {!legal.canCheck && (
          <button className="action fold has-hold" onClick={() => act({ type: "fold" })}>
            Fold
            {hold.holding && <span className="hold-fill danger" />}
          </button>
        )}
        {legal.canCheck ? (
          <button className="action check" onClick={() => act({ type: "check" })}>
            Check
          </button>
        ) : (
          <button className="action call" onClick={() => act({ type: "call" })}>
            {callIsAllIn ? "All-in" : "Call"} {fmt(legal.callAmount)}
          </button>
        )}
      </div>

      {legal.canRaise && (
        <div className="raise-control">
          <div className="raise-presets">
            <button onClick={() => setRaiseTo(clamp(legal.minRaiseTo))}>Min</button>
            <button onClick={() => setRaiseTo(clamp(view.currentBet + legal.callAmount + pot / 2))}>½ Pot</button>
            <button onClick={() => setRaiseTo(clamp(view.currentBet + legal.callAmount + pot))}>Pot</button>
            <button onClick={() => setRaiseTo(legal.maxRaiseTo)}>All-in</button>
          </div>
          <div className="raise-slider">
            <input
              type="range"
              aria-label={`${verb} amount slider`}
              min={legal.minRaiseTo}
              max={legal.maxRaiseTo}
              step={view.smallBlind || 1}
              value={raiseTo}
              onChange={(e) => setRaiseTo(clamp(Number(e.target.value)))}
            />
          </div>
          <label
            className={`amount-input ${typedOutOfRange ? "invalid" : ""}`}
            title={`${fmt(legal.minRaiseTo)} – ${fmt(legal.maxRaiseTo)}`}
          >
            <span>$</span>
            <input
              type="text"
              inputMode="numeric"
              aria-label={`${verb} amount`}
              value={typed}
              onChange={(e) => {
                const next = e.target.value.replace(/[^\d]/g, "");
                setTyped(next);
                const n = Number(next);
                if (next !== "" && n >= legal.minRaiseTo && n <= legal.maxRaiseTo) setRaiseToState(n);
              }}
              onBlur={commitTyped}
              onKeyDown={(e) => {
                if (e.key === "Enter") raise(commitTyped());
                if (e.key === "Escape") setRaiseTo(raiseTo);
              }}
              onFocus={(e) => e.target.select()}
            />
          </label>
          <button
            className={`action raise ${dialOn ? "dial-focus" : ""}`}
            onClick={() => raise(typed === "" || typedOutOfRange ? commitTyped() : raiseTo)}
          >
            {raiseIsAllIn ? "All-in" : verb} {fmt(raiseTo)}
          </button>
        </div>
      )}
    </div>
  );
}
