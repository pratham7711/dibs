import type { DibsRuntime } from "./runtime.js";
import type { TwitchNotification } from "./twitch/eventsub.js";

export interface RehearsalOptions {
  sleep?: (milliseconds: number) => Promise<void>;
}

interface ScriptMessage {
  atMs: number;
  id: string;
  viewer: string;
  text: string;
  timestampOffsetMs: number;
  subscriber?: boolean;
  duplicateOf?: string;
  points?: boolean;
}

const crowd: ScriptMessage[] = [
  {
    atMs: 150,
    id: "burst-1",
    viewer: "Sprout",
    text: "dibs",
    timestampOffsetMs: 1000,
    subscriber: true,
  },
  {
    atMs: 300,
    id: "burst-2",
    viewer: "Oak",
    text: "me!!",
    timestampOffsetMs: 1120,
  },
  {
    atMs: 500,
    id: "burst-3",
    viewer: "Bluejay",
    text: "🙋",
    timestampOffsetMs: 1430,
  },
  {
    atMs: 800,
    id: "burst-4",
    viewer: "Tix",
    text: "channel points",
    timestampOffsetMs: 1900,
    points: true,
  },
  {
    atMs: 1450,
    id: "trap-free",
    viewer: "Pine",
    text: "is it free?",
    timestampOffsetMs: 2200,
  },
  {
    atMs: 1750,
    id: "trap-who",
    viewer: "Ash",
    text: "who got it?",
    timestampOffsetMs: 2300,
  },
  {
    atMs: 2050,
    id: "trap-anyone",
    viewer: "Puddle",
    text: "can anyone get one?",
    timestampOffsetMs: 2400,
  },
  {
    atMs: 2350,
    id: "trap-negation",
    viewer: "Dew",
    text: "I don't want it",
    timestampOffsetMs: 2500,
  },
  {
    atMs: 2700,
    id: "burst-5",
    viewer: "Robin",
    text: "slot 3 pls",
    timestampOffsetMs: 2050,
  },
  {
    atMs: 2800,
    id: "wait-hinglish",
    viewer: "Pebble",
    text: "mujhe ek chahiye",
    timestampOffsetMs: 2600,
  },
  {
    atMs: 3300,
    id: "wait-late",
    viewer: "Moss",
    text: "dibs",
    timestampOffsetMs: 2700,
  },
  {
    atMs: 3900,
    id: "late-fair",
    viewer: "EarlyBird",
    text: "dibs",
    timestampOffsetMs: 900,
  },
  {
    atMs: 4700,
    id: "hinglish-model",
    viewer: "Bhai",
    text: "bhai ek mere liye bhi rakhna",
    timestampOffsetMs: 3000,
  },
  {
    atMs: 5400,
    id: "proxy-brother",
    viewer: "Comet",
    text: "save one for my brother",
    timestampOffsetMs: 3100,
  },
  {
    atMs: 6200,
    id: "wait-wren",
    viewer: "Wren",
    text: "dibs",
    timestampOffsetMs: 3200,
  },
  {
    atMs: 7000,
    id: "wait-cloud",
    viewer: "Cloud",
    text: "I'll take it",
    timestampOffsetMs: 3300,
  },
  {
    atMs: 7800,
    id: "wait-slot",
    viewer: "Noodle",
    text: "#3 please",
    timestampOffsetMs: 3400,
  },
  {
    atMs: 8600,
    id: "duplicate",
    viewer: "RobinAgain",
    text: "dibs",
    timestampOffsetMs: 2050,
    duplicateOf: "burst-5",
  },
  {
    atMs: 9400,
    id: "proxy-teammate",
    viewer: "Teammate",
    text: "save one for my teammate",
    timestampOffsetMs: 3500,
  },
  {
    atMs: 11200,
    id: "wait-daisy",
    viewer: "Daisy",
    text: "dibs",
    timestampOffsetMs: 3600,
  },
  {
    atMs: 13200,
    id: "wait-orbit",
    viewer: "Orbit",
    text: "me",
    timestampOffsetMs: 3700,
  },
  {
    atMs: 15000,
    id: "wait-fern",
    viewer: "Fern",
    text: "dibs",
    timestampOffsetMs: 3800,
  },
  {
    atMs: 17600,
    id: "wait-poppy",
    viewer: "Poppy",
    text: "dibs",
    timestampOffsetMs: 3900,
  },
  {
    atMs: 20000,
    id: "cancel-sprout",
    viewer: "Sprout",
    text: "nvm",
    timestampOffsetMs: 4000,
  },
  {
    atMs: 22600,
    id: "wait-mochi",
    viewer: "Mochi",
    text: "mera",
    timestampOffsetMs: 4100,
  },
  {
    atMs: 26000,
    id: "cancel-bluejay",
    viewer: "Bluejay",
    text: "cancel mine",
    timestampOffsetMs: 4200,
  },
  {
    atMs: 28400,
    id: "wait-bubbles",
    viewer: "Bubbles",
    text: "dibs",
    timestampOffsetMs: 4300,
  },
  {
    atMs: 30000,
    id: "wait-lime",
    viewer: "Lime",
    text: "dibs",
    timestampOffsetMs: 4400,
  },
  {
    atMs: 31000,
    id: "question-end",
    viewer: "Marble",
    text: "when does it end?",
    timestampOffsetMs: 4500,
  },
  {
    atMs: 32000,
    id: "last-cheer",
    viewer: "Taco",
    text: "Kappa",
    timestampOffsetMs: 4600,
  },
];

