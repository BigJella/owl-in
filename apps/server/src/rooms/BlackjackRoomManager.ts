import { randomUUID } from "node:crypto";
import type { BlackjackRoomSummary } from "@owl-in/shared";
import type { HouseBank } from "../economy/HouseBank";
import type { StatsStore } from "../stats/StatsStore";
import type { HumanPlayer } from "../players/HumanPlayer";
import { BlackjackRoom, type BlackjackTiming } from "./BlackjackRoom";
import { MIN_OPEN_ROOMS } from "./RoomManager";

export interface BlackjackRoomManagerOptions {
  bank: HouseBank;
  /** Career stats store shared by every room. */
  stats?: StatsStore;
  timing?: Partial<BlackjackTiming>;
  /** Called (batched per tick) whenever the room list changes. */
  onRoomsChanged?: (rooms: BlackjackRoomSummary[]) => void;
}

export class BlackjackRoomManager {
  readonly rooms = new Map<string, BlackjackRoom>();
  private publishQueued = false;

  constructor(private readonly options: BlackjackRoomManagerOptions) {}

  /** The two always-on tables. */
  seed() {
    this.create("Owl's Nest", 10);
    this.create("High Limit", 100);
  }

  create(name: string, minBet: number): BlackjackRoom {
    const room = new BlackjackRoom({
      id: `bj-${randomUUID().slice(0, 8)}`,
      name,
      minBet,
      bank: this.options.bank,
      ...(this.options.stats ? { stats: this.options.stats } : {}),
      ...(this.options.timing ? { timing: this.options.timing } : {}),
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

  get(roomId: string | null): BlackjackRoom | undefined {
    return roomId ? this.rooms.get(roomId) : undefined;
  }

  roomOf(player: HumanPlayer): BlackjackRoom | undefined {
    return player.game === "blackjack" ? this.get(player.roomId) : undefined;
  }

  list(): BlackjackRoomSummary[] {
    return [...this.rooms.values()].map((room) => room.summary());
  }

  humanCount(): number {
    let count = 0;
    for (const room of this.rooms.values()) count += room.humanCount();
    return count;
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
