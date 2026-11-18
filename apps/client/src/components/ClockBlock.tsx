import { useEffect, useState } from "react";
import { TIME_BANK_MAX_MS, TIME_BANK_REFILL_MS } from "@owl-in/shared";

/** Re-render a few times a second so countdowns tick. */
export function useNow(active: boolean) {
  const [now, setNow] = useState(() => performance.now());
  useEffect(() => {
    if (!active) return;
    const id = window.setInterval(() => setNow(performance.now()), 200);
    return () => window.clearInterval(id);
  }, [active]);
  return now;
}

export type Clock =
  | { kind: "rebuy"; seconds: number }
  | { kind: "turn"; seconds: number }
  | { kind: "grace"; seconds: number; bank: number }
  | { kind: "draining"; seconds: number }
  | { kind: "bank"; seconds: number };

/**
 * Your clock, big. Always the same height (label / number / note) so the sidebar never jumps.
 * Between your turns it shows your banked time plus a greyed "+Ns next turn" refill preview.
 * `timeoutNote` says what happens at 0 (poker: check/fold, blackjack: stand).
 */
export function ClockBlock({ clock, timeoutNote = "Auto check / fold at 0" }: { clock: Clock; timeoutNote?: string }) {
  const label = {
    rebuy: "Meal plan empty",
    turn: "Your turn",
    grace: "Ready up",
    draining: "Not ready · bank draining",
    bank: "Time bank",
  }[clock.kind];
  const urgent = clock.kind === "rebuy" || clock.kind === "draining" || (clock.kind === "turn" && clock.seconds <= 5);
  const live = clock.kind !== "bank";
  // Each turn adds TIME_BANK_REFILL_MS, capped at TIME_BANK_MAX_MS.
  const refill =
    clock.kind === "bank"
      ? Math.max(0, Math.min(TIME_BANK_REFILL_MS, TIME_BANK_MAX_MS - clock.seconds * 1000)) / 1000
      : null;
  const note = {
    rebuy: "Reload or cash out",
    turn: timeoutNote,
    grace: `Then your bank (${clock.kind === "grace" ? clock.bank : 0}s) drains`,
    draining: "Ready up to stop the drain",
    bank: timeoutNote,
  }[clock.kind];
  return (
    <div className={`clock-block ${urgent ? "urgent" : live ? "live" : ""}`}>
      <small>{label}</small>
      <div className="clock-row">
        <strong>{clock.seconds}s</strong>
        {refill !== null && <span className="clock-refill">{refill > 0 ? `+${refill}s next turn` : "Max banked"}</span>}
      </div>
      <em>{note}</em>
    </div>
  );
}
