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

export function expandMentions(mentions: string[]): string[] {
  if (mentions.includes("all")) {
    const db = getDb();
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
