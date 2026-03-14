import { Router, type Request, type Response } from "express";
import type { Router as RouterType } from "express";
import { getDb, type MessageRow } from "../db/index.js";
import { parseMentions, expandMentions, createPendingMentions } from "../mentions.js";
import { broadcast } from "../ws/handler.js";
import { forwardToMentionedAgents } from "../forward.js";

const router: RouterType = Router();

router.post("/", (req: Request, res: Response) => {
  const { sender_type, sender_name, content, message_type, channel_id } = req.body as {
    sender_type?: string;
    sender_name?: string;
    content?: string;
    message_type?: string;
    channel_id?: string;
  };

  if (!sender_type || !sender_name || !content) {
    res.status(400).json({ error: "sender_type, sender_name, content are required" });
    return;
  }

  const db = getDb();
  const now = Date.now();
  const cid = channel_id || "general";

  // Parse explicit @mentions from content
  const rawMentions = parseMentions(content);
  const expandedMentions = expandMentions(rawMentions, cid);
  const mentionsJson = JSON.stringify(expandedMentions);

  // Check channel type for auto-forwarding (DM/group)
  const channel = db.prepare("SELECT type, members FROM channels WHERE id = ?")
    .get(cid) as { type: string; members: string | null } | undefined;

  // Determine all forward targets: channel members + explicit @mentions, minus sender
  let allTargets: string[];
  if (channel && (channel.type === "dm" || channel.type === "group") && channel.members) {
    const memberList: string[] = JSON.parse(channel.members);
    const targetSet = new Set([...memberList, ...expandedMentions]);
    allTargets = [...targetSet].filter((n) => n !== sender_name);
  } else {
    // Public channels: only forward to explicitly @mentioned agents
    allTargets = expandedMentions.filter((n) => n !== sender_name);
  }

  const result = db.prepare(
    "INSERT INTO messages (channel_id, sender_type, sender_name, content, mentions, message_type, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
  ).run(cid, sender_type, sender_name, content, mentionsJson, message_type || "chat", now);

  const messageId = result.lastInsertRowid as number;

  // Create pending mentions for delivery tracking
  if (allTargets.length > 0) {
    createPendingMentions(messageId, allTargets);
  }

  const message = {
    id: messageId,
    channel_id: cid,
    sender_type,
    sender_name,
    content,
    mentions: expandedMentions,
    message_type: message_type || "chat",
    created_at: now,
  };

  broadcast({ type: "message:new", data: message });

  // Forward to agents' tmux sessions (fire-and-forget)
  if (allTargets.length > 0) {
    forwardToMentionedAgents(allTargets, sender_name, content, messageId, cid, channel?.type).catch(() => {});
  }

  res.json(message);
});

router.get("/", (req: Request, res: Response) => {
  const limit = Math.min(parseInt(req.query.limit as string) || 50, 200);
  const beforeId = parseInt(req.query.before_id as string) || 0;
  const afterId = parseInt(req.query.after_id as string) || 0;
  const channelId = (req.query.channel_id as string) || "general";

  const db = getDb();
  let messages: MessageRow[];

  if (afterId > 0) {
    messages = db
      .prepare(
        "SELECT * FROM messages WHERE channel_id = ? AND id > ? ORDER BY id ASC LIMIT ?"
      )
      .all(channelId, afterId, limit) as MessageRow[];
  } else if (beforeId > 0) {
    messages = db
      .prepare(
        "SELECT * FROM messages WHERE channel_id = ? AND id < ? ORDER BY id DESC LIMIT ?"
      )
      .all(channelId, beforeId, limit) as MessageRow[];
  } else {
    messages = db
      .prepare("SELECT * FROM messages WHERE channel_id = ? ORDER BY id DESC LIMIT ?")
      .all(channelId, limit) as MessageRow[];
  }

  // after_id query already returns ASC (chronological); others are DESC and need reversal
  if (!afterId) {
    messages.reverse();
  }

  // Attach delivery status for messages with mentions
  const parsed = messages.map((m) => {
    const mentions = JSON.parse(m.mentions) as string[];
    let deliveryStatus: Record<string, string> | undefined;

    if (mentions.length > 0) {
      try {
        const statuses = db
          .prepare(
            "SELECT agent_name, delivery_status FROM pending_mentions WHERE message_id = ?"
          )
          .all(m.id) as { agent_name: string; delivery_status: string }[];

        if (statuses.length > 0) {
          deliveryStatus = {};
          for (const s of statuses) {
            deliveryStatus[s.agent_name] = s.delivery_status || "sent";
          }
        }
      } catch {
        // delivery_status column might not exist yet
      }
    }

    return {
      ...m,
      mentions,
      delivery_status: deliveryStatus,
    };
  });

  res.json(parsed);
});

// GET /messages/search - keyword search through chat history
router.get("/search", (req: Request, res: Response) => {
  const query = (req.query.query as string) || "";
  const channelId = req.query.channel_id as string | undefined;
  const limit = Math.min(parseInt(req.query.limit as string) || 20, 100);

  if (!query) {
    res.status(400).json({ error: "query parameter is required" });
    return;
  }

  const db = getDb();
  const pattern = `%${query}%`;

  let messages: MessageRow[];
  if (channelId) {
    messages = db
      .prepare(
        "SELECT * FROM messages WHERE channel_id = ? AND content LIKE ? ORDER BY id DESC LIMIT ?"
      )
      .all(channelId, pattern, limit) as MessageRow[];
  } else {
    messages = db
      .prepare(
        "SELECT * FROM messages WHERE content LIKE ? ORDER BY id DESC LIMIT ?"
      )
      .all(pattern, limit) as MessageRow[];
  }

  messages.reverse();

  const parsed = messages.map((m) => ({
    id: m.id,
    channel_id: m.channel_id,
    sender_name: m.sender_name,
    content: m.content,
    created_at: m.created_at,
  }));

  res.json(parsed);
});

export default router;
