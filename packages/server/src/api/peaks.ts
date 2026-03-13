import { Router, type Request, type Response } from "express";
import type { Router as RouterType } from "express";
import crypto from "node:crypto";
import { getDb, type PeakRow } from "../db/index.js";
import { forwardToMentionedAgents } from "../forward.js";
import { createPendingMentions } from "../mentions.js";
import { resolveScope } from "../storage-scope.js";
import { broadcast } from "../ws/handler.js";
import { extractPatternFromPeaks } from "../sop-engine.js";

const router: RouterType = Router();

function persistPeakDecisionMemory(
  row: PeakRow,
  chosenOption: { label: string; pros: string; cons: string },
  options: { label: string; pros: string; cons: string }[],
  chosenIndex: number,
  note: string | null,
  decidedBy: string,
  now: number,
): string {
  const db = getDb();
  const memId = crypto.randomUUID();
  const scope = resolveScope({ projectId: row.project_id, intent: "canonical" });
  const content = [
    `Peak type: ${row.peak_type}`,
    `Context: ${row.context}`,
    `Options: ${options.map((opt, idx) => `${idx === chosenIndex ? "[CHOSEN] " : ""}${opt.label}`).join(", ")}`,
    `Decision: ${chosenOption.label}`,
    `Decided by: ${decidedBy}`,
    note ? `Note: ${note}` : "",
    row.agent_lean ? `Agent lean was: ${row.agent_lean}` : "",
  ].filter(Boolean).join("\n");
  const contentHash = crypto.createHash("sha256").update(content).digest("hex").slice(0, 16);

  db.prepare(`
    INSERT INTO memory_entries (
      id, agent_name, category, source_file, heading, content, content_hash,
      importance, emotional_weight, created_at, last_accessed_at,
      access_count, access_timestamps, stability, difficulty,
      activation, retrievability, status, linked_ids, project_id, scope_type, scope_id
    ) VALUES (?, ?, 'decision', '', ?, ?, ?, 4, 1.5, ?, ?, 0, '[]', 1.0, 0.3, 0.0, 1.0, 'permanent', '[]', ?, ?, ?)
  `).run(
    memId,
    row.agent_name,
    `Peak decision: ${chosenOption.label}`,
    content,
    contentHash,
    now,
    now,
    scope.projectId,
    scope.scopeType,
    scope.scopeId,
  );

  return memId;
}

function buildSettlement(
  row: PeakRow,
  chosenOption: { label: string; pros: string; cons: string },
  optionIndex: number,
  note: string | null,
  decidedBy: string,
  memoryId?: string,
  channelId?: string,
  messageId?: number,
) {
  return {
    peak_id: row.id,
    agent_name: row.agent_name,
    project_id: row.project_id,
    peak_type: row.peak_type,
    context: row.context,
    chosen_option: chosenOption,
    chosen_index: optionIndex,
    note,
    decided_by: decidedBy,
    memory_id: memoryId,
    channel_id: channelId,
    message_id: messageId,
  };
}

function resolvePeakChannel(row: PeakRow): { id: string; type: string } {
  const db = getDb();
  if (row.project_id) {
    const assignment = db.prepare(`
      SELECT active_workplace_id
      FROM project_agents
      WHERE project_id = ? AND agent_name = ? AND status = 'active'
      ORDER BY assigned_at DESC
      LIMIT 1
    `).get(row.project_id, row.agent_name) as { active_workplace_id: string | null } | undefined;

    if (assignment?.active_workplace_id) {
      const workplaceChannel = db.prepare(
        "SELECT id, type FROM channels WHERE workplace_id = ? ORDER BY created_at ASC LIMIT 1"
      ).get(assignment.active_workplace_id) as { id: string; type: string } | undefined;
      if (workplaceChannel) return workplaceChannel;
    }

    const projectChannel = db.prepare(
      "SELECT id, type FROM channels WHERE project_id = ? AND workplace_id IS NULL ORDER BY created_at ASC LIMIT 1"
    ).get(row.project_id) as { id: string; type: string } | undefined;
    if (projectChannel) return projectChannel;
  }

  return { id: "general", type: "public" };
}

