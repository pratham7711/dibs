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
}

const crowd: ScriptMessage[] = [
  {
    atMs: 0,
    id: "crowd-01",
    viewer: "Pine",
    text: "is it free?",
    timestampOffsetMs: 10,
  },
  {
    atMs: 500,
    id: "crowd-02",
    viewer: "Ash",
    text: "who got it?",
    timestampOffsetMs: 20,
  },
  {
    atMs: 1500,
    id: "crowd-03",
    viewer: "Sprout",
    text: "dibs",
    timestampOffsetMs: 3000,
    subscriber: true,
  },
  {
    atMs: 2200,
    id: "crowd-04",
    viewer: "Oak",
    text: "me!!",
    timestampOffsetMs: 5000,
  },
  {
    atMs: 2800,
    id: "crowd-05",
    viewer: "Bluejay",
    text: "dibs",
    timestampOffsetMs: 6000,
  },
  {
    atMs: 3400,
    id: "crowd-06",
    viewer: "Robin",
    text: "dibs",
    timestampOffsetMs: 7000,
  },
  {
    atMs: 4000,
    id: "crowd-07",
    viewer: "Moss",
    text: "dibs",
    timestampOffsetMs: 8000,
  },
  {
    atMs: 4600,
    id: "crowd-08",
    viewer: "Finch",
    text: "dibs",
    timestampOffsetMs: 9000,
  },
  {
    atMs: 4800,
    id: "crowd-09",
    viewer: "EarlyBird",
    text: "dibs",
    timestampOffsetMs: 1000,
  },
  {
    atMs: 5500,
    id: "crowd-10",
    viewer: "Pixel",
    text: "could i maybe get one too?",
    timestampOffsetMs: 10000,
  },
  {
    atMs: 6500,
    id: "crowd-11",
    viewer: "Comet",
    text: "save one for my brother",
    timestampOffsetMs: 11000,
  },
  {
    atMs: 7000,
    id: "crowd-12",
    viewer: "FinchAgain",
    text: "dibs",
    timestampOffsetMs: 9000,
    duplicateOf: "crowd-08",
  },
  {
    atMs: 7600,
    id: "crowd-13",
    viewer: "Wren",
    text: "dibs",
    timestampOffsetMs: 12000,
  },
  {
    atMs: 8200,
    id: "crowd-14",
    viewer: "Pebble",
    text: "mujhe ek chahiye",
    timestampOffsetMs: 13000,
  },
  {
    atMs: 8800,
    id: "crowd-15",
    viewer: "Cloud",
    text: "dibs",
    timestampOffsetMs: 14000,
  },
  {
    atMs: 9400,
    id: "crowd-16",
    viewer: "Noodle",
    text: "slot 3 pls",
    timestampOffsetMs: 15000,
  },
  {
    atMs: 10000,
    id: "crowd-17",
    viewer: "Daisy",
    text: "dibs",
    timestampOffsetMs: 16000,
  },
  {
    atMs: 10600,
    id: "crowd-18",
    viewer: "PebbleTwo",
    text: "is it free?",
    timestampOffsetMs: 17000,
  },
  {
    atMs: 11200,
    id: "crowd-19",
    viewer: "Orbit",
    text: "dibs",
    timestampOffsetMs: 18000,
  },
  {
    atMs: 11800,
    id: "crowd-20",
    viewer: "Fern",
    text: "I'll take it",
    timestampOffsetMs: 19000,
  },
  {
    atMs: 12400,
    id: "crowd-21",
    viewer: "Poppy",
    text: "dibs",
    timestampOffsetMs: 20000,
  },
  {
    atMs: 13000,
    id: "crowd-22",
    viewer: "Mochi",
    text: "mera",
    timestampOffsetMs: 21000,
  },
  {
    atMs: 13600,
    id: "crowd-23",
    viewer: "Bubbles",
    text: "dibs",
    timestampOffsetMs: 22000,
  },
  {
    atMs: 14200,
    id: "crowd-24",
    viewer: "Lime",
    text: "who got it?",
    timestampOffsetMs: 23000,
  },
  {
    atMs: 16000,
    id: "crowd-25",
    viewer: "Sprout",
    text: "nvm",
    timestampOffsetMs: 24000,
  },
  {
    atMs: 17000,
    id: "crowd-26",
    viewer: "Bluejay",
    text: "cancel mine",
    timestampOffsetMs: 25000,
  },
  {
    atMs: 17600,
    id: "crowd-27",
    viewer: "Puddle",
    text: "can anyone get one?",
    timestampOffsetMs: 26000,
  },
  {
    atMs: 18200,
    id: "crowd-28",
    viewer: "Dew",
    text: "I don't want it",
    timestampOffsetMs: 27000,
  },
  {
    atMs: 19000,
    id: "crowd-29",
    viewer: "Marble",
    text: "dibs",
    timestampOffsetMs: 28000,
  },
  {
    atMs: 20000,
    id: "crowd-30",
    viewer: "Taco",
    text: "Kappa",
    timestampOffsetMs: 29000,
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
    subsFirstSeconds: 2,
    settleMs: 1500,
  });

  const baseTimestamp = Date.now();
  let elapsed = 0;
  for (const message of crowd) {
    const pause = message.atMs - elapsed;
    if (pause > 0) await sleep(pause);
    elapsed = message.atMs;
    const source = message.duplicateOf
      ? crowd.find((candidate) => candidate.id === message.duplicateOf)!
      : message;
    const notification: TwitchNotification = {
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
}

function rehearsalColor(name: string): string {
  const palette = ["#c7ff5e", "#71e7e1", "#c29aff", "#ffb77d", "#77a9ff"];
  return palette[
    [...name].reduce((sum, character) => sum + character.charCodeAt(0), 0) %
      palette.length
  ]!;
}
