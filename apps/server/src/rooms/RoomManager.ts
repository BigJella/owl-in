import { randomUUID } from "node:crypto";
import type { BotMode, PokerRoomSummary, TableSettings } from "@owl-in/shared";
import type { Moderation } from "../admin/Moderation";
import type { HouseBank } from "../economy/HouseBank";
import type { StatsStore } from "../stats/StatsStore";
import type { HumanPlayer } from "../players/HumanPlayer";
import { PokerRoom, type LlmBotOptions, type RoomTiming } from "./PokerRoom";

export const MIN_OPEN_ROOMS = 2;

export interface RoomManagerOptions {
  bank: HouseBank;
  /** Career stats store shared by every room. */
  stats?: StatsStore;
  timing?: Partial<RoomTiming>;
  /** The LLM call and decision log shared by every room (none = all bots play by script). */
  llm?: LlmBotOptions;
  /** Max bots / max AI for new tables (defaults 4 / 2). */
  defaults?: Partial<TableSettings>;
  moderation?: Moderation;
  /** Called (batched per tick) whenever the room list changes. */
  onRoomsChanged?: (rooms: PokerRoomSummary[]) => void;
}

export class RoomManager {
  readonly rooms = new Map<string, PokerRoom>();
  private publishQueued = false;

  constructor(private readonly options: RoomManagerOptions) {}

  /** The two always-on tables. */
  seed() {
    this.create("Freshman Meal Plan", 10);
    this.create("Unlimited Swipes", 100);
  }

  create(name: string, bigBlind: number, settings: Partial<TableSettings> = {}): PokerRoom {
    const room = new PokerRoom({
      settings: { ...this.options.defaults, ...settings },
      ...(this.options.moderation ? { moderation: this.options.moderation } : {}),
      id: randomUUID().slice(0, 8),
      name,
      bigBlind,
      bank: this.options.bank,
      ...(this.options.stats ? { stats: this.options.stats } : {}),
      ...(this.options.timing ? { timing: this.options.timing } : {}),
      ...(this.options.llm ? { llm: this.options.llm } : {}),
      onChange: () => this.publish(),
      canClose: () => this.rooms.size > MIN_OPEN_ROOMS,
      onClose: (closed) => {
        this.rooms.delete(closed.id);
        this.publish();
      },
    });
    this.rooms.set(room.id, room);
    room.start();
    return room;
  }

  get(roomId: string | null): PokerRoom | undefined {
    return roomId ? this.rooms.get(roomId) : undefined;
  }

  roomOf(player: HumanPlayer): PokerRoom | undefined {
    return player.game === "poker" ? this.get(player.roomId) : undefined;
  }

  list(): PokerRoomSummary[] {
    return [...this.rooms.values()].map((room) => room.summary());
  }

  /** Dining Dollars the player has at a poker table right now. */
  chipsOf(player: HumanPlayer): number {
    return this.roomOf(player)?.chipsOf(player) ?? 0;
  }

  humanCount(): number {
    let count = 0;
    for (const room of this.rooms.values()) count += room.humanCount() + room.waitingCount();
    return count;
  }

  /** Pin a bot to script / LLM (null = follow the table's AI count), wherever it sits. */
  setBotOverride(botId: string, mode: BotMode | null): boolean {
    for (const room of this.rooms.values()) if (room.setBotOverride(botId, mode)) return true;
    return false;
  }

  /** Tables still taking players (not closing). */
  openCount(): number {
    return [...this.rooms.values()].filter((room) => !room.closing).length;
  }

  shutdown() {
    for (const room of this.rooms.values()) room.close();
  }

  private publish() {
    if (this.publishQueued) return;
    this.publishQueued = true;
    queueMicrotask(() => {
      this.publishQueued = false;
      this.options.onRoomsChanged?.(this.list());
    });
  }
}
