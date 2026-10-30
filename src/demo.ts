import { randomBytes } from "node:crypto";
import type { DibsRuntime } from "./runtime.js";

export interface RoomEntry {
  runtime: DibsRuntime;
  lastAccess: number;
}

export class DemoRoomRegistry {
  private readonly rooms = new Map<string, RoomEntry>();

  constructor(
    private readonly createRuntime: () => DibsRuntime,
    private readonly now: () => number = Date.now,
    readonly maxRooms = 50,
    readonly idleMs = 30 * 60 * 1000,
  ) {}

  createId(): string {
    this.evictIdle();
    if (this.rooms.size >= this.maxRooms) {
      const oldest = [...this.rooms.entries()].sort(
        (a, b) => a[1].lastAccess - b[1].lastAccess,
      )[0];
      if (!oldest || this.now() - oldest[1].lastAccess < this.idleMs) {
        throw new Error("All demo rooms are busy. Try again in a few minutes.");
      }
      this.rooms.delete(oldest[0]);
    }
    let id = randomBytes(8).toString("hex");
    while (this.rooms.has(id)) id = randomBytes(8).toString("hex");
    this.rooms.set(id, {
      runtime: this.createRuntime(),
      lastAccess: this.now(),
    });
    return id;
  }

  get(id: string): DibsRuntime {
    if (!/^[a-z0-9]{4,16}$/i.test(id)) throw new Error("Invalid room id.");
    this.evictIdle();
    const room = this.rooms.get(id);
    if (!room)
      throw new Error(
        "Demo room expired. Open the demo home page to start a new room.",
      );
    room.lastAccess = this.now();
    return room.runtime;
  }

  touch(id: string): void {
    const room = this.rooms.get(id);
    if (room) room.lastAccess = this.now();
  }

  get size(): number {
    this.evictIdle();
    return this.rooms.size;
  }

  private evictIdle(): void {
    const cutoff = this.now() - this.idleMs;
    for (const [id, room] of this.rooms) {
      if (room.lastAccess <= cutoff) this.rooms.delete(id);
    }
  }
}

export class IpRateLimiter {
  private readonly hits = new Map<string, number[]>();

  constructor(
    private readonly maximum = 30,
    private readonly windowMs = 60_000,
    private readonly now: () => number = Date.now,
  ) {}

  allow(ip: string): boolean {
    const current = this.now();
    const remaining = (this.hits.get(ip) ?? []).filter(
      (at) => current - at < this.windowMs,
    );
    if (remaining.length >= this.maximum) {
      this.hits.set(ip, remaining);
      return false;
    }
    remaining.push(current);
    this.hits.set(ip, remaining);
    return true;
  }
}

export function firstForwardedIp(
  value: string | undefined,
  fallback: string,
): string {
  return value?.split(",")[0]?.trim() || fallback;
}
