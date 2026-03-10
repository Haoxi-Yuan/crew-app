import { Router, type Request, type Response } from "express";
import type { Router as RouterType } from "express";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { getDb } from "../db/index.js";
import { broadcast } from "../ws/handler.js";

const router: RouterType = Router();

const CLAUDE_DIR = path.join(os.homedir(), ".claude");
const PROJECTS_DIR = path.join(CLAUDE_DIR, "projects");

interface SessionInfo {
  sessionId: string;
  project: string;
  messageCount: number;
  userMessages: number;
  assistantMessages: number;
  firstTimestamp: number;
  lastTimestamp: number;
  preview: string;
  filePath: string;
}

function findSessionFiles(): SessionInfo[] {
  const sessions: SessionInfo[] = [];

  if (!fs.existsSync(PROJECTS_DIR)) return sessions;

  const projectDirs = fs.readdirSync(PROJECTS_DIR);
  for (const projDir of projectDirs) {
    const projPath = path.join(PROJECTS_DIR, projDir);
    if (!fs.statSync(projPath).isDirectory()) continue;

    const files = fs.readdirSync(projPath).filter(
      (f) => f.endsWith(".jsonl") && !f.includes("subagent")
    );

    for (const file of files) {
      const filePath = path.join(projPath, file);
      const sessionId = file.replace(".jsonl", "");

      try {
        const content = fs.readFileSync(filePath, "utf-8");
        const lines = content.split("\n").filter((l) => l.trim());

        let userCount = 0;
        let assistantCount = 0;
        let firstTs = Infinity;
        let lastTs = 0;
        let preview = "";

        for (const line of lines) {
          const rec = JSON.parse(line);
          const t = rec.type;
          const ts = rec.message?.timestamp || rec.timestamp || 0;

          if (ts > 0 && ts < firstTs) firstTs = ts;
          if (ts > lastTs) lastTs = ts;

          if (t === "user") {
            userCount++;
            if (!preview) {
              const text = extractText(rec);
              if (text && !text.startsWith("<")) {
                preview = text.slice(0, 100);
              }
            }
          } else if (t === "assistant") {
            assistantCount++;
          }
        }

        if (userCount + assistantCount < 2) continue;

        sessions.push({
          sessionId,
          project: projDir.replace(/-/g, "/"),
          messageCount: userCount + assistantCount,
          userMessages: userCount,
          assistantMessages: assistantCount,
          firstTimestamp: firstTs === Infinity ? 0 : firstTs,
          lastTimestamp: lastTs,
          preview: preview || "(no preview)",
          filePath,
        });
      } catch {
        // Skip malformed files
      }
    }
  }

  sessions.sort((a, b) => b.lastTimestamp - a.lastTimestamp);
  return sessions;
}

function extractText(rec: Record<string, unknown>): string {
  const msg = rec.message as Record<string, unknown> | undefined;
  const content = msg?.content || rec.content;

  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const texts: string[] = [];
    for (const item of content) {
      if (typeof item === "object" && item !== null && (item as Record<string, unknown>).type === "text") {
        texts.push((item as Record<string, string>).text);
      }
    }
    return texts.join("\n");
  }
  return "";
}

// GET /api/import/sessions - List available sessions to import
router.get("/sessions", (_req: Request, res: Response) => {
  const sessions = findSessionFiles();
  res.json(sessions);
});

// POST /api/import/session - Import a specific session into group chat
router.post("/session", (req: Request, res: Response) => {
  const { sessionId, label } = req.body as {
    sessionId?: string;
    label?: string;
  };

  if (!sessionId) {
    res.status(400).json({ error: "sessionId is required" });
    return;
  }

  const sessions = findSessionFiles();
  const session = sessions.find((s) => s.sessionId === sessionId);
  if (!session) {
    res.status(404).json({ error: "session not found" });
    return;
  }

  const content = fs.readFileSync(session.filePath, "utf-8");
  const lines = content.split("\n").filter((l) => l.trim());

  const db = getDb();
  const now = Date.now();
  let imported = 0;

  // Insert a system message marking the import
  const senderLabel = label || `session-${sessionId.slice(0, 8)}`;
  db.prepare(
    "INSERT INTO messages (sender_type, sender_name, content, mentions, message_type, created_at) VALUES (?, ?, ?, ?, ?, ?)"
  ).run(
    "system",
    "system",
    `--- Imported conversation from ${session.project} (${session.userMessages} user + ${session.assistantMessages} assistant messages) ---`,
    "[]",
    "system",
    now
  );

  const insertStmt = db.prepare(
    "INSERT INTO messages (sender_type, sender_name, content, mentions, message_type, created_at) VALUES (?, ?, ?, ?, ?, ?)"
  );

  const importAll = db.transaction(() => {
    for (const line of lines) {
      let rec: Record<string, unknown>;
      try {
        rec = JSON.parse(line);
      } catch {
        continue;
      }

      const t = rec.type as string;
      if (t !== "user" && t !== "assistant") continue;

      const text = extractText(rec);
      if (!text || text.length < 2) continue;
      // Skip system/command messages
      if (text.startsWith("<local-command") || text.startsWith("<command-name>")) continue;

      const msg = rec.message as Record<string, unknown> | undefined;
      const ts = (msg?.timestamp as number) || (rec.timestamp as number) || now;

      const senderType = t === "user" ? "user" : "agent";
      const senderName = t === "user" ? "user" : senderLabel;

      insertStmt.run(senderType, senderName, text, "[]", "chat", ts);
      imported++;
    }
  });

  importAll();

  broadcast({
    type: "message:new",
    data: {
      id: 0,
      sender_type: "system",
      sender_name: "system",
      content: `Imported ${imported} messages from previous conversation.`,
      mentions: [],
      message_type: "system",
      created_at: now,
    },
  });

  res.json({ success: true, imported, sessionId });
});

export default router;
