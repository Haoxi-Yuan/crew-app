import { getDb, type AgentRow } from "./db/index.js";

export function parseMentions(content: string): string[] {
  const mentionRegex = /@([\w][\w-]*)/g;
  const mentions: string[] = [];
  let match: RegExpExecArray | null;

  while ((match = mentionRegex.exec(content)) !== null) {
    mentions.push(match[1]);
  }

  return [...new Set(mentions)];
}

export function getChannelProjectId(channelId?: string): string | null {
  if (!channelId) return null;
  const db = getDb();
  const channel = db
    .prepare("SELECT project_id FROM channels WHERE id = ?")
    .get(channelId) as { project_id: string | null } | undefined;
  return channel?.project_id || null;
}

export function getActiveProjectAgentNames(projectId: string): string[] {
  const db = getDb();
  const projectAgents = db
    .prepare("SELECT agent_name FROM project_agents WHERE project_id = ? AND status = 'active'")
    .all(projectId) as { agent_name: string }[];
  return projectAgents.map((a) => a.agent_name);
}

function getExistingAgentNames(names: string[]): string[] {
  if (names.length === 0) return [];
  const db = getDb();
  const exists = db.prepare("SELECT 1 FROM agents WHERE name = ?");
  return names.filter((name) => Boolean(exists.get(name)));
}

export function expandMentions(mentions: string[], channelId?: string): string[] {
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
      .all() as Pick<AgentRow, "name">[];
    return agents.map((a) => a.name);
  }

  return getExistingAgentNames(explicitNames);
}

export function createPendingMentions(
  messageId: number,
  agentNames: string[],
  channelId?: string
): void {
  const db = getDb();
  const now = Date.now();
  const projectId = getChannelProjectId(channelId);
  const allowedNames = projectId ? new Set(getActiveProjectAgentNames(projectId)) : null;
  const stmt = db.prepare(
    "INSERT INTO pending_mentions (message_id, agent_name, created_at) VALUES (?, ?, ?)"
  );

  const insertMany = db.transaction((names: string[]) => {
    for (const name of names) {
      if (allowedNames && !allowedNames.has(name)) {
        continue;
      }
      const agentExists = db
        .prepare("SELECT 1 FROM agents WHERE name = ?")
        .get(name);
      if (agentExists) {
        stmt.run(messageId, name, now);
      }
    }
  });

  insertMany(agentNames);
}
