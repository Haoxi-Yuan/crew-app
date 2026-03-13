import { Router, type Request, type Response } from "express";
import type { Router as RouterType } from "express";
import crypto from "node:crypto";
import { getDb, type SharedStandardRow, type StandardsHistoryRow } from "../db/index.js";
import { broadcast } from "../ws/handler.js";

const router: RouterType = Router();

const VALID_CATEGORIES = ["coding_norm", "tool_preference", "workflow", "naming"];
const MAX_STANDARDS_BUDGET = 4000; // chars total across all active standards

// GET /standards - list all standards
router.get("/", (req: Request, res: Response) => {
  const status = req.query.status as string | undefined;
  const category = req.query.category as string | undefined;
  const db = getDb();

  let sql = "SELECT * FROM shared_standards WHERE 1=1";
  const params: string[] = [];

  if (status) {
    sql += " AND status = ?";
    params.push(status);
  }
  if (category) {
    sql += " AND category = ?";
    params.push(category);
  }

  sql += " ORDER BY priority DESC, updated_at DESC";
  const rows = db.prepare(sql).all(...params) as SharedStandardRow[];
  res.json(rows);
});

// GET /standards/budget - check current budget usage
router.get("/budget", (_req: Request, res: Response) => {
  const db = getDb();
  const rows = db.prepare("SELECT content FROM shared_standards WHERE status = 'active'").all() as { content: string }[];
  const totalChars = rows.reduce((sum, r) => sum + r.content.length, 0);
  res.json({
    used: totalChars,
    budget: MAX_STANDARDS_BUDGET,
    remaining: Math.max(0, MAX_STANDARDS_BUDGET - totalChars),
    count: rows.length,
  });
});

// POST /standards - create a new standard
router.post("/", (req: Request, res: Response) => {
  const { category, name, content, priority } = req.body as {
    category?: string;
    name?: string;
    content?: string;
    priority?: number;
  };

  if (!category || !name || !content) {
    res.status(400).json({ error: "category, name, and content are required" });
    return;
  }

  if (!VALID_CATEGORIES.includes(category)) {
    res.status(400).json({ error: `category must be one of: ${VALID_CATEGORIES.join(", ")}` });
    return;
  }

  const db = getDb();

  // Check budget
  const existing = db.prepare("SELECT content FROM shared_standards WHERE status = 'active'").all() as { content: string }[];
  const currentTotal = existing.reduce((sum, r) => sum + r.content.length, 0);
  if (currentTotal + content.length > MAX_STANDARDS_BUDGET) {
    res.status(400).json({
      error: "standards budget exceeded",
      used: currentTotal,
      budget: MAX_STANDARDS_BUDGET,
      remaining: MAX_STANDARDS_BUDGET - currentTotal,
      content_length: content.length,
    });
    return;
  }

  const id = crypto.randomUUID();
  const now = Date.now();

  db.prepare(`
    INSERT INTO shared_standards (id, category, name, content, priority, status, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, 'active', ?, ?)
  `).run(id, category, name, content, priority || 0, now, now);

  // Record initial version in history
  db.prepare(`
    INSERT INTO standards_history (standard_id, version, content, change_summary, source_reflection_ids, applied_by, created_at)
    VALUES (?, 1, ?, 'Initial creation', '[]', 'user', ?)
  `).run(id, content, now);

  const row = db.prepare("SELECT * FROM shared_standards WHERE id = ?").get(id) as SharedStandardRow;
  broadcast({ type: "standards:updated", data: { action: "created", standard: row } });
  res.json(row);
});

