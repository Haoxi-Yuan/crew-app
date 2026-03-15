/**
 * CLI entry point.
 * Delegates to the programmatic startServer() API.
 */
import { startServer } from "./start.js";

startServer({
  onError: (err) => {
    console.error(`[claude-crew] fatal: ${err.message}`);
    process.exit(1);
  },
});
