import { afterEach, describe, expect, it } from "vitest";
import {
  DemoRoomRegistry,
  IpRateLimiter,
  firstForwardedIp,
} from "../src/demo.js";
import { createDibsHttpServer, DibsRuntime } from "../src/runtime.js";
import { isPromotedRow } from "../public/overlay-helpers.js";

let server: ReturnType<typeof createDibsHttpServer> | undefined;

afterEach(async () => {
  if (!server) return;
  await new Promise<void>((resolve) => server!.close(() => resolve()));
  server = undefined;
});

async function listenPublic(
  options: Parameters<typeof createDibsHttpServer>[1] = {},
) {
  const base = new DibsRuntime({ mode: "rehearsal", env: {} });
  server = createDibsHttpServer(base, options);
  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Expected an HTTP server address.");
  return `http://127.0.0.1:${address.port}`;
}

describe("public demo safety and room state", () => {
  it("creates a room URL for the one-tab landing page", async () => {
    const registry = new DemoRoomRegistry(() => {
      const room = new DibsRuntime({ mode: "rehearsal", env: {} });
      room.openDrop({
        title: "Rehearsal ready — press Run rehearsal",
        spots: 5,
      });
      return room;
    });
    const baseUrl = await listenPublic({
      publicDemo: true,
      roomRegistry: registry,
    });
    const redirect = await fetch(baseUrl, { redirect: "manual" });
    const location = redirect.headers.get("location");
    expect(redirect.status).toBe(302);
    expect(location).toMatch(/^\/?\?room=[a-f0-9]{16}$/);
    const page = await fetch(`${baseUrl}${location}`);
    expect(await page.text()).toContain("Live Drop Demo");
    const roomId = new URL(location!, baseUrl).searchParams.get("room");
    const state = await (
      await fetch(`${baseUrl}/api/state?room=${roomId}`)
    ).json();
    expect(state.snapshot.drop.title).toContain("Rehearsal ready");
  });

  it("isolates each room's rehearsal state", async () => {
    const registry = new DemoRoomRegistry(
      () => new DibsRuntime({ mode: "rehearsal", env: {} }),
    );
    const baseUrl = await listenPublic({
      publicDemo: true,
      roomRegistry: registry,
      onRehearsalStart: (runtime) => {
        runtime.openDrop({ title: "Room A replay", spots: 2 });
      },
    });

    const roomAId = registry.createId();
    const roomBId = registry.createId();
    const started = await fetch(
      `${baseUrl}/api/rehearsal/start?room=${roomAId}`,
      {
        method: "POST",
      },
    );
    expect(started.status).toBe(202);
    const roomA = await (
      await fetch(`${baseUrl}/api/state?room=${roomAId}`)
    ).json();
    const roomB = await (
      await fetch(`${baseUrl}/api/state?room=${roomBId}`)
    ).json();
    expect(roomA.snapshot.drop.title).toBe("Room A replay");
    expect(roomB.snapshot.drop).toBeUndefined();
  });

  it("evicts rooms idle for thirty minutes", () => {
    let clock = 100;
    const registry = new DemoRoomRegistry(
      () => new DibsRuntime({ mode: "rehearsal", env: {} }),
      () => clock,
      2,
      30 * 60 * 1000,
    );
    const first = registry.createId();
    const firstRuntime = registry.get(first);
    registry.createId();
    expect(registry.size).toBe(2);
    clock += 30 * 60 * 1000 + 1;
    registry.createId();
    expect(registry.size).toBe(1);
    expect(() => registry.get(first)).toThrow("Demo room expired");
    expect(registry.size).toBe(1);
    expect(firstRuntime).toBeDefined();
  });

  it("refuses to allocate beyond its room cap while rooms are active", () => {
    const registry = new DemoRoomRegistry(
      () => new DibsRuntime({ mode: "rehearsal", env: {} }),
      Date.now,
      1,
    );
    registry.createId();
    expect(() => registry.createId()).toThrow("rooms are busy");
  });

  it("limits public drop title length and spots", async () => {
    const registry = new DemoRoomRegistry(
      () => new DibsRuntime({ mode: "rehearsal", env: {} }),
    );
    const baseUrl = await listenPublic({
      publicDemo: true,
      roomRegistry: registry,
    });
    const roomId = registry.createId();
    const tooLong = await fetch(`${baseUrl}/api/drop?room=${roomId}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "x".repeat(61), spots: 5 }),
    });
    const tooMany = await fetch(`${baseUrl}/api/drop?room=${roomId}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Okay", spots: 21 }),
    });
    expect(tooLong.status).toBe(400);
    expect(tooMany.status).toBe(400);
  });

  it("limits mutating requests to thirty per minute per forwarded IP", async () => {
    const registry = new DemoRoomRegistry(
      () => new DibsRuntime({ mode: "rehearsal", env: {} }),
    );
    const baseUrl = await listenPublic({
      publicDemo: true,
      roomRegistry: registry,
    });
    const roomId = registry.createId();
    const responses = await Promise.all(
      Array.from({ length: 31 }, () =>
        fetch(`${baseUrl}/api/drop?room=${roomId}`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Forwarded-For": "198.51.100.42, 10.0.0.8",
          },
          body: JSON.stringify({ title: "Line", spots: 1 }),
        }),
      ),
    );
    expect(
      responses.filter((response) => response.status === 429),
    ).toHaveLength(1);
    expect(firstForwardedIp("198.51.100.42, 10.0.0.8", "fallback")).toBe(
      "198.51.100.42",
    );
  });
});

describe("small demo helpers", () => {
  it("accepts requests under the rolling IP limit and resets expired hits", () => {
    let clock = 0;
    const limiter = new IpRateLimiter(2, 1000, () => clock);
    expect(limiter.allow("viewer")).toBe(true);
    expect(limiter.allow("viewer")).toBe(true);
    expect(limiter.allow("viewer")).toBe(false);
    clock = 1000;
    expect(limiter.allow("viewer")).toBe(true);
  });

  it("flags only a filled row belonging to the promoted viewer", () => {
    expect(isPromotedRow(undefined, "viewer-a")).toBe(false);
    expect(isPromotedRow({ viewerId: "viewer-b" }, "viewer-a")).toBe(false);
    expect(isPromotedRow({ viewerId: "viewer-a" }, "viewer-a")).toBe(true);
  });
});
