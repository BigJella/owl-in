import type { LobbyState } from "@owl-in/shared";

interface HomePageProps {
  name: string;
  lobby: LobbyState;
  onPoker: () => void;
  onBlackjack: () => void;
  onCareer: () => void;
  onLeaderboard: () => void;
}

export function HomePage({ name, lobby, onPoker, onBlackjack, onCareer, onLeaderboard }: HomePageProps) {
  return (
    <section className="lobby">
      <div className="hero">
        <p className="eyebrow">KSU CARD CLUB</p>
        <h1>Choose your game, {name}.</h1>
        <p>Play for Dining Dollars. Outplay the bots.</p>
        <div className="online"><i /> {lobby.playersOnline} players online</div>
        <div className="hero-links">
          <button className="secondary" onClick={onCareer}>Your career</button>
          <button className="secondary" onClick={onLeaderboard}>Leaderboard</button>
        </div>
      </div>

      <div className="game-grid">
        <article className="game-card poker-card">
          <div className="card-art">
            <div className="playing-card card-red"><b>A</b><span>♥</span></div>
            <div className="playing-card card-dark"><b>K</b><span>♠</span></div>
          </div>
          <div className="game-info">
            <div>
              <p className="game-label">CLASSIC</p>
              <h2>Texas Hold'em</h2>
            </div>
            <span className="table-count">{lobby.pokerPlayers} at tables</span>
            <button onClick={onPoker}>Find a Table <b>→</b></button>
          </div>
        </article>

        <article className="game-card blackjack-card">
          <div className="card-art">
            <div className="playing-card card-dark"><b>Q</b><span>♠</span></div>
            <div className="playing-card card-red"><b>J</b><span>♦</span></div>
          </div>
          <div className="game-info">
            <div>
              <p className="game-label">FAST PLAY</p>
              <h2>Blackjack</h2>
            </div>
            <span className="table-count">{lobby.blackjackPlayers} at tables</span>
            <button onClick={onBlackjack}>Find a Table <b>→</b></button>
          </div>
        </article>
      </div>
    </section>
  );
}
