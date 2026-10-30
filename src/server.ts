import "dotenv/config";
import { DibsRuntime, createDibsHttpServer } from "./runtime.js";
import { runRehearsal } from "./rehearsal.js";

export interface ServerStartOptions {
  port?: number;
  rehearsalMode?: boolean;
  rehearsalSleep?: (milliseconds: number) => Promise<void>;
}

export async function startServer(options: ServerStartOptions = {}) {
  const port = options.port ?? Number(process.env.PORT ?? 3000);
  const hasTwitchConfiguration = Boolean(
    process.env.TWITCH_CLIENT_ID && process.env.TWITCH_CHANNEL,
  );
  const rehearsalOnly = options.rehearsalMode || !hasTwitchConfiguration;
  const runtime = new DibsRuntime({
    mode: rehearsalOnly ? "rehearsal" : "live",
  });
  if (!rehearsalOnly) await runtime.start();

  let rehearsalRunning = false;
  const launchRehearsal = () => {
    if (rehearsalRunning) return;
    rehearsalRunning = true;
    runtime.stop();
    void runRehearsal(
      runtime,
      options.rehearsalSleep ? { sleep: options.rehearsalSleep } : {},
    ).finally(() => {
      rehearsalRunning = false;
    });
  };
  const server = createDibsHttpServer(runtime, {
    onRehearsalStart: launchRehearsal,
  });
  await new Promise<void>((resolve) => server.listen(port, resolve));
  const address = server.address();
  const actualPort =
    address && typeof address !== "string" ? address.port : port;
  console.log(`Dibs dashboard is listening on http://localhost:${actualPort}`);
  if (rehearsalOnly) {
    console.log(
      "No Twitch credentials configured. Starting a clearly labeled rehearsal drop.",
    );
    launchRehearsal();
  }
  return { server, runtime, port: actualPort };
}

if (process.argv[1]?.endsWith("/server.ts")) {
  startServer().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
