import { randomUUID } from "node:crypto";
import { handTotal } from "@owl-in/game-engine";
import {
  STARTING_BANKROLL,
  emptyBlackjackStats,
  emptyPokerStats,
  type BlackjackRoundRecord,
  type HandRecord,
  type PokerHandRecord,
  type SessionEndReason,
  type TableSession,
} from "@owl-in/shared";
import type { CareerTotals, SessionStart, StatsStore } from "./StatsStore";

/** Hand records kept per player (totals are never capped, only the detailed history). */
export const MAX_HANDS_PER_PLAYER = 5_000;

interface PlayerStats extends CareerTotals {
  hands: HandRecord[];
  /** Hands played so far, and Dining Dollars now (starting bankroll + every hand's net). */
  handCount: number;
  total: number;
}

/** Career stats in server memory. A restart wipes them, just like bankrolls. */
export class MemoryStatsStore implements StatsStore {
  private readonly players = new Map<string, PlayerStats>();
  private readonly sessions = new Map<string, { playerId: string; session: TableSession }>();

  openSession(playerId: string, start: SessionStart): string {
    const session: TableSession = {
      id: randomUUID(),
      game: start.game,
      roomId: start.roomId,
      roomName: start.roomName,
      stakes: start.stakes,
      joinedAt: Date.now(),
      leftAt: null,
      buyIn: start.buyIn,
      cashOut: null,
      hands: 0,
      wagered: 0,
      net: 0,
      endReason: null,
    };
    this.stats(playerId).sessions.push(session);
    this.sessions.set(session.id, { playerId, session });
    return session.id;
  }

  addBuyIn(sessionId: string, amount: number) {
    const s = this.sessions.get(sessionId)?.session;
    if (s) s.buyIn = (s.buyIn ?? 0) + amount;
  }

  closeSession(sessionId: string, end: { cashOut: number | null; reason: SessionEndReason }) {
    const s = this.sessions.get(sessionId)?.session;
    if (!s || s.leftAt !== null) return;
    s.leftAt = Date.now();
    s.cashOut = end.cashOut;
    s.endReason = end.reason;
  }

  recordPokerHand(playerId: string, record: PokerHandRecord, showdown: { reached: boolean; won: boolean }) {
    const p = this.stats(playerId).poker;
    p.hands += 1;
    if (record.result === "won") p.won += 1;
    else if (record.result === "lost") p.lost += 1;
    else if (record.result === "split") p.splitPot += 1;
    else p.folded += 1;
    if (showdown.reached) p.showdowns += 1;
    if (showdown.won) p.showdownsWon += 1;
    p.wagered += record.wagered;
    p.returned += record.returned;
    p.net += record.net;
    p.netVsPlayers += record.vsPlayers;
    p.netVsBots += record.vsBots;
    this.addRecord(playerId, record);
  }

  recordBlackjackRound(playerId: string, record: BlackjackRoundRecord) {
    const b = this.stats(playerId).blackjack;
    b.rounds += 1;
    // Split and insurance are rates per round: count the round once, however many spots split or insured.
    if (record.spots.some((spot) => spot.hands.length > 1)) b.splits += 1;
    if (record.spots.some((spot) => spot.insurance > 0)) b.insurances += 1;
    for (const spot of record.spots) {
      for (const hand of spot.hands) {
        b.hands += 1;
        if (hand.result === "win") b.wins += 1;
        else if (hand.result === "blackjack") {
          b.wins += 1;
          b.blackjacks += 1;
        } else if (hand.result === "push") b.pushes += 1;
        else if (hand.result === "surrender") {
          b.losses += 1;
          b.surrenders += 1;
        } else b.losses += 1;
        if (hand.doubled) b.doubles += 1;
        if (handTotal(hand.cards).total > 21) b.busts += 1;
      }
    }
    b.wagered += record.wagered;
    b.returned += record.returned;
    b.net += record.net;
    this.addRecord(playerId, record);
  }

  career(playerId: string): CareerTotals {
    const s = this.stats(playerId);
    return {
      poker: { ...s.poker },
      blackjack: { ...s.blackjack },
      sessions: s.sessions.map((session) => ({ ...session })).reverse(),
      chipHistory: s.chipHistory.map((point) => ({ ...point })),
    };
  }

  sessionHands(playerId: string, sessionId: string): HandRecord[] {
    return this.stats(playerId).hands.filter((h) => h.sessionId === sessionId);
  }

  private addRecord(playerId: string, record: HandRecord) {
    const stats = this.stats(playerId);
    const session = this.sessions.get(record.sessionId)?.session;
    if (session) {
      session.hands += 1;
      session.wagered += record.wagered;
      session.net += record.net;
    }
    stats.hands.push(record);
    if (stats.hands.length > MAX_HANDS_PER_PLAYER) stats.hands.splice(0, stats.hands.length - MAX_HANDS_PER_PLAYER);
    // Only hands move money between players and the house, so the running total is the player's Dining Dollars.
    stats.handCount += 1;
    stats.total += record.net;
    stats.chipHistory.push({ hand: stats.handCount, at: record.at, game: record.game, net: record.net, total: stats.total });
    if (stats.chipHistory.length > MAX_HANDS_PER_PLAYER) stats.chipHistory.splice(0, stats.chipHistory.length - MAX_HANDS_PER_PLAYER);
  }

  private stats(playerId: string): PlayerStats {
    let s = this.players.get(playerId);
    if (!s) {
      s = {
        poker: emptyPokerStats(),
        blackjack: emptyBlackjackStats(),
        sessions: [],
        hands: [],
        chipHistory: [],
        handCount: 0,
        total: STARTING_BANKROLL,
      };
      this.players.set(playerId, s);
    }
    return s;
  }
}
