import "dotenv/config";
import { DibsRuntime, createDibsHttpServer } from "./runtime.js";

export async function startServer(port = Number(process.env.PORT ?? 3000)) {
  const runtime = new DibsRuntime();
  await runtime.start();
  const server = createDibsHttpServer(runtime);
  await new Promise<void>((resolve) => server.listen(port, resolve));
  console.log(`Dibs dashboard is listening on http://localhost:${port}`);
  return { server, runtime };
}

if (process.argv[1]?.endsWith("/server.ts")) {
  startServer().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
