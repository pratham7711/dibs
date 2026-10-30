import { afterEach, describe, expect, it } from "vitest";
import { createDibsHttpServer, DibsRuntime } from "../src/runtime.js";

let server: ReturnType<typeof createDibsHttpServer> | undefined;

afterEach(async () => {
  if (!server) return;
  await new Promise<void>((resolve) => server!.close(() => resolve()));
  server = undefined;
});

describe("server SSE view", () => {
  it("serves the overlay and dashboard as static pages", async () => {
    const runtime = new DibsRuntime({ mode: "rehearsal", env: {} });
    server = createDibsHttpServer(runtime);
    await new Promise<void>((resolve) =>
      server!.listen(0, "127.0.0.1", resolve),
    );
    const address = server.address();
    if (!address || typeof address === "string")
      throw new Error("Expected an HTTP server address.");

    const overlay = await fetch(`http://127.0.0.1:${address.port}/overlay`);
    const dashboard = await fetch(`http://127.0.0.1:${address.port}/dashboard`);
    expect(overlay.headers.get("content-type")).toContain("text/html");
    expect(await overlay.text()).toContain("Dibs Overlay");
    expect(await dashboard.text()).toContain("Dibs — Control room");
  });

  it("streams allocation, activity feed, mode, and connection status", async () => {
    const runtime = new DibsRuntime({ mode: "rehearsal", env: {} });
    runtime.openDrop({ title: "SSE check", spots: 2 });
    server = createDibsHttpServer(runtime);
    await new Promise<void>((resolve) =>
      server!.listen(0, "127.0.0.1", resolve),
    );
    const address = server.address();
    if (!address || typeof address === "string")
      throw new Error("Expected an HTTP server address.");

    const response = await fetch(`http://127.0.0.1:${address.port}/events`);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    const reader = response.body!.getReader();
    const firstChunk = await reader.read();
    const frame = new TextDecoder().decode(firstChunk.value);
    await reader.cancel();
    const payload = JSON.parse(frame.replace(/^data: /, "").trim());

    expect(payload).toMatchObject({
      snapshot: {
        drop: { title: "SSE check", spots: 2 },
        winners: [],
        waitlist: [],
      },
      feed: [],
      mode: "rehearsal",
      modelConfigured: false,
      twitchConnected: false,
    });
  });

  it("sends proxy-safe headers and periodic SSE ping comments", async () => {
    const runtime = new DibsRuntime({ mode: "rehearsal", env: {} });
    server = createDibsHttpServer(runtime, { ssePingMs: 10 });
    await new Promise<void>((resolve) =>
      server!.listen(0, "127.0.0.1", resolve),
    );
    const address = server.address();
    if (!address || typeof address === "string")
      throw new Error("Expected an HTTP server address.");

    const response = await fetch(`http://127.0.0.1:${address.port}/events`);
    expect(response.headers.get("cache-control")).toBe(
      "no-cache, no-transform",
    );
    expect(response.headers.get("x-accel-buffering")).toBe("no");
    const reader = response.body!.getReader();
    await reader.read();
    const ping = await reader.read();
    expect(new TextDecoder().decode(ping.value)).toContain(": ping");
    await reader.cancel();
  });

  it("serves the health check", async () => {
    const runtime = new DibsRuntime({ mode: "rehearsal", env: {} });
    server = createDibsHttpServer(runtime);
    await new Promise<void>((resolve) =>
      server!.listen(0, "127.0.0.1", resolve),
    );
    const address = server.address();
    if (!address || typeof address === "string")
      throw new Error("Expected an HTTP server address.");
    const response = await fetch(`http://127.0.0.1:${address.port}/healthz`);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("ok");
  });
});