function queueSettlementMessage(
  row: PeakRow,
  chosenOption: { label: string; pros: string; cons: string },
  note: string | null,
  decidedBy: string,
  memoryId?: string,
): { channelId: string; messageId: number } {
  const db = getDb();
  const channel = resolvePeakChannel(row);
  const now = Date.now();
  const content = [
    `@${row.agent_name} peak resolved. Continue now using this decision.`,
    `Type: ${row.peak_type}`,
    `Decision: ${chosenOption.label}`,
    note ? `Note: ${note}` : "",
    `Decided by: ${decidedBy}`,
  ].filter(Boolean).join("\n");

  const result = db.prepare(`
    INSERT INTO messages (channel_id, sender_type, sender_name, content, mentions, message_type, created_at, metadata)
    VALUES (?, 'system', 'peak-system', ?, ?, 'peak_settlement', ?, ?)
  `).run(
    channel.id,
    content,
    JSON.stringify([row.agent_name]),
    now,
    JSON.stringify({ peak_id: row.id, memory_id: memoryId || null }),
  );

  const messageId = Number(result.lastInsertRowid);
  createPendingMentions(messageId, [row.agent_name]);
  broadcast({
    type: "message:new",
    data: {
      id: messageId,
      channel_id: channel.id,
      sender_type: "system",
      sender_name: "peak-system",
      content,
      mentions: [row.agent_name],
      message_type: "peak_settlement",
      created_at: now,
    },
  });
  forwardToMentionedAgents([row.agent_name], "peak-system", content, messageId, channel.id, channel.type).catch(() => {});

  return { channelId: channel.id, messageId };
}

// POST /peaks - Agent escalates a peak
router.post("/", (req: Request, res: Response) => {
  const {
    agent_name,
    project_id,
    peak_type,
    context,
    options = [],
    agent_lean,
    default_option = 0,
    timeout_seconds = 300,
  } = req.body as {
    agent_name?: string;
    project_id?: string;
    peak_type?: string;
    context?: string;
    options?: { label: string; pros: string; cons: string }[];
    agent_lean?: string;
    default_option?: number;
    timeout_seconds?: number;
  };

  if (!agent_name || !peak_type || !context) {
    res.status(400).json({ error: "agent_name, peak_type, and context are required" });
    return;
  }

  const validTypes = ["irreversibility", "multiple_paths", "info_asymmetry", "drift_check"];
  if (!validTypes.includes(peak_type)) {
    res.status(400).json({ error: `peak_type must be one of: ${validTypes.join(", ")}` });
    return;
  }

  if (options.length < 2 && peak_type !== "drift_check") {
    res.status(400).json({ error: "at least 2 options required (except for drift_check)" });
    return;
  }

  const db = getDb();
  const id = crypto.randomUUID();
  const now = Date.now();

  db.prepare(`
    INSERT INTO peaks (id, agent_name, project_id, peak_type, context, options, agent_lean, default_option, timeout_seconds, status, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)
  `).run(
    id, agent_name, project_id || null, peak_type,
    context, JSON.stringify(options), agent_lean || null,
    default_option, Math.min(Math.max(timeout_seconds, 30), 1800),
    now
  );

  const peak = {
    id,
    agent_name,
    project_id: project_id || null,
    peak_type,
    context,
    options,
    agent_lean: agent_lean || null,
    default_option,
    timeout_seconds,
    status: "pending",
    created_at: now,
    expires_at: now + timeout_seconds * 1000,
  };

  broadcast({ type: "peak:pending", data: peak });
  res.json(peak);
});