export function rehearsalCrowd(): readonly ScriptMessage[] {
  return crowd;
}

export async function runRehearsal(
  runtime: DibsRuntime,
  options: RehearsalOptions = {},
): Promise<void> {
  const sleep =
    options.sleep ??
    ((milliseconds) =>
      new Promise((resolve) => setTimeout(resolve, milliseconds)));
  runtime.setMode("rehearsal");
  if (runtime.snapshot.drop?.status === "open") runtime.closeDrop();
  runtime.openDrop({
    title: "Community duo queue",
    spots: 5,
    perViewerLimit: 1,
    subsFirstSeconds: 0.25,
    settleMs: 3000,
  });

  const baseTimestamp = Date.now();
  let elapsed = 0;
  let approved = false;
  for (const message of crowd) {
    const pause = message.atMs - elapsed;
    if (pause > 0) await sleep(pause);
    elapsed = message.atMs;
    if (!approved && elapsed >= 15000) {
      const reviewItem = runtime.snapshot.reviewQueue.find(
        (claim) => claim.viewerId === "rehearsal-Teammate",
      );
      if (reviewItem) runtime.approveClaim(reviewItem.messageId);
      approved = true;
    }
    const source = message.duplicateOf
      ? crowd.find((candidate) => candidate.id === message.duplicateOf)!
      : message;
    const notification: TwitchNotification = message.points
      ? {
          messageId: message.id,
          timestamp: baseTimestamp + message.timestampOffsetMs,
          type: "channel.channel_points_custom_reward_redemption.add",
          event: {
            user_id: `rehearsal-${message.viewer}`,
            user_login: message.viewer.toLowerCase(),
            user_name: message.viewer,
            reward: { title: "Duo queue entry" },
          },
        }
      : {
          messageId: source.id,
          timestamp: baseTimestamp + message.timestampOffsetMs,
          type: "channel.chat.message",
          event: {
            chatter_user_id: `rehearsal-${message.viewer}`,
            chatter_user_login: message.viewer.toLowerCase(),
            chatter_user_name: message.viewer,
            color: rehearsalColor(message.viewer),
            badges: message.subscriber
              ? [{ set_id: "subscriber", id: "1", info: "" }]
              : [],
            message: { text: message.text },
          },
        };
    await runtime.handleNotification(notification);
  }
  runtime.closeDrop();
}

function rehearsalColor(name: string): string {
  const palette = ["#c7ff5e", "#71e7e1", "#c29aff", "#ffb77d", "#77a9ff"];
  return palette[
    [...name].reduce((sum, character) => sum + character.charCodeAt(0), 0) %
      palette.length
  ]!;
}
