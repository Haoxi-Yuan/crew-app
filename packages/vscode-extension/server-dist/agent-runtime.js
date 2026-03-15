import { getDb } from "./db/index.js";
export const DEFAULT_PROVIDER = "claude";
function parseMetadata(agentName) {
    const db = getDb();
    const row = db.prepare("SELECT metadata FROM agents WHERE name = ?").get(agentName);
    if (!row?.metadata) {
        return {};
    }
    try {
        return JSON.parse(row.metadata);
    }
    catch {
        return {};
    }
}
export function getProvider(agentName) {
    const db = getDb();
    const row = db.prepare("SELECT provider FROM agents WHERE name = ?").get(agentName);
    return row?.provider === "codex" ? "codex" : "claude";
}
export function getAgentRuntimeConfig(agentName) {
    const meta = parseMetadata(agentName);
    const provider = getProvider(agentName);
    return {
        provider,
        model: typeof meta.model === "string" ? meta.model : undefined,
        effort: typeof meta.effort === "string" ? meta.effort : undefined,
        approvalPolicy: typeof meta.approvalPolicy === "string" ? meta.approvalPolicy : undefined,
        sandboxMode: typeof meta.sandboxMode === "string" ? meta.sandboxMode : undefined,
        threadId: typeof meta.threadId === "string" ? meta.threadId : undefined,
        serviceName: typeof meta.serviceName === "string" ? meta.serviceName : undefined,
        claudeSessionId: typeof meta.claudeSessionId === "string" ? meta.claudeSessionId : undefined,
        claudeBridgeFingerprint: typeof meta.claudeBridgeFingerprint === "string" ? meta.claudeBridgeFingerprint : undefined,
        claudeSettingsPath: typeof meta.claudeSettingsPath === "string" ? meta.claudeSettingsPath : undefined,
    };
}
export function mergeAgentMetadata(agentName, patch) {
    const db = getDb();
    const meta = parseMetadata(agentName);
    const next = { ...meta, ...patch };
    db.prepare("UPDATE agents SET metadata = ? WHERE name = ?").run(JSON.stringify(next), agentName);
    return next;
}
export function clearAgentMetadataKeys(agentName, keys) {
    const db = getDb();
    const meta = parseMetadata(agentName);
    for (const key of keys) {
        delete meta[key];
    }
    db.prepare("UPDATE agents SET metadata = ? WHERE name = ?").run(JSON.stringify(meta), agentName);
    return meta;
}
//# sourceMappingURL=agent-runtime.js.map