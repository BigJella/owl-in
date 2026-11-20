import { useEffect, useState } from "react";
import { formatDD, type LeaderboardRow } from "@owl-in/shared";
import { socket } from "../networking/socket";

/** Everyone ranked by Dining Dollars (bankroll plus chips at a table). Public careers can be opened. */
export function LeaderboardPage({ onOpen, onBack }: { onOpen: (playerId: string) => void; onBack: () => void }) {
  const [rows, setRows] = useState<LeaderboardRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const load = () =>
      socket.emit("leaderboard:get", (result) => {
        if (result.ok) setRows(result.rows);
        else setError(result.error);
      });
    load();
    const id = window.setInterval(load, 10_000);
    socket.on("connect", load);
    return () => {
      window.clearInterval(id);
      socket.off("connect", load);
    };
  }, []);

  return (
    <section className="lobby">
      <button className="back" data-hb-back onClick={onBack}>← Games</button>
      <div className="hero room-hero">
        <div>
          <p className="eyebrow">LEADERBOARD</p>
          <h1>Who's up.</h1>
          <p>Ranked by Dining Dollars, chips at a table included. Open a public career to see how they got there.</p>
        </div>
      </div>
      {error && <p className="form-error lobby-error">{error}</p>}

      <div className="room-list">
        <div className="leader-row room-head" role="row">
          <span>Rank</span>
          <span>Player</span>
          <span className="num">Dining Dollars</span>
          <span />
        </div>
        {rows === null && <p className="muted room-empty">Loading…</p>}
        {rows?.length === 0 && <p className="muted room-empty">Nobody has played yet.</p>}
        {rows?.map((row) => (
          <div
            className={`leader-row ${row.isMe ? "me" : ""}`}
            key={row.playerId}
            data-hb={`leader:${row.playerId}`}
            data-hb-activate=".join"
            data-hb-initial={row.isMe ? "" : undefined}
          >
            <span className="leader-rank">{row.rank}</span>
            <span className="leader-name">
              <i className={`dot ${row.online ? "on" : ""}`} title={row.online ? "Online" : "Offline"} />
              {row.name}
              {row.isMe && <em className="tag gold">You</em>}
            </span>
            <span className="num leader-money">{formatDD(row.bankroll)}</span>
            <span className="cell-join">
              {row.isPublic || row.isMe ? (
                <button className="join" onClick={() => onOpen(row.playerId)}>
                  Career
                </button>
              ) : (
                <span className="tag">Private</span>
              )}
            </span>
          </div>
        ))}
      </div>
    </section>
  );
}
