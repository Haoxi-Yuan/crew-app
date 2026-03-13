import { Router, type Request, type Response } from "express";
import type { Router as RouterType } from "express";
import crypto from "node:crypto";
import { getDb, type ReflectionRow } from "../db/index.js";
import { broadcast } from "../ws/handler.js";
import { reviewProposedUpdate } from "../sop-engine.js";

const router: RouterType = Router();

// POST /reflections - submit a new reflection
router.post("/", (req: Request, res: Response) => {
  const {
    agent_name,
    project_id,
    trigger_type,
    task_summary,
    lessons_learned = [],
    proposed_updates = [],
    confidence = 0.5,
  } = req.body as {
    agent_name?: string;
    project_id?: string;
    trigger_type?: string;
    task_summary?: string;
    lessons_learned?: unknown[];
    proposed_updates?: unknown[];
    confidence?: number;
  };

  if (!agent_name || !project_id || !trigger_type || !task_summary) {
    res.status(400).json({ error: "agent_name, project_id, trigger_type, and task_summary are required" });
    return;
  }

  const validTriggers = ["task_complete", "project_milestone", "manual", "session_cycle"];
  if (!validTriggers.includes(trigger_type)) {
    res.status(400).json({ error: `trigger_type must be one of: ${validTriggers.join(", ")}` });
    return;
  }

  const db = getDb();
  const id = crypto.randomUUID();
  const now = Date.now();

  db.prepare(`
    INSERT INTO reflections (id, agent_name, project_id, trigger_type, task_summary, lessons_learned, proposed_updates, confidence, status, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)
  `).run(
    id, agent_name, project_id, trigger_type, task_summary,
    JSON.stringify(lessons_learned),
    JSON.stringify(proposed_updates),
    Math.max(0, Math.min(1, confidence)),
    now
  );

  // Auto-review each proposed update via SOP engine
  const autoResults: { index: number; action: string; reason: string }[] = [];
  for (let i = 0; i < proposed_updates.length; i++) {
    const update = proposed_updates[i] as Record<string, unknown>;
    const result = reviewProposedUpdate(update, confidence, agent_name);
    autoResults.push({ index: i, ...result });
  }

  // If all proposed updates were auto-applied, mark reflection as auto_applied
  const allApplied = autoResults.length > 0 && autoResults.every((r) => r.action === "applied");
  if (allApplied) {
    db.prepare("UPDATE reflections SET status = 'auto_applied', reviewed_at = ? WHERE id = ?").run(now, id);
  }

  broadcast({ type: "reflection:created", data: { id, agent_name, project_id, status: allApplied ? "auto_applied" : "pending" } });
  res.json({ id, status: allApplied ? "auto_applied" : "pending", auto_results: autoResults });
});

// GET /reflections - list reflections
router.get("/", (req: Request, res: Response) => {
  const { project_id, status, agent_name, limit = "20" } = req.query as {
    project_id?: string;
    status?: string;
    agent_name?: string;
    limit?: string;
  };

  const db = getDb();
  let sql = "SELECT * FROM reflections WHERE 1=1";
  const params: (string | number)[] = [];

  if (project_id) {
    sql += " AND project_id = ?";
    params.push(project_id);
  }
  if (status) {
    sql += " AND status = ?";
    params.push(status);
  }
  if (agent_name) {
    sql += " AND agent_name = ?";
    params.push(agent_name);
  }

  sql += " ORDER BY created_at DESC LIMIT ?";
  params.push(Math.min(parseInt(limit) || 20, 100));

  const rows = db.prepare(sql).all(...params) as ReflectionRow[];
  const result = rows.map((r) => ({
    ...r,
    lessons_learned: JSON.parse(r.lessons_learned),
    proposed_updates: JSON.parse(r.proposed_updates),
  }));
  res.json(result);
});

// GET /reflections/:id - get a single reflection
router.get("/:id", (req: Request, res: Response) => {
  const db = getDb();
  const row = db.prepare("SELECT * FROM reflections WHERE id = ?").get(req.params.id) as ReflectionRow | undefined;
  if (!row) {
    res.status(404).json({ error: "reflection not found" });
    return;
  }
  res.json({
    ...row,
    lessons_learned: JSON.parse(row.lessons_learned),
    proposed_updates: JSON.parse(row.proposed_updates),
  });
});

// PUT /reflections/:id/review - manually approve or reject a reflection
router.put("/:id/review", (req: Request, res: Response) => {
  const { action, reviewed_by } = req.body as {
    action?: string;
    reviewed_by?: string;
  };

  if (!action || !["approve", "reject"].includes(action)) {
    res.status(400).json({ error: "action must be 'approve' or 'reject'" });
    return;
  }

  const db = getDb();
  const row = db.prepare("SELECT * FROM reflections WHERE id = ?").get(req.params.id) as ReflectionRow | undefined;
  if (!row) {
    res.status(404).json({ error: "reflection not found" });
    return;
  }
  if (row.status !== "pending") {
    res.status(400).json({ error: `reflection already ${row.status}` });
    return;
  }

  const now = Date.now();
  const newStatus = action === "approve" ? "manually_approved" : "rejected";
  db.prepare("UPDATE reflections SET status = ?, reviewed_by = ?, reviewed_at = ? WHERE id = ?")
    .run(newStatus, reviewed_by || "user", now, row.id);

  // If approved, apply all proposed updates
  if (action === "approve") {
    const updates = JSON.parse(row.proposed_updates) as Record<string, unknown>[];
    for (const update of updates) {
      reviewProposedUpdate(update, row.confidence, row.agent_name, true);
    }
  }

  broadcast({ type: "reflection:reviewed", data: { id: row.id, status: newStatus } });
  res.json({ ok: true, status: newStatus });
});

export default router;
