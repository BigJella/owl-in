import { hootBox } from "../hardware/hootbox";
import { useHootBoxStatus } from "../hardware/useHootBox";

/** Nav control for the HootBox (Web Serial). Hidden where the browser has no Web Serial. Fixed width: no shifting. */
export function HootBoxControl() {
  const status = useHootBoxStatus();
  if (status === "unsupported") return null;
  return (
    <div className="nav-hootbox">
      {status === "connected" ? (
        <span className="nav-hootbox-on">
          <i /> HootBox connected
          <button onClick={() => void hootBox.disconnect()} aria-label="Disconnect the HootBox" title="Disconnect">
            ×
          </button>
        </span>
      ) : (
        <button className="secondary" disabled={status === "connecting"} onClick={() => void hootBox.connect()}>
          {status === "connecting" ? "Connecting…" : "Connect HootBox"}
        </button>
      )}
    </div>
  );
}
