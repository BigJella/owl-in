import { useEffect, useRef, useState } from "react";
import { CURRENCY_NAME, formatDD, type LobbyState, type Session } from "@owl-in/shared";
import { saveName, savedName, socket } from "./networking/socket";
import { pokerStore } from "./networking/pokerStore";
import { blackjackStore } from "./networking/blackjackStore";
import { NamePage } from "./pages/NamePage";
import { HomePage } from "./pages/HomePage";
import { PokerLobbyPage } from "./pages/PokerLobbyPage";
import { PokerTablePage } from "./pages/PokerTablePage";
import { BlackjackLobbyPage } from "./pages/BlackjackLobbyPage";
import { BlackjackTablePage } from "./pages/BlackjackTablePage";

type Screen = "home" | "poker" | "blackjack";

export default function App() {
  const [session, setSession] = useState<Session | null>(null);
  const [lobby, setLobby] = useState<LobbyState>({ playersOnline: 0, pokerPlayers: 0, blackjackPlayers: 0 });
  const [screen, setScreen] = useState<Screen>("home");
  const [nameError, setNameError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /** Shown in the lobby after you leave (or are removed from) a table. */
  const [notice, setNotice] = useState<string | null>(null);
  const [lastRoomId, setLastRoomId] = useState<string | null>(null);
  const [lastGame, setLastGame] = useState<Session["game"]>(null);
  /** After a queued cash-out, keep showing the table so the final hand's result can play out. */
  const [showingResult, setShowingResult] = useState(false);
  const leftNotice = "You've left the table. You can rejoin it in 30 minutes.";
  const leftBlackjackNotice = "You've left the table.";
  const sessionRef = useRef<Session | null>(null);
  sessionRef.current = session;

  function identify(name: string) {
    setBusy(true);
    socket.emit("identify", name, (result) => {
      setBusy(false);
      if (!result.ok) return setNameError(result.error);
      saveName(name);
      setNameError(null);
      setSession(result.session);
    });
  }

  useEffect(() => {
    // Decide "stay to watch the result" in the same update that removes the seat, so the table
    // (and its running animation) never unmounts in between.
    const handleSession = (next: Session) => {
      const prevRoom = sessionRef.current?.roomId ?? null;
      if (prevRoom && !next.roomId && pokerStore.latest()?.message.view.leaveMode === "queued") setShowingResult(true);
      setSession(next);
    };
    socket.on("session", handleSession);
    socket.on("lobby-updated", setLobby);
    // Re-identify on every (re)connect with the saved name; the token reclaims any seat.
    const onConnect = () => {
      const name = savedName();
      if (name) identify(name);
      socket.emit("get-lobby");
    };
    socket.on("connect", onConnect);
    if (socket.connected) onConnect();
    return () => {
      socket.off("session", handleSession);
      socket.off("lobby-updated", setLobby);
      socket.off("connect", onConnect);
    };
  }, []);

  // Leaving (or being removed / busting) clears roomId: drop back to the room list.
  useEffect(() => {
    const roomId = session?.roomId ?? null;
    const game = session?.game ?? null;
    if (roomId) {
      setScreen(game === "blackjack" ? "blackjack" : "poker");
      setNotice(null);
      setShowingResult(false);
    } else if (lastRoomId && lastGame === "blackjack") {
      blackjackStore.reset();
      setScreen("blackjack");
      setNotice(leftBlackjackNotice);
    } else if (lastRoomId) {
      if (pokerStore.latest()?.message.view.leaveMode === "queued") {
        setShowingResult(true); // stay to watch the last hand; they'll click back to the lobby
      } else {
        pokerStore.reset();
        setNotice(leftNotice);
      }
    }
    setLastRoomId(roomId);
    setLastGame(game);
  }, [session?.roomId, session?.game]);

  function leaveTable() {
    socket.emit("poker:leave");
    setScreen("poker");
  }

  let page;
  if (!session) {
    page = <NamePage initialName={savedName() ?? ""} error={nameError} busy={busy} onSubmit={identify} />;
  } else if (session.roomId && session.game === "blackjack") {
    page = <BlackjackTablePage onLeave={() => socket.emit("blackjack:leave")} playerName={session.name} />;
  } else if (session.roomId) {
    page = <PokerTablePage onLeave={leaveTable} playerName={session.name} />;
  } else if (showingResult) {
    page = (
      <PokerTablePage
        cashedOut
        playerName={session.name}
        onLeave={() => {
          setShowingResult(false);
          pokerStore.reset();
          setScreen("poker");
        }}
      />
    );
  } else if (screen === "poker") {
    page = <PokerLobbyPage session={session} onBack={() => setScreen("home")} />;
  } else if (screen === "blackjack") {
    page = <BlackjackLobbyPage session={session} onBack={() => setScreen("home")} />;
  } else {
    page = (
      <HomePage
        name={session.name}
        lobby={lobby}
        onPoker={() => setScreen("poker")}
        onBlackjack={() => setScreen("blackjack")}
      />
    );
  }

  return (
    <main>
      <nav className="nav">
        <button className="brand" onClick={() => session && !session.roomId && setScreen("home")}>
          <span className="owl-mark">O</span>
          <span>OWL IN</span>
        </button>
        <div className="nav-links">
          <button onClick={() => session && !session.roomId && setScreen("home")}>Games</button>
          <button onClick={() => session && !session.roomId && setScreen("poker")}>Poker</button>
          <button onClick={() => session && !session.roomId && setScreen("blackjack")}>Blackjack</button>
        </div>
        {session && (
          <div className="chip-balance">
            <span>
              {session.name}
              <small>{CURRENCY_NAME}</small>
            </span>
            <strong>{formatDD(session.bankroll)}</strong>
          </div>
        )}
      </nav>
      {notice && !session?.roomId && (
        <div className="notice" role="status">
          {notice}
          <button onClick={() => setNotice(null)} aria-label="Dismiss">×</button>
        </div>
      )}
      {page}
    </main>
  );
}
