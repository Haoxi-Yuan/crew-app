import path from "node:path";
export function getDefaults(projectRoot) {
    const dataDir = path.join(projectRoot, "data");
    return {
        server: {
            port: 3140,
            host: "127.0.0.1",
            projectRoot,
            dataDir,
            dbPath: path.join(dataDir, "claude-crew.db"),
            sharedDir: path.join(dataDir, "shared"),
            worklogDir: path.join(dataDir, "agent_state"),
            webUiDir: path.join(projectRoot, "packages/web-ui"),
            logLevel: "info",
        },
        agent: {
            heartbeatTimeoutMs: 60_000,
            heartbeatCheckIntervalMs: 15_000,
            autoCycleContextPercent: 80,
            autoCycleCooldownMs: 5 * 60 * 1000,
        },
        ollama: {
            baseUrl: "http://127.0.0.1:11434",
            model: "nomic-embed-text",
            bin: path.join(projectRoot, "bin", "ollama"),
            modelsDir: path.join(dataDir, "ollama-models"),
        },
        peak: {
            checkIntervalMs: 30_000,
        },
        terminal: {
            monitorIntervalMs: 2_000,
            captureLines: 80,
        },
        standards: {
            maxBudgetChars: 4_000,
            autoApplyConfidenceThreshold: 0.8,
            consensusMinAgents: 2,
        },
        memory: {
            maxStabilityDays: 365,
            maxTimestamps: 20,
            archiveThreshold: 0.05,
            dailyArchiveAgeDays: 90,
            promotionMinAccesses: 3,
        },
    };
}
//# sourceMappingURL=defaults.js.map