// GET /peaks - List peaks
router.get("/", (req: Request, res: Response) => {
  const { status, agent_name, project_id, limit = "20" } = req.query as {
    status?: string;
    agent_name?: string;
    project_id?: string;
    limit?: string;
  };

  const db = getDb();
  let sql = "SELECT * FROM peaks WHERE 1=1";
  const params: (string | number)[] = [];

  if (status) { sql += " AND status = ?"; params.push(status); }
  if (agent_name) { sql += " AND agent_name = ?"; params.push(agent_name); }
  if (project_id) { sql += " AND project_id = ?"; params.push(project_id); }

  sql += " ORDER BY created_at DESC LIMIT ?";
  params.push(Math.min(parseInt(limit) || 20, 100));

  const rows = db.prepare(sql).all(...params) as PeakRow[];
  res.json(rows.map(formatPeak));
});

// GET /peaks/pending - Get all pending peaks (for UI polling)
router.get("/pending", (_req: Request, res: Response) => {
  const db = getDb();
  const rows = db.prepare("SELECT * FROM peaks WHERE status = 'pending' ORDER BY created_at ASC").all() as PeakRow[];
  res.json(rows.map(formatPeak));
});

// GET /peaks/:id - Get a single peak
router.get("/:id", (req: Request, res: Response) => {
  const db = getDb();
  const row = db.prepare("SELECT * FROM peaks WHERE id = ?").get(req.params.id) as PeakRow | undefined;
  if (!row) { res.status(404).json({ error: "peak not found" }); return; }
  res.json(formatPeak(row));
});

// POST /peaks/:id/decide - Human decides on a peak (Settlement Phase)
router.post("/:id/decide", (req: Request, res: Response) => {
  const { option_index, note, decided_by } = req.body as {
    option_index?: number;
    note?: string;
    decided_by?: string;
  };

  if (option_index === undefined || option_index === null) {
    res.status(400).json({ error: "option_index is required" });
    return;
  }

  const db = getDb();
  const row = db.prepare("SELECT * FROM peaks WHERE id = ?").get(req.params.id) as PeakRow | undefined;
  if (!row) { res.status(404).json({ error: "peak not found" }); return; }
  if (row.status !== "pending") {
    res.status(400).json({ error: `peak already ${row.status}` });
    return;
  }

  const options = JSON.parse(row.options) as { label: string; pros: string; cons: string }[];
  if (option_index < 0 || option_index >= options.length) {
    res.status(400).json({ error: `option_index must be 0-${options.length - 1}` });
    return;
  }

  const now = Date.now();

  // Phase 3: Settlement
  // 1. Update peak status
  db.prepare(`
    UPDATE peaks SET status = 'decided', decision_index = ?, decision_note = ?, decided_by = ?, decided_at = ?
    WHERE id = ?
  `).run(option_index, note || null, decided_by || "user", now, row.id);

  const chosenOption = options[option_index];
  const decidedBy = decided_by || "user";
  const memId = persistPeakDecisionMemory(row, chosenOption, options, option_index, note || null, decidedBy, now);
  const delivery = queueSettlementMessage(row, chosenOption, note || null, decidedBy, memId);
  const settlement = buildSettlement(row, chosenOption, option_index, note || null, decidedBy, memId, delivery.channelId, delivery.messageId);
  broadcast({ type: "peak:decided", data: settlement });

  // 4. Trigger pattern extraction from accumulated decisions
  if (row.project_id) {
    try {
      extractPatternFromPeaks(row.project_id);
    } catch { /* non-critical */ }
  }

  res.json({ ok: true, settlement });
});

