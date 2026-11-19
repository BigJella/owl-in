import { useEffect, useLayoutEffect, useRef, useState, type FormEvent } from "react";
import type { Session } from "@owl-in/shared";
import { socket } from "../networking/socket";

/**
 * Change your name from the navbar. A small popover in the same style as the "leave your table first" hint,
 * centred under your name. The name is checked with the server as you type: taken or invalid turns the box red
 * and says why. Enter saves, Escape (or ×, or a click elsewhere) cancels.
 */
export function NameEditor(props: { current: string; center: number; onDone: (session: Session) => void; onClose: () => void }) {
  const { current, center, onDone, onClose } = props;
  const [value, setValue] = useState(current);
  const [problem, setProblem] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const [busy, setBusy] = useState(false);
  const ref = useRef<HTMLFormElement>(null);
  const trimmed = value.trim();
  const unchanged = trimmed === current;

  // Centre under the name, kept on screen.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const half = el.offsetWidth / 2;
    el.style.left = `${Math.max(14 + half, Math.min(center, window.innerWidth - 14 - half))}px`;
  }, [center]);

  // Live check, a moment after typing stops.
  useEffect(() => {
    if (unchanged || trimmed === "") {
      setProblem(trimmed === "" ? "Enter a name." : null);
      setChecking(false);
      return;
    }
    setChecking(true);
    const id = window.setTimeout(() => {
      socket.emit("name:check", trimmed, (result) => {
        setChecking(false);
        setProblem(result.ok ? result.reason : result.error);
      });
    }, 250);
    return () => window.clearTimeout(id);
  }, [trimmed, unchanged]);

  // Escape or a click outside closes it.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    const onDown = (e: MouseEvent) => ref.current && !ref.current.contains(e.target as Node) && onClose();
    window.addEventListener("keydown", onKey);
    window.addEventListener("mousedown", onDown);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("mousedown", onDown);
    };
  }, [onClose]);

  function submit(event: FormEvent) {
    event.preventDefault();
    if (unchanged) return onClose();
    if (problem || checking || busy) return;
    setBusy(true);
    socket.emit("rename", trimmed, (result) => {
      setBusy(false);
      if (result.ok) onDone(result.session);
      else setProblem(result.error);
    });
  }

  return (
    <form className="nav-hint name-editor" ref={ref} style={{ left: center }} onSubmit={submit} aria-label="Change your name">
      <div className="name-editor-row">
        <input
          autoFocus
          aria-label="New name"
          aria-invalid={problem !== null}
          className={problem ? "invalid" : ""}
          maxLength={16}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onFocus={(e) => e.target.select()}
        />
        <button type="submit" className="name-save" disabled={busy || checking || problem !== null}>
          {unchanged ? "Close" : "Save"}
        </button>
        <button type="button" className="name-cancel" onClick={onClose} aria-label="Cancel">
          ×
        </button>
      </div>
      {problem && (
        <p className="name-editor-msg" role="alert">
          {problem}
        </p>
      )}
    </form>
  );
}
