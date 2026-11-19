import { dial } from "../hardware/dial";
import { useDialStatus } from "../hardware/useDial";

/** Nav control for the Owl Dial (Web Serial). Hidden where the browser has no Web Serial. Fixed width: no shifting. */
export function DialControl() {
  const status = useDialStatus();
  if (status === "unsupported") return null;
  return (
    <div className="nav-dial">
      {status === "connected" ? (
        <span className="nav-dial-on">
          <i /> Dial connected
          <button onClick={() => void dial.disconnect()} aria-label="Disconnect the dial" title="Disconnect">
            ×
          </button>
        </span>
      ) : (
        <button className="secondary" disabled={status === "connecting"} onClick={() => void dial.connect()}>
          {status === "connecting" ? "Connecting…" : "Connect dial"}
        </button>
      )}
    </div>
  );
}
