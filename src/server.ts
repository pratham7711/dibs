import "dotenv/config";
import { DibsRuntime, createDibsHttpServer } from "./runtime.js";
import { runPracticeCrowd, runRehearsal } from "./rehearsal.js";
import { DemoRoomRegistry } from "./demo.js";

export interface ServerStartOptions {
  port?: number;
  rehearsalMode?: boolean;
  rehearsalSleep?: (milliseconds: number) => Promise<void>;
  autoRunRehearsal?: boolean;
  publicDemo?: boolean;
}

export async function startServer(options: ServerStartOptions = {}) {
  const port = options.port ?? Number(process.env.PORT ?? 3000);
  const hasTwitchConfiguration = Boolean(
    process.env.TWITCH_CLIENT_ID && process.env.TWITCH_CHANNEL,
  );
  const publicDemo = options.publicDemo ?? process.env.DIBS_PUBLIC_DEMO === "1";
  const rehearsalOnly =
    publicDemo || options.rehearsalMode || !hasTwitchConfiguration;
  const makeRehearsalRuntime = () => {
    const roomRuntime = new DibsRuntime({ mode: "rehearsal" });
    roomRuntime.openDrop({
      title: "Rehearsal ready — press Run rehearsal",
      spots: 5,
    });
    return roomRuntime;
  };
  const runtime = rehearsalOnly
    ? makeRehearsalRuntime()
    : new DibsRuntime({ mode: "live" });
  const roomRegistry = publicDemo
    ? new DemoRoomRegistry(makeRehearsalRuntime)
    : undefined;
  if (!rehearsalOnly) await runtime.start();

  const runningRooms = new WeakSet<DibsRuntime>();
  const runningPractice = new WeakSet<DibsRuntime>();
  const launchRehearsal = (target: DibsRuntime = runtime) => {
    if (runningRooms.has(target)) return;
    runningRooms.add(target);
    target.stop();
    void runRehearsal(
      target,
      options.rehearsalSleep ? { sleep: options.rehearsalSleep } : {},
    ).finally(() => {
      runningRooms.delete(target);
    });
  };
  const launchPractice = (target: DibsRuntime) => {
    if (
      rehearsalOnly ||
      target.view.mode !== "live" ||
      target.snapshot.drop?.status !== "open" ||
      runningPractice.has(target)
    )
      return false;
    runningPractice.add(target);
    target.setPracticeRunning(true);
    void runPracticeCrowd(
      target,
      options.rehearsalSleep ? { sleep: options.rehearsalSleep } : {},
    ).finally(() => {
      runningPractice.delete(target);
      target.setPracticeRunning(false);
    });
    return true;
  };
  const server = createDibsHttpServer(runtime, {
    onRehearsalStart: launchRehearsal,
    onPracticeStart: launchPractice,
    publicDemo,
    ...(roomRegistry ? { roomRegistry } : {}),
  });
  await new Promise<void>((resolve) => server.listen(port, resolve));
  const address = server.address();
  const actualPort =
    address && typeof address !== "string" ? address.port : port;
  console.log(`Dibs dashboard is listening on http://localhost:${actualPort}`);
  if (rehearsalOnly) {
    console.log(
      "No Twitch credentials configured. Rehearsal is ready; click Run rehearsal to start the 32-second crowd.",
    );
    if (options.autoRunRehearsal && !publicDemo) launchRehearsal();
  }
  return { server, runtime, port: actualPort };
}

if (process.argv[1]?.endsWith("/server.ts")) {
  startServer().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
