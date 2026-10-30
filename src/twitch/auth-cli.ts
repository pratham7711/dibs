import "dotenv/config";
import { runAuthCommand } from "./auth.js";

runAuthCommand().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
