import { z } from "zod";
export const CrewConfigSchema = z.object({
    server: z.object({
        port: z.number().int().min(0).max(65535),
        host: z.string(),
        projectRoot: z.string(),
        dataDir: z.string(),
        dbPath: z.string(),
        sharedDir: z.string(),
        worklogDir: z.string(),
        webUiDir: z.string(),
        logLevel: z.enum(["debug", "info", "warn", "error"]),
    }),
    agent: z.object({
        heartbeatTimeoutMs: z.number().int().positive(),
        heartbeatCheckIntervalMs: z.number().int().positive(),
        autoCycleContextPercent: z.number().int().min(0).max(100),
        autoCycleCooldownMs: z.number().int().positive(),
    }),
    ollama: z.object({
        baseUrl: z.string(),
        model: z.string(),
        bin: z.string(),
        modelsDir: z.string(),
    }),
    peak: z.object({
        checkIntervalMs: z.number().int().positive(),
    }),
    terminal: z.object({
        monitorIntervalMs: z.number().int().positive(),
        captureLines: z.number().int().positive(),
    }),
    standards: z.object({
        maxBudgetChars: z.number().int().positive(),
        autoApplyConfidenceThreshold: z.number().min(0).max(1),
        consensusMinAgents: z.number().int().positive(),
    }),
    memory: z.object({
        maxStabilityDays: z.number().int().positive(),
        maxTimestamps: z.number().int().positive(),
        archiveThreshold: z.number().min(0).max(1),
        dailyArchiveAgeDays: z.number().int().positive(),
        promotionMinAccesses: z.number().int().positive(),
    }),
});
//# sourceMappingURL=schema.js.map