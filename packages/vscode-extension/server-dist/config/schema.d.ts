import { z } from "zod";
export declare const CrewConfigSchema: z.ZodObject<{
    server: z.ZodObject<{
        port: z.ZodNumber;
        host: z.ZodString;
        projectRoot: z.ZodString;
        dataDir: z.ZodString;
        dbPath: z.ZodString;
        sharedDir: z.ZodString;
        worklogDir: z.ZodString;
        webUiDir: z.ZodString;
        logLevel: z.ZodEnum<["debug", "info", "warn", "error"]>;
    }, "strip", z.ZodTypeAny, {
        port: number;
        host: string;
        projectRoot: string;
        dataDir: string;
        dbPath: string;
        sharedDir: string;
        worklogDir: string;
        webUiDir: string;
        logLevel: "debug" | "info" | "warn" | "error";
    }, {
        port: number;
        host: string;
        projectRoot: string;
        dataDir: string;
        dbPath: string;
        sharedDir: string;
        worklogDir: string;
        webUiDir: string;
        logLevel: "debug" | "info" | "warn" | "error";
    }>;
    agent: z.ZodObject<{
        heartbeatTimeoutMs: z.ZodNumber;
        heartbeatCheckIntervalMs: z.ZodNumber;
        autoCycleContextPercent: z.ZodNumber;
        autoCycleCooldownMs: z.ZodNumber;
    }, "strip", z.ZodTypeAny, {
        heartbeatTimeoutMs: number;
        heartbeatCheckIntervalMs: number;
        autoCycleContextPercent: number;
        autoCycleCooldownMs: number;
    }, {
        heartbeatTimeoutMs: number;
        heartbeatCheckIntervalMs: number;
        autoCycleContextPercent: number;
        autoCycleCooldownMs: number;
    }>;
    ollama: z.ZodObject<{
        baseUrl: z.ZodString;
        model: z.ZodString;
        bin: z.ZodString;
        modelsDir: z.ZodString;
    }, "strip", z.ZodTypeAny, {
        baseUrl: string;
        model: string;
        bin: string;
        modelsDir: string;
    }, {
        baseUrl: string;
        model: string;
        bin: string;
        modelsDir: string;
    }>;
    peak: z.ZodObject<{
        checkIntervalMs: z.ZodNumber;
    }, "strip", z.ZodTypeAny, {
        checkIntervalMs: number;
    }, {
        checkIntervalMs: number;
    }>;
    terminal: z.ZodObject<{
        monitorIntervalMs: z.ZodNumber;
        captureLines: z.ZodNumber;
    }, "strip", z.ZodTypeAny, {
        monitorIntervalMs: number;
        captureLines: number;
    }, {
        monitorIntervalMs: number;
        captureLines: number;
    }>;
    standards: z.ZodObject<{
        maxBudgetChars: z.ZodNumber;
        autoApplyConfidenceThreshold: z.ZodNumber;
        consensusMinAgents: z.ZodNumber;
    }, "strip", z.ZodTypeAny, {
        maxBudgetChars: number;
        autoApplyConfidenceThreshold: number;
        consensusMinAgents: number;
    }, {
        maxBudgetChars: number;
        autoApplyConfidenceThreshold: number;
        consensusMinAgents: number;
    }>;
    memory: z.ZodObject<{
        maxStabilityDays: z.ZodNumber;
        maxTimestamps: z.ZodNumber;
        archiveThreshold: z.ZodNumber;
        dailyArchiveAgeDays: z.ZodNumber;
        promotionMinAccesses: z.ZodNumber;
    }, "strip", z.ZodTypeAny, {
        maxStabilityDays: number;
        maxTimestamps: number;
        archiveThreshold: number;
        dailyArchiveAgeDays: number;
        promotionMinAccesses: number;
    }, {
        maxStabilityDays: number;
        maxTimestamps: number;
        archiveThreshold: number;
        dailyArchiveAgeDays: number;
        promotionMinAccesses: number;
    }>;
}, "strip", z.ZodTypeAny, {
    server: {
        port: number;
        host: string;
        projectRoot: string;
        dataDir: string;
        dbPath: string;
        sharedDir: string;
        worklogDir: string;
        webUiDir: string;
        logLevel: "debug" | "info" | "warn" | "error";
    };
    agent: {
        heartbeatTimeoutMs: number;
        heartbeatCheckIntervalMs: number;
        autoCycleContextPercent: number;
        autoCycleCooldownMs: number;
    };
    ollama: {
        baseUrl: string;
        model: string;
        bin: string;
        modelsDir: string;
    };
    peak: {
        checkIntervalMs: number;
    };
    terminal: {
        monitorIntervalMs: number;
        captureLines: number;
    };
    standards: {
        maxBudgetChars: number;
        autoApplyConfidenceThreshold: number;
        consensusMinAgents: number;
    };
    memory: {
        maxStabilityDays: number;
        maxTimestamps: number;
        archiveThreshold: number;
        dailyArchiveAgeDays: number;
        promotionMinAccesses: number;
    };
}, {
    server: {
        port: number;
        host: string;
        projectRoot: string;
        dataDir: string;
        dbPath: string;
        sharedDir: string;
        worklogDir: string;
        webUiDir: string;
        logLevel: "debug" | "info" | "warn" | "error";
    };
    agent: {
        heartbeatTimeoutMs: number;
        heartbeatCheckIntervalMs: number;
        autoCycleContextPercent: number;
        autoCycleCooldownMs: number;
    };
    ollama: {
        baseUrl: string;
        model: string;
        bin: string;
        modelsDir: string;
    };
    peak: {
        checkIntervalMs: number;
    };
    terminal: {
        monitorIntervalMs: number;
        captureLines: number;
    };
    standards: {
        maxBudgetChars: number;
        autoApplyConfidenceThreshold: number;
        consensusMinAgents: number;
    };
    memory: {
        maxStabilityDays: number;
        maxTimestamps: number;
        archiveThreshold: number;
        dailyArchiveAgeDays: number;
        promotionMinAccesses: number;
    };
}>;
export type CrewConfig = z.infer<typeof CrewConfigSchema>;
