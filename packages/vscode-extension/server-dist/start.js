import express from "express";
import { createServer } from "node:http";
import fs from "node:fs";
import path from "node:path";
import { initConfig, isConfigInitialized, getConfig } from "./config/index.js";
export async function startServer(options = {}) {
    // Initialize config FIRST, before any config-dependent module is loaded
    if (!isConfigInitialized()) {
        initConfig(options.configOverrides);
    }
    const cfg = getConfig();
    // Ensure data directories exist
    fs.mkdirSync(cfg.server.dataDir, { recursive: true });
    fs.mkdirSync(cfg.server.sharedDir, { recursive: true });
    fs.mkdirSync(cfg.server.worklogDir, { recursive: true });
    // Dynamically import config-dependent modules AFTER config is initialized
    const [{ default: apiRouter }, { initWebSocket, broadcast }, { startTmuxMonitor, stopTmuxMonitor }, { processExpiredPeaks }, { getDb }, { registerProvider }, { claudeProvider }, { codexProvider },] = await Promise.all([
        import("./api/router.js"),
        import("./ws/handler.js"),
        import("./tmux-monitor.js"),
        import("./api/peaks.js"),
        import("./db/index.js"),
        import("./providers/runtime.js"),
        import("./providers/claude.js"),
        import("./providers/codex.js"),
    ]);
    // Register runtime providers
    registerProvider(claudeProvider);
    registerProvider(codexProvider);
    // Initialize DB eagerly
    getDb();
    const app = express();
    app.use(express.json({ limit: "2mb" }));
    app.use("/api", apiRouter);
    // Serve web UI static files
    const uiDistDir = path.join(cfg.server.webUiDir, "dist");
    const uiIndexHtml = path.join(cfg.server.webUiDir, "index.html");
    if (fs.existsSync(uiDistDir)) {
        app.use("/dist", express.static(uiDistDir));
    }
    if (fs.existsSync(path.join(cfg.server.webUiDir, "styles.css"))) {
        app.use("/styles.css", express.static(path.join(cfg.server.webUiDir, "styles.css")));
    }
    app.get("/", (_req, res) => {
        if (fs.existsSync(uiIndexHtml)) {
            res.sendFile(uiIndexHtml);
        }
        else {
            res.json({ message: "Claude Crew server running. Web UI not built yet." });
        }
    });
    const httpServer = createServer(app);
    initWebSocket(httpServer);
    // Heartbeat cleanup: mark stale agents offline
    const heartbeatTimer = setInterval(() => {
        const db = getDb();
        const threshold = Date.now() - cfg.agent.heartbeatTimeoutMs;
        const stale = db
            .prepare("SELECT name FROM agents WHERE status = 'online' AND last_heartbeat < ?")
            .all(threshold);
        if (stale.length > 0) {
            const stmt = db.prepare("UPDATE agents SET status = 'offline' WHERE name = ?");
            for (const agent of stale) {
                stmt.run(agent.name);
                broadcast({
                    type: "agent:status",
                    data: { name: agent.name, status: "offline" },
                });
                console.error(`[heartbeat] agent "${agent.name}" marked offline (timeout)`);
            }
        }
    }, cfg.agent.heartbeatCheckIntervalMs);
    // Peak timeout monitor
    const peakTimer = setInterval(() => {
        try {
            const result = processExpiredPeaks();
            if (result.expired > 0) {
                console.error(`[peak-monitor] auto-decided ${result.expired} expired peak(s)`);
            }
        }
        catch (err) {
            console.error(`[peak-monitor] error: ${err.message}`);
        }
    }, cfg.peak.checkIntervalMs);
    // Handle abort signal
    if (options.signal) {
        options.signal.addEventListener("abort", () => {
            cleanup(httpServer, [heartbeatTimer, peakTimer], stopTmuxMonitor);
        });
    }
    // Start listening
    return new Promise((resolve, reject) => {
        httpServer.on("error", (err) => {
            if (options.onError)
                options.onError(err);
            reject(err);
        });
        httpServer.listen(cfg.server.port, cfg.server.host, () => {
            const addr = httpServer.address();
            const actualPort = typeof addr === "object" && addr ? addr.port : cfg.server.port;
            console.error(`[claude-crew] server running on http://${cfg.server.host}:${actualPort}`);
            // Report actual port via stdout (for extension IPC)
            process.stdout.write(JSON.stringify({ event: "ready", port: actualPort }) + "\n");
            startTmuxMonitor();
            if (options.onReady)
                options.onReady({ port: actualPort });
            resolve({
                close: () => cleanup(httpServer, [heartbeatTimer, peakTimer], stopTmuxMonitor),
            });
        });
    });
}
async function cleanup(server, timers, stopTmuxMonitor) {
    for (const t of timers)
        clearInterval(t);
    stopTmuxMonitor();
    return new Promise((resolve) => {
        server.close(() => resolve());
    });
}
//# sourceMappingURL=start.js.map