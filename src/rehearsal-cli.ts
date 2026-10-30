import "dotenv/config";
import { startServer } from "./server.js";

startServer({ rehearsalMode: true, autoRunRehearsal: true }).catch(
  (error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  },
);
