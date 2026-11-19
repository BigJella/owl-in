import type { CareerView, HandRecord, LeaderboardRow } from "@owl-in/shared";
import type { HumanPlayer } from "../players/HumanPlayer";
import type { StatsStore } from "./StatsStore";

/** Who may open `target`'s career: themselves, or anyone if it's public. */
export function canView(target: HumanPlayer, viewer: HumanPlayer): boolean {
  return target === viewer || target.careerPublic;
}

/**
 * `chips`: what the player has at a table right now (counted with the bankroll so totals don't dip while seated).
 * `viewer` null = the management API (an admin, not a player). Contains no cards either way.
 */
export function careerView(stats: StatsStore, target: HumanPlayer, viewer: HumanPlayer | null, chips: number): CareerView {
  const totals = stats.career(target.id);
  return {
    playerId: target.id,
    name: target.name,
    isPublic: target.careerPublic,
    isMe: target === viewer,
    bankroll: target.bankroll + chips,
    online: target.connected,
    wagered: totals.poker.wagered + totals.blackjack.wagered,
    net: totals.poker.net + totals.blackjack.net,
    poker: totals.poker,
    blackjack: totals.blackjack,
    sessions: totals.sessions,
    chipHistory: totals.chipHistory,
  };
}

/**
 * A session's hands as `viewer` may see them (null = the management API, which sees no hidden cards either). Other people's poker hole cards are hidden unless they were shown at
 * a showdown (folds and uncalled bluffs stay secret); blackjack cards are always public.
 */
export function sessionHandsFor(stats: StatsStore, target: HumanPlayer, viewer: HumanPlayer | null, sessionId: string): HandRecord[] {
  return stats
    .sessionHands(target.id, sessionId)
    .map((h) =>
      h.game === "poker" && target !== viewer && h.showdownHand === null ? { ...h, holeCards: null } : h,
    );
}

/** Everyone ranked by Dining Dollars (bankroll plus chips at a table). */
export function leaderboard(players: HumanPlayer[], viewer: HumanPlayer | null, chipsOf: (p: HumanPlayer) => number): LeaderboardRow[] {
  return players
    .map((p) => ({ p, total: p.bankroll + chipsOf(p) }))
    .sort((a, b) => b.total - a.total || a.p.name.localeCompare(b.p.name))
    .map(({ p, total }, i) => ({
      rank: i + 1,
      playerId: p.id,
      name: p.name,
      bankroll: total,
      online: p.connected,
      isPublic: p.careerPublic,
      isMe: p === viewer,
    }));
}
