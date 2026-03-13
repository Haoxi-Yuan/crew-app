import express from "express";
import { createServer } from "node:http";
import fs from "node:fs";
import path from "node:path";
import { PORT, DATA_DIR, SHARED_DIR, WEB_UI_DIR, HEARTBEAT_TIMEOUT_MS, HEARTBEAT_CHECK_INTERVAL_MS } from "./config.js";
import { getDb } from "./db/index.js";
import apiRouter from "./api/router.js";
import { initWebSocket, broadcast } from "./ws/handler.js";
import { startTmuxMonitor } from "./tmux-monitor.js";
import { processExpiredPeaks } from "./api/peaks.js";

fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(SHARED_DIR, { recursive: true });

// Initialize DB eagerly
getDb();

const app = express();
app.use(express.json({ limit: "2mb" }));
app.use("/api", apiRouter);

// Serve web UI static files
const uiDistDir = path.join(WEB_UI_DIR, "dist");
const uiIndexHtml = path.join(WEB_UI_DIR, "index.html");
if (fs.existsSync(uiDistDir)) {
  app.use("/dist", express.static(uiDistDir));
}
if (fs.existsSync(path.join(WEB_UI_DIR, "styles.css"))) {
  app.use("/styles.css", express.static(path.join(WEB_UI_DIR, "styles.css")));
}
app.get("/", (_req, res) => {
  if (fs.existsSync(uiIndexHtml)) {
    res.sendFile(uiIndexHtml);
  } else {
    res.json({ message: "Claude Crew server running. Web UI not built yet." });
  }
});

const httpServer = createServer(app);
initWebSocket(httpServer);

// Heartbeat cleanup: mark stale agents offline
setInterval(() => {
  const db = getDb();
  const threshold = Date.now() - HEARTBEAT_TIMEOUT_MS;
  const stale = db
    .prepare("SELECT name FROM agents WHERE status = 'online' AND last_heartbeat < ?")
    .all(threshold) as { name: string }[];

  if (stale.length > 0) {
    const stmt = db.prepare("UPDATE agents SET status = 'offline' WHERE name = ?");
    for (const agent of stale) {
      stmt.run(agent.name);
      broadcast({ type: "agent:status", data: { name: agent.name, status: "offline" } });
      console.error(`[heartbeat] agent "${agent.name}" marked offline (timeout)`);
    }
  }
}, HEARTBEAT_CHECK_INTERVAL_MS);

// Peak timeout monitor: auto-decide expired peaks every 30s
setInterval(() => {
  try {
    const result = processExpiredPeaks();
    if (result.expired > 0) {
      console.error(`[peak-monitor] auto-decided ${result.expired} expired peak(s)`);
    }
  } catch (err) {
    console.error(`[peak-monitor] error: ${(err as Error).message}`);
  }
}, 30_000);

httpServer.listen(PORT, "127.0.0.1", () => {
  console.error(`[claude-crew] server running on http://127.0.0.1:${PORT}`);
  startTmuxMonitor();
});
