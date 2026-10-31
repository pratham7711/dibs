import { describe, expect, it } from "vitest";
import { firstGrapheme } from "../public/avatar-helper.js";
import { DibsRuntime, createDibsHttpServer } from "../src/runtime.js";
import { summarizeBatch } from "../src/twitch/chat.js";
import { publicStatusLine } from "../src/twitch/chat-queries.js";

describe("practice crowd safeguards", () => {
  it("takes dashboard initials by grapheme", () => {
    expect(firstGrapheme("🤖 Dibs")).toBe("🤖");
    expect(firstGrapheme("👩🏽‍🚀 viewer")).toBe("👩🏽‍🚀");
  });

  it("never names practice viewers in chat batch replies", () => {
    const line = summarizeBatch([
      {
        action: "granted",
        display: "RealViewer",
        parentMessageId: "r",
        spotNumber: 1,
      },
      {
        action: "granted",
        display: "FictionalOak",
        parentMessageId: "p",
        practice: true,
      },
      {
        action: "waitlisted",
        display: "FictionalMoss",
        parentMessageId: "p2",
        practice: true,
      },
    ]);
    expect(line).toContain("@RealViewer");
    expect(line).toContain("+2 practice");
    expect(line).not.toContain("Fictional");
    expect(
      summarizeBatch([
        {
          action: "granted",
          display: "FictionalOak",
          parentMessageId: "p",
          practice: true,
        },
      ]),
    ).toBe("");
  });

  it("counts practice claims in status and sold-out lines without naming them", () => {
    const runtime = new DibsRuntime({ mode: "live", env: {} });
    runtime.openDrop({ title: "Showcase", spots: 1 });
    const state = runtime.snapshot;
    state.winners.push({
      messageId: "p",
      viewerId: "practice-oak",
      login: "oak",
      display: "FictionalOak",
      isSubscriber: false,
      twitchTimestamp: 1,
      receivedAt: 1,
      qty: 1,
      source: "chat",
      practice: true,
      confidence: 1,
      reason: "Practice",
    });
    const status = publicStatusLine(state, 1, 2, 2);
    expect(status).toContain("+1 practice");
    expect(status).not.toContain("FictionalOak");
    expect(status).toContain("SOLD OUT");
  });

  it("orders a real claim and practice claim by Twitch timestamp", async () => {
    const runtime = new DibsRuntime({
      mode: "live",
      env: {},
      now: () => 10_000,
    });
    runtime.openDrop({ title: "Race", spots: 2, settleMs: 2000 });
    await runtime.handleNotification({
      messageId: "practice-claim",
      timestamp: 9000,
      practice: true,
      type: "channel.chat.message",
      event: {
        chatter_user_id: "practice-oak",
        chatter_user_login: "oak",
        chatter_user_name: "Oak",
        message: { text: "dibs" },
      },
    });
    await runtime.handleNotification({
      messageId: "real-claim",
      timestamp: 8000,
      type: "channel.chat.message",
      event: {
        chatter_user_id: "real",
        chatter_user_login: "real",
        chatter_user_name: "Real",
        message: { text: "dibs" },
      },
    });
    expect(runtime.snapshot.winners.map((claim) => claim.viewerId)).toEqual([
      "real",
      "practice-oak",
    ]);
    expect(runtime.snapshot.winners[1]?.practice).toBe(true);
  });

  it("serves a stage with an explicitly transparent overlay frame", async () => {
    const runtime = new DibsRuntime({ mode: "rehearsal", env: {} });
    const server = createDibsHttpServer(runtime);
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    try {
      const address = server.address();
      if (!address || typeof address === "string")
        throw new Error("Missing HTTP address");
      const response = await fetch(`http://127.0.0.1:${address.port}/stage`);
      expect(response.status).toBe(200);
      const markup = await response.text();
      expect(markup).toContain("Dibs — OBS Stage");
      expect(markup).toContain('id="overlay"');
      const stageCss = await fetch(
        `http://127.0.0.1:${address.port}/stage.css`,
      ).then((r) => r.text());
      const overlayCss = await fetch(
        `http://127.0.0.1:${address.port}/overlay.css`,
      ).then((r) => r.text());
      expect(stageCss).toMatch(
        /iframe\s*\{[^}]*background:\s*transparent\s*!important/s,
      );
      expect(stageCss).toMatch(/iframe\s*\{[^}]*color-scheme:\s*dark/s);
      expect(overlayCss).toMatch(
        /html,\s*body\s*\{[^}]*background-color:\s*transparent\s*!important/s,
      );
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("uses compact overlay rows above five spots", async () => {
    const { readFile } = await import("node:fs/promises");
    const overlayScript = await readFile("public/overlay.js", "utf8");
    const overlayStyles = await readFile("public/overlay.css", "utf8");
    expect(overlayScript).toContain('classList.toggle("dense", spotTotal > 5)');
    expect(overlayStyles).toMatch(/\.spot-rows\.dense\s*\{[^}]*gap:\s*3px/s);
    expect(overlayStyles).toMatch(
      /\.spot-rows\.dense \.spot-row\s*\{[^}]*min-height:\s*31px/s,
    );
  });

  it("locks the practice start endpoint while a crowd is running", async () => {
    const runtime = new DibsRuntime({ mode: "live", env: {} });
    let running = false;
    const server = createDibsHttpServer(runtime, {
      onPracticeStart: () => {
        if (running) return false;
        running = true;
        return true;
      },
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    try {
      const address = server.address();
      if (!address || typeof address === "string")
        throw new Error("Missing HTTP address");
      const url = `http://127.0.0.1:${address.port}/api/practice/start`;
      expect((await fetch(url, { method: "POST" })).status).toBe(202);
      expect((await fetch(url, { method: "POST" })).status).toBe(409);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