// POST /peaks/:id/let-agent-decide - Human defers to agent's judgment
router.post("/:id/let-agent-decide", (req: Request, res: Response) => {
  const db = getDb();
  const row = db.prepare("SELECT * FROM peaks WHERE id = ?").get(req.params.id) as PeakRow | undefined;
  if (!row) { res.status(404).json({ error: "peak not found" }); return; }
  if (row.status !== "pending") {
    res.status(400).json({ error: `peak already ${row.status}` });
    return;
  }

  // Use agent's default option
  const optionIndex = row.default_option;
  const now = Date.now();

  db.prepare(`
    UPDATE peaks SET status = 'auto_decided', decision_index = ?, decision_note = 'Human deferred to agent judgment', decided_by = ?, decided_at = ?
    WHERE id = ?
  `).run(optionIndex, row.agent_name, now, row.id);

  const options = JSON.parse(row.options) as { label: string; pros: string; cons: string }[];
  const chosenOption = options[optionIndex] || { label: "default", pros: "", cons: "" };
  const note = "Human deferred to agent judgment";
  const memId = persistPeakDecisionMemory(row, chosenOption, options, optionIndex, note, row.agent_name, now);
  const delivery = queueSettlementMessage(row, chosenOption, note, row.agent_name, memId);

  broadcast({ type: "peak:decided", data: buildSettlement(row, chosenOption, optionIndex, note, row.agent_name, memId, delivery.channelId, delivery.messageId) });

  res.json({ ok: true, chosen_index: optionIndex, chosen_option: chosenOption });
});

// POST /peaks/:id/pause - Human needs more time ("let me think")
router.post("/:id/pause", (req: Request, res: Response) => {
  const db = getDb();
  const row = db.prepare("SELECT * FROM peaks WHERE id = ?").get(req.params.id) as PeakRow | undefined;
  if (!row) { res.status(404).json({ error: "peak not found" }); return; }
  if (row.status !== "pending") {
    res.status(400).json({ error: `peak already ${row.status}` });
    return;
  }

  // Extend timeout by 10 minutes
  const extraSeconds = 600;
  db.prepare("UPDATE peaks SET timeout_seconds = timeout_seconds + ? WHERE id = ?")
    .run(extraSeconds, row.id);

  broadcast({ type: "peak:paused", data: { peak_id: row.id, agent_name: row.agent_name, extra_seconds: extraSeconds } });
  res.json({ ok: true, new_timeout: row.timeout_seconds + extraSeconds });
});

/**
 * Check for expired peaks and auto-decide them.
 * Called periodically by the peak timeout monitor.
 */
export function processExpiredPeaks(): { expired: number } {
  const db = getDb();
  const now = Date.now();

  const expired = db.prepare(`
    SELECT * FROM peaks WHERE status = 'pending' AND (created_at + timeout_seconds * 1000) < ?
  `).all(now) as PeakRow[];

  for (const peak of expired) {
    const options = JSON.parse(peak.options) as { label: string; pros: string; cons: string }[];
    const defaultIdx = peak.default_option;
    const chosenOption = options[defaultIdx] || { label: "default", pros: "", cons: "" };

    db.prepare(`
      UPDATE peaks SET status = 'expired', decision_index = ?, decision_note = 'Auto-decided on timeout', decided_by = 'system', decided_at = ?
      WHERE id = ?
    `).run(defaultIdx, now, peak.id);

    const note = "Auto-decided on timeout";
    const memId = persistPeakDecisionMemory(peak, chosenOption, options, defaultIdx, note, "system", now);
    const delivery = queueSettlementMessage(peak, chosenOption, note, "system", memId);

    broadcast({ type: "peak:decided", data: buildSettlement(peak, chosenOption, defaultIdx, note, "system", memId, delivery.channelId, delivery.messageId) });

    // Trigger pattern extraction from accumulated decisions
    if (peak.project_id) {
      try {
        extractPatternFromPeaks(peak.project_id);
      } catch { /* non-critical */ }
    }
  }

  return { expired: expired.length };
}

function formatPeak(row: PeakRow) {
  return {
    ...row,
    options: JSON.parse(row.options),
    expires_at: row.created_at + row.timeout_seconds * 1000,
  };
}

export default router;
