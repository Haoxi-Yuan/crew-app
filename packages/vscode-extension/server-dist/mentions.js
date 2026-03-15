import { getDb } from "./db/index.js";
import { broadcast } from "./ws/handler.js";
export function parseMentions(content) {
    const mentionRegex = /@([\w][\w-]*)/g;
    const mentions = [];
    let match;
    while ((match = mentionRegex.exec(content)) !== null) {
        mentions.push(match[1]);
    }
    return [...new Set(mentions)];
}
export function getChannelProjectId(channelId) {
    if (!channelId)
        return null;
    const db = getDb();
    const channel = db
        .prepare("SELECT project_id FROM channels WHERE id = ?")
        .get(channelId);
    return channel?.project_id || null;
}
export function getActiveProjectAgentNames(projectId) {
    const db = getDb();
    const projectAgents = db
        .prepare("SELECT agent_name FROM project_agents WHERE project_id = ? AND status = 'active'")
        .all(projectId);
    return projectAgents.map((a) => a.agent_name);
}
function getExistingAgentNames(names) {
    if (names.length === 0)
        return [];
    const db = getDb();
    const exists = db.prepare("SELECT 1 FROM agents WHERE name = ?");
    return names.filter((name) => Boolean(exists.get(name)));
}
export function expandMentions(mentions, channelId) {
    const projectId = getChannelProjectId(channelId);
    const explicitNames = mentions.filter((m) => m !== "all" && m !== "project");
    if (projectId) {
        const projectNames = getActiveProjectAgentNames(projectId);
        const validExplicit = explicitNames.filter((name) => projectNames.includes(name));
        if (mentions.includes("project") || mentions.includes("all")) {
            return [...new Set([...projectNames, ...validExplicit])];
        }
        return validExplicit;
    }
    if (mentions.includes("all")) {
        const db = getDb();
        const agents = db
            .prepare("SELECT name FROM agents WHERE status != 'offline'")
            .all();
        return agents.map((a) => a.name);
    }
    return getExistingAgentNames(explicitNames);
}
export function createPendingMentions(messageId, agentNames, channelId) {
    const db = getDb();
    const now = Date.now();
    const projectId = getChannelProjectId(channelId);
    const allowedNames = projectId ? new Set(getActiveProjectAgentNames(projectId)) : null;
    const stmt = db.prepare("INSERT INTO pending_mentions (message_id, agent_name, created_at) VALUES (?, ?, ?)");
    const inserted = [];
    const insertMany = db.transaction((names) => {
        for (const name of names) {
            if (allowedNames && !allowedNames.has(name)) {
                continue;
            }
            const agentExists = db
                .prepare("SELECT 1 FROM agents WHERE name = ?")
                .get(name);
            if (agentExists) {
                stmt.run(messageId, name, now);
                inserted.push(name);
            }
        }
    });
    insertMany(agentNames);
    for (const name of inserted) {
        broadcast({
            type: "mention:pending",
            data: { agentName: name, messageId, channelId },
        });
    }
}
//# sourceMappingURL=mentions.js.map