// PUT /standards/:id - update a standard
router.put("/:id", (req: Request, res: Response) => {
  const db = getDb();
  const existing = db.prepare("SELECT * FROM shared_standards WHERE id = ?").get(req.params.id) as SharedStandardRow | undefined;
  if (!existing) {
    res.status(404).json({ error: "standard not found" });
    return;
  }

  const { name, content, priority, status, change_summary } = req.body as {
    name?: string;
    content?: string;
    priority?: number;
    status?: string;
    change_summary?: string;
  };

  // Check budget if content changed and standard is/will be active
  const targetStatus = status || existing.status;
  if (content && content !== existing.content && targetStatus === "active") {
    const others = db.prepare("SELECT content FROM shared_standards WHERE status = 'active' AND id != ?").all(existing.id) as { content: string }[];
    const othersTotal = others.reduce((sum, r) => sum + r.content.length, 0);
    if (othersTotal + content.length > MAX_STANDARDS_BUDGET) {
      res.status(400).json({
        error: "standards budget exceeded",
        used: othersTotal,
        budget: MAX_STANDARDS_BUDGET,
        remaining: MAX_STANDARDS_BUDGET - othersTotal,
        content_length: content.length,
      });
      return;
    }
  }

  const now = Date.now();
  db.prepare(`
    UPDATE shared_standards SET
      name = ?, content = ?, priority = ?, status = ?, updated_at = ?
    WHERE id = ?
  `).run(
    name || existing.name,
    content || existing.content,
    priority !== undefined ? priority : existing.priority,
    status || existing.status,
    now,
    existing.id
  );

  // Record version history if content changed
  if (content && content !== existing.content) {
    const lastVersion = db.prepare(
      "SELECT MAX(version) as v FROM standards_history WHERE standard_id = ?"
    ).get(existing.id) as { v: number | null };
    const nextVersion = (lastVersion.v || 0) + 1;

    db.prepare(`
      INSERT INTO standards_history (standard_id, version, content, change_summary, source_reflection_ids, applied_by, created_at)
      VALUES (?, ?, ?, ?, '[]', 'user', ?)
    `).run(existing.id, nextVersion, content, change_summary || "Manual update", now);
  }

  const row = db.prepare("SELECT * FROM shared_standards WHERE id = ?").get(existing.id) as SharedStandardRow;
  broadcast({ type: "standards:updated", data: { action: "updated", standard: row } });
  res.json(row);
});

// DELETE /standards/:id
router.delete("/:id", (req: Request, res: Response) => {
  const db = getDb();
  const existing = db.prepare("SELECT 1 FROM shared_standards WHERE id = ?").get(req.params.id);
  if (!existing) {
    res.status(404).json({ error: "standard not found" });
    return;
  }

  db.prepare("DELETE FROM standards_history WHERE standard_id = ?").run(req.params.id);
  db.prepare("DELETE FROM shared_standards WHERE id = ?").run(req.params.id);

  broadcast({ type: "standards:updated", data: { action: "deleted", id: req.params.id } });
  res.json({ ok: true });
});

// GET /standards/:id/history - version history for a standard
router.get("/:id/history", (req: Request, res: Response) => {
  const db = getDb();
  const existing = db.prepare("SELECT 1 FROM shared_standards WHERE id = ?").get(req.params.id);
  if (!existing) {
    res.status(404).json({ error: "standard not found" });
    return;
  }

  const rows = db.prepare(
    "SELECT * FROM standards_history WHERE standard_id = ? ORDER BY version DESC"
  ).all(req.params.id) as StandardsHistoryRow[];
  res.json(rows);
});

// POST /standards/:id/rollback - rollback to a specific version
router.post("/:id/rollback", (req: Request, res: Response) => {
  const { version } = req.body as { version?: number };
  if (!version) {
    res.status(400).json({ error: "version is required" });
    return;
  }

  const db = getDb();
  const existing = db.prepare("SELECT * FROM shared_standards WHERE id = ?").get(req.params.id) as SharedStandardRow | undefined;
  if (!existing) {
    res.status(404).json({ error: "standard not found" });
    return;
  }

  const historyRow = db.prepare(
    "SELECT * FROM standards_history WHERE standard_id = ? AND version = ?"
  ).get(req.params.id, version) as StandardsHistoryRow | undefined;
  if (!historyRow) {
    res.status(404).json({ error: `version ${version} not found` });
    return;
  }

  const now = Date.now();

  // Record current state as new version before rollback
  const lastVersion = db.prepare(
    "SELECT MAX(version) as v FROM standards_history WHERE standard_id = ?"
  ).get(existing.id) as { v: number };
  const nextVersion = lastVersion.v + 1;

  db.prepare(`
    INSERT INTO standards_history (standard_id, version, content, change_summary, source_reflection_ids, applied_by, created_at)
    VALUES (?, ?, ?, ?, '[]', 'user', ?)
  `).run(existing.id, nextVersion, historyRow.content, `Rollback to version ${version}`, now);

  // Apply rollback
  db.prepare("UPDATE shared_standards SET content = ?, updated_at = ? WHERE id = ?")
    .run(historyRow.content, now, existing.id);

  const row = db.prepare("SELECT * FROM shared_standards WHERE id = ?").get(existing.id) as SharedStandardRow;
  broadcast({ type: "standards:updated", data: { action: "rolled_back", standard: row, to_version: version } });
  res.json({ ok: true, version: nextVersion, content: historyRow.content });
});

export default router;
