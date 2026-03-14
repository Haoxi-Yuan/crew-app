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

export function expandMentions(mentions: string[], channelId?: string): string[] {
  const db = getDb();

  // Resolve @project: expand to agents assigned to the channel's project
  if (mentions.includes("project") && channelId) {
    const channel = db.prepare("SELECT project_id FROM channels WHERE id = ?").get(channelId) as { project_id: string | null } | undefined;
    if (channel?.project_id) {
      const projectAgents = db
        .prepare("SELECT agent_name FROM project_agents WHERE project_id = ? AND status = 'active'")
        .all(channel.project_id) as { agent_name: string }[];
      const projectNames = projectAgents.map((a) => a.agent_name);
      // Merge with any other explicit mentions (excluding "project" keyword)
      const others = mentions.filter((m) => m !== "all" && m !== "project");
      return [...new Set([...projectNames, ...others])];
    }
  }

  // Resolve @all: expand to all non-offline agents globally
  if (mentions.includes("all")) {
    const agents = db
      .prepare("SELECT name FROM agents WHERE status != 'offline'")
      .all() as Pick<AgentRow, "name">[];
    return agents.map((a) => a.name);
  }

  return mentions;
}

export function createPendingMentions(
  messageId: number,
  agentNames: string[]
): void {
  const db = getDb();
  const now = Date.now();
  const stmt = db.prepare(
    "INSERT INTO pending_mentions (message_id, agent_name, created_at) VALUES (?, ?, ?)"
  );

  const insertMany = db.transaction((names: string[]) => {
    for (const name of names) {
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
