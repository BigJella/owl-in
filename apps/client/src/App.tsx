import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { CURRENCY_NAME, formatDD, type LobbyState, type Session } from "@owl-in/shared";
import { bannedInfo, resetToken, saveCareerPublic, saveName, savedCareerPublic, savedName, socket } from "./networking/socket";
import { pokerStore } from "./networking/pokerStore";
import { blackjackStore } from "./networking/blackjackStore";
import { NamePage } from "./pages/NamePage";
import { HomePage } from "./pages/HomePage";
import { PokerLobbyPage } from "./pages/PokerLobbyPage";
import { PokerTablePage } from "./pages/PokerTablePage";
import { BlackjackLobbyPage } from "./pages/BlackjackLobbyPage";
import { BlackjackTablePage } from "./pages/BlackjackTablePage";
import { CareerPage } from "./pages/CareerPage";
import { NameEditor } from "./components/NameEditor";
import { HootBoxControl } from "./components/HootBoxControl";
import { useHootBoxNavigation } from "./hardware/useHootBoxNavigation";
import { LeaderboardPage } from "./pages/LeaderboardPage";

type Screen = "home" | "poker" | "blackjack" | "career" | "leaderboard";

export default function App() {
  const [session, setSession] = useState<Session | null>(null);
  const [lobby, setLobby] = useState<LobbyState>({ playersOnline: 0, pokerPlayers: 0, blackjackPlayers: 0 });
  const [screen, setScreen] = useState<Screen>("home");
  /** Whose career is open (null = yours). */
  const [careerId, setCareerId] = useState<string | null>(null);
  const [nameError, setNameError] = useState<string | null>(null);
  /** The server accepted the saved name but needs a privacy choice: the name is shown locked. */
  const [nameLocked, setNameLocked] = useState(false);
  /** Set once identify succeeds; session pushes before that (e.g. from a table you're still seated at) are ignored. */
  const identified = useRef(false);
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
  /** An admin banned this browser (reason may be null). */
  const [banned, setBanned] = useState<{ reason: string | null } | null>(bannedInfo);
  /** The last admin message (kick, timeout, table closed): replaces the usual "you've left" notice once. */
  const adminMessage = useRef<string | null>(null);

  /** The server checks the token, the name (valid, not another browser's) and the privacy choice every time. */
  function identify(name: string, careerPublic: boolean | null) {
    setBusy(true);
    socket.emit("identify", { name, careerPublic }, (result) => {
      setBusy(false);
      if (!result.ok) {
        identified.current = false;
        setSession(null);
        if (result.code === "token") return resetToken(); // reconnects, which runs this check again
        if (result.code === "banned") return setBanned({ reason: null });
        setNameLocked(result.code === "careerPublic");
        setNameError(result.code === "careerPublic" ? null : result.error);
        return;
      }
      saveName(name);
      saveCareerPublic(result.session.careerPublic);
      identified.current = true;
      setNameLocked(false);
      setNameError(null);
      setSession(result.session);
    });
  }

  useEffect(() => {
    // Decide "stay to watch the result" in the same update that removes the seat, so the table
    // (and its running animation) never unmounts in between.
    const handleSession = (next: Session) => {
      if (!identified.current) return;
      if (next.name !== sessionRef.current?.name) saveName(next.name); // an admin renamed us: log in as the new name
      const prevRoom = sessionRef.current?.roomId ?? null;
      if (prevRoom && !next.roomId && pokerStore.latest()?.message.view.leaveMode === "queued") setShowingResult(true);
      setSession(next);
    };
    socket.on("session", handleSession);
    socket.on("lobby-updated", setLobby);
    const handleBanned = (info: { reason: string | null }) => {
      identified.current = false;
      setSession(null);
      setBanned(info);
    };
    if (bannedInfo) handleBanned(bannedInfo); // arrived before this effect ran
    const handleError = (message: string) => {
      if (/admin|timed out/i.test(message)) adminMessage.current = message;
    };
    socket.on("banned", handleBanned);
    socket.on("error-message", handleError);
    // Verify with the server on every (re)connect: the token reclaims any seat; a taken name or a missing privacy
    // choice brings up the name page in the right mode.
    const onConnect = () => {
      const name = savedName();
      if (name) identify(name, savedCareerPublic());
      socket.emit("get-lobby");
    };
    socket.on("connect", onConnect);
    if (socket.connected) onConnect();
    return () => {
      socket.off("session", handleSession);
      socket.off("lobby-updated", setLobby);
      socket.off("banned", handleBanned);
      socket.off("error-message", handleError);
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
      setNotice(adminMessage.current ?? leftBlackjackNotice);
      adminMessage.current = null;
    } else if (lastRoomId) {
      if (pokerStore.latest()?.message.view.leaveMode === "queued") {
        setShowingResult(true); // stay to watch the last hand; they'll click back to the lobby
      } else {
        pokerStore.reset();
        setNotice(adminMessage.current ?? leftNotice);
        adminMessage.current = null;
      }
    }
    setLastRoomId(roomId);
    setLastGame(game);
  }, [session?.roomId, session?.game]);

  /** Shown under the nav when you click it while seated: you have to leave the table first. */
  /** Horizontal centre of the clicked link's text (the hint is centred under it), or null when hidden. */
  const [navHint, setNavHint] = useState<number | null>(null);
  const navHintRef = useRef<HTMLDivElement>(null);
  // Centre under the link, but nudge it back on screen if it would hang off an edge (phones, the logo).
  useLayoutEffect(() => {
    const el = navHintRef.current;
    if (navHint === null || !el) return;
    const half = el.offsetWidth / 2;
    el.style.left = `${Math.max(14 + half, Math.min(navHint, window.innerWidth - 14 - half))}px`;
  }, [navHint]);
  useEffect(() => {
    if (navHint === null) return;
    const id = window.setTimeout(() => setNavHint(null), 4000);
    return () => window.clearTimeout(id);
  }, [navHint]);
  /** Centre of your name in the nav while the rename box is open, or null. */
  const [renaming, setRenaming] = useState<number | null>(null);
  // Leaving the table clears the hint straight away; sitting down closes the rename box.
  useEffect(() => {
    if (!session?.roomId) setNavHint(null);
    else setRenaming(null);
  }, [session?.roomId]);

  /** Click on your name: rename (away from tables), or the "leave your table first" hint. */
  function openRename(anchor: HTMLElement) {
    if (!session) return;
    const rect = anchor.getBoundingClientRect();
    const center = rect.left + rect.width / 2;
    if (session.roomId) return setNavHint(center);
    setNavHint(null);
    setRenaming(center);
  }

  /** Nav clicks: go there, or (while seated) explain why not. */
  function navigate(go: () => void, anchor: HTMLElement) {
    if (!session) return;
    if (!session.roomId) return go();
    const rect = anchor.getBoundingClientRect();
    setNavHint(rect.left + rect.width / 2);
  }

  /** null = your own career (your own id counts as yours too). */
  function openCareer(playerId: string | null) {
    setCareerId(playerId === session?.playerId ? null : playerId);
    setScreen("career");
  }

  function leaveTable() {
    socket.emit("poker:leave");
    setScreen("poker");
  }

  // HootBox site navigation: everywhere except the tables (they have their own mappings).
  const atTable = Boolean(session?.roomId) || showingResult;
  const hootBoxScreen = !session ? "name" : screen === "career" ? `career:${careerId ?? "me"}` : screen;
  const { homeHolding } = useHootBoxNavigation({
    active: !banned && !atTable,
    screenKey: hootBoxScreen,
    onHome: session && screen !== "home" ? () => setScreen("home") : undefined,
  });

  let page;
  if (banned) {
    page = (
      <section className="lobby name-screen">
        <div className="name-card">
          <p className="eyebrow">KSU CARD CLUB</p>
          <h1>You've been banned.</h1>
          <p className="muted">{banned.reason ? `Reason: ${banned.reason}` : "An admin removed you from OWL IN."}</p>
        </div>
      </section>
    );
  } else if (!session) {
    page = (
      <NamePage
        key={nameLocked ? "privacy-only" : "name"}
        initialName={savedName() ?? ""}
        initialPublic={savedCareerPublic()}
        nameLocked={nameLocked}
        error={nameError}
        busy={busy}
        onSubmit={identify}
      />
    );
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
  } else if (screen === "career") {
    page = (
      <CareerPage
        key={careerId ?? "me"}
        playerId={careerId}
        onBack={() => setScreen(careerId ? "leaderboard" : "home")}
        onPrivacyChanged={saveCareerPublic}
      />
    );
  } else if (screen === "leaderboard") {
    page = <LeaderboardPage onOpen={openCareer} onBack={() => setScreen("home")} />;
  } else {
    page = (
      <HomePage
        name={session.name}
        lobby={lobby}
        onPoker={() => setScreen("poker")}
        onBlackjack={() => setScreen("blackjack")}
        onCareer={() => openCareer(null)}
        onLeaderboard={() => setScreen("leaderboard")}
      />
    );
  }

  return (
    <main>
      <nav className="nav">
        <button className="brand" onClick={(e) => navigate(() => setScreen("home"), e.currentTarget)}>
          <span className="owl-mark">O</span>
          <span>OWL IN</span>
        </button>
        <div className={`nav-links ${session?.roomId ? "locked" : ""}`}>
          {(
            [
              ["Games", () => setScreen("home")],
              ["Poker", () => setScreen("poker")],
              ["Blackjack", () => setScreen("blackjack")],
              ["Career", () => openCareer(null)],
              ["Leaderboard", () => setScreen("leaderboard")],
            ] as const
          ).map(([label, go]) => (
            <button
              key={label}
              className={label === "Games" ? "has-hold" : undefined}
              data-hb={session ? `nav:${label.toLowerCase()}` : undefined}
              aria-disabled={Boolean(session?.roomId)}
              onClick={(e) => navigate(go, e.currentTarget)}
            >
              {label}
              {label === "Games" && homeHolding && <span className="hold-fill" />}
            </button>
          ))}
        </div>
        {renaming !== null && session && (
          <NameEditor
            current={session.name}
            center={renaming}
            onClose={() => setRenaming(null)}
            onDone={(next) => {
              saveName(next.name);
              setSession(next);
              setRenaming(null);
            }}
          />
        )}
        {navHint !== null && (
          <div className="nav-hint" role="alert" ref={navHintRef} style={{ left: navHint }}>
            <span>You must leave your current table first.</span>
            <button onClick={() => setNavHint(null)} aria-label="Dismiss">
              ×
            </button>
          </div>
        )}
        <HootBoxControl />
        {session && (
          <div className="chip-balance">
            <button
              className={`name-button ${session.roomId ? "locked" : ""}`}
              title={session.roomId ? "Leave your table to change your name" : "Change your name"}
              aria-disabled={Boolean(session.roomId)}
              onClick={(e) => openRename(e.currentTarget)}
            >
              <span className="name-text">{session.name}</span>
              <small>{CURRENCY_NAME}</small>
            </button>
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
