import { Router, type Request, type Response } from "express";
import type { Router as RouterType } from "express";
import crypto from "node:crypto";
import { getDb, type MemoryEntryRow } from "../db/index.js";
import {
  computeActivation,
  computeRetrievability,
  computeSearchScore,
  onMemoryAccessed,
  consolidate,
  type MemoryEntry,
} from "../memory-engine.js";
import {
  generateEmbedding,
  bufferToVector,
  cosineSimilarity,
  isEmbeddingAvailable,
} from "../embedding.js";

const router: RouterType = Router();

function rowToEntry(row: MemoryEntryRow): MemoryEntry {
  return { ...row };
}

// POST /api/memory/entries - Create a new memory entry
router.post("/entries", (req: Request, res: Response) => {
  const {
    agent_name = "author",
    category,
    source_file = "",
    heading,
    content,
    importance = 3,
    emotional_weight = 1.0,
    linked_ids = [],
  } = req.body as {
    agent_name?: string;
    category?: string;
    source_file?: string;
    heading?: string;
    content?: string;
    importance?: number;
    emotional_weight?: number;
    linked_ids?: string[];
  };

  if (!category || !heading || !content) {
    res.status(400).json({ error: "category, heading, and content are required" });
    return;
  }

  const validCategories = ["contact", "preference", "decision", "project", "pattern", "feedback", "daily"];
  if (!validCategories.includes(category)) {
    res.status(400).json({ error: `category must be one of: ${validCategories.join(", ")}` });
    return;
  }

  const db = getDb();
  const now = Date.now();
  const id = crypto.randomUUID();
  const contentHash = crypto.createHash("sha256").update(content).digest("hex").slice(0, 16);

  // Check for duplicate content
  const existing = db
    .prepare("SELECT id FROM memory_entries WHERE agent_name = ? AND content_hash = ? AND status != 'archived'")
    .get(agent_name, contentHash) as { id: string } | undefined;

  if (existing) {
    res.status(409).json({ error: "duplicate content", existing_id: existing.id });
    return;
  }

  const clampedImportance = Math.max(1, Math.min(5, Math.round(importance)));
  const clampedEmotional = Math.max(1.0, Math.min(2.0, emotional_weight));

  // Determine initial status
  const permanentCategories = new Set(["contact", "preference"]);
  const initialStatus = permanentCategories.has(category) ? "permanent" : "active";

  db.prepare(`
    INSERT INTO memory_entries (
      id, agent_name, category, source_file, heading, content, content_hash,
      importance, emotional_weight, created_at, last_accessed_at,
      access_count, access_timestamps, stability, difficulty,
      activation, retrievability, status, linked_ids
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, '[]', 1.0, 0.3, 0.0, 1.0, ?, '${JSON.stringify(linked_ids)}')
  `).run(
    id, agent_name, category, source_file, heading, content, contentHash,
    clampedImportance, clampedEmotional, now, now, initialStatus
  );

  // Compute initial activation
  const row = db.prepare("SELECT * FROM memory_entries WHERE id = ?").get(id) as MemoryEntryRow;
  const entry = rowToEntry(row);
  const activation = computeActivation(entry, now);
  const retrievability = computeRetrievability(activation);
  db.prepare("UPDATE memory_entries SET activation = ?, retrievability = ? WHERE id = ?")
    .run(activation, retrievability, id);

  // Generate embedding asynchronously (non-blocking)
  const embeddingText = `${heading}\n${content}`;
  generateEmbedding(embeddingText).then((buf) => {
    if (buf) {
      getDb().prepare("UPDATE memory_entries SET embedding = ? WHERE id = ?").run(buf, id);
    }
  }).catch(() => { /* Ollama unavailable, skip silently */ });

  res.json({ id, status: initialStatus, activation, retrievability });
});

// GET /api/memory/entries/:id - Read a specific memory entry (records access)
router.get("/entries/:id", (req: Request, res: Response) => {
  const db = getDb();
  const row = db.prepare("SELECT * FROM memory_entries WHERE id = ?").get(req.params.id) as MemoryEntryRow | undefined;

  if (!row) {
    res.status(404).json({ error: "memory entry not found" });
    return;
  }

  const now = Date.now();
  const updated = onMemoryAccessed(rowToEntry(row), now);

  db.prepare(`
    UPDATE memory_entries SET
      access_count = ?, access_timestamps = ?, last_accessed_at = ?,
      stability = ?, activation = ?, retrievability = ?
    WHERE id = ?
  `).run(
    updated.access_count, updated.access_timestamps, updated.last_accessed_at,
    updated.stability, updated.activation, updated.retrievability,
    updated.id
  );

  res.json({
    id: updated.id,
    agent_name: updated.agent_name,
    category: updated.category,
    heading: updated.heading,
    content: updated.content,
    importance: updated.importance,
    status: updated.status,
    access_count: updated.access_count,
    activation: updated.activation,
    retrievability: updated.retrievability,
  });
});

// GET /api/memory/search - Search memories with hybrid keyword + vector ranking
router.get("/search", async (req: Request, res: Response) => {
  const {
    q,
    agent_name = "author",
    category,
    include_weak,
    limit = "5",
    summary_only = "true",
  } = req.query as {
    q?: string;
    agent_name?: string;
    category?: string;
    include_weak?: string;
    limit?: string;
    summary_only?: string;
  };

  if (!q) {
    res.status(400).json({ error: "q (query) is required" });
    return;
  }

  const db = getDb();
  const now = Date.now();
  const maxResults = Math.min(parseInt(limit) || 5, 20);
  const isSummary = summary_only !== "false";

  // Build SQL query
  let sql = `
    SELECT * FROM memory_entries
    WHERE agent_name = ? AND status != 'archived'
  `;
  const params: (string | number)[] = [agent_name];

  if (category) {
    sql += " AND category = ?";
    params.push(category);
  }

  if (!include_weak || include_weak === "false") {
    sql += " AND retrievability > 0.05";
  }

  sql += " ORDER BY retrievability DESC";
  const rows = db.prepare(sql).all(...params) as MemoryEntryRow[];

  // Generate query embedding if Ollama is available
  const embeddingAvailable = await isEmbeddingAvailable();
  let queryVector: number[] | null = null;
  if (embeddingAvailable) {
    const queryBuf = await generateEmbedding(q);
    if (queryBuf) queryVector = bufferToVector(queryBuf);
  }

  // Hybrid scoring: keyword + vector similarity
  const queryTerms = q.toLowerCase().split(/\s+/).filter(Boolean);
  const scored = rows.map((row) => {
    const entry = rowToEntry(row);

    // Recalculate activation
    entry.activation = computeActivation(entry, now);
    entry.retrievability = computeRetrievability(entry.activation);

    // Keyword relevance: count matching terms in heading + content
    const text = `${entry.heading} ${entry.content}`.toLowerCase();
    let matchCount = 0;
    for (const term of queryTerms) {
      if (text.includes(term)) matchCount++;
    }
    const keywordRelevance = queryTerms.length > 0 ? matchCount / queryTerms.length : 0;

    // Vector similarity (if available)
    let vectorSimilarity = 0;
    if (queryVector && row.embedding) {
      const entryVector = bufferToVector(row.embedding);
      vectorSimilarity = Math.max(0, cosineSimilarity(queryVector, entryVector));
    }

    // Skip entries with no relevance signal at all
    if (matchCount === 0 && vectorSimilarity < 0.3) return null;

    // Hybrid relevance: keyword and vector complement each other
    // When both available: 50/50 blend. When only keyword: 100% keyword.
    let searchRelevance: number;
    if (queryVector && row.embedding) {
      searchRelevance = 0.5 * keywordRelevance + 0.5 * vectorSimilarity;
    } else {
      searchRelevance = keywordRelevance;
    }

    const finalScore = computeSearchScore(searchRelevance, entry.retrievability);

    return { entry, keywordRelevance, vectorSimilarity, finalScore };
  }).filter(Boolean) as { entry: MemoryEntry; keywordRelevance: number; vectorSimilarity: number; finalScore: number }[];

  // Sort by final score
  scored.sort((a, b) => b.finalScore - a.finalScore);
  const results = scored.slice(0, maxResults);

  // Record access for returned results
  for (const { entry } of results) {
    const updated = onMemoryAccessed(entry, now);
    db.prepare(`
      UPDATE memory_entries SET
        access_count = ?, access_timestamps = ?, last_accessed_at = ?,
        stability = ?, activation = ?, retrievability = ?
      WHERE id = ?
    `).run(
      updated.access_count, updated.access_timestamps, updated.last_accessed_at,
      updated.stability, updated.activation, updated.retrievability,
      updated.id
    );
  }

  if (isSummary) {
    res.json({
      count: results.length,
      entries: results.map(({ entry, finalScore }) => ({
        id: entry.id,
        heading: entry.heading,
        category: entry.category,
        importance: entry.importance,
        retrievability: Math.round(entry.retrievability * 100) / 100,
        score: Math.round(finalScore * 100) / 100,
      })),
    });
  } else {
    res.json({
      count: results.length,
      entries: results.map(({ entry, finalScore }) => ({
        id: entry.id,
        heading: entry.heading,
        category: entry.category,
        content: entry.content,
        importance: entry.importance,
        status: entry.status,
        access_count: entry.access_count,
        retrievability: Math.round(entry.retrievability * 100) / 100,
        score: Math.round(finalScore * 100) / 100,
      })),
    });
  }
});

// POST /api/memory/consolidate - Trigger memory consolidation
router.post("/consolidate", (req: Request, res: Response) => {
  const { agent_name = "author" } = req.body as { agent_name?: string };
  const db = getDb();
  const now = Date.now();

  const rows = db
    .prepare("SELECT * FROM memory_entries WHERE agent_name = ? AND status != 'archived'")
    .all(agent_name) as MemoryEntryRow[];

  const entries = rows.map(rowToEntry);
  const { result, updates } = consolidate(entries, now);

  // Batch update all entries
  const updateStmt = db.prepare(`
    UPDATE memory_entries SET
      activation = ?, retrievability = ?, status = ?,
      stability = ?, promoted_at = ?, archived_at = ?
    WHERE id = ?
  `);

  const tx = db.transaction(() => {
    for (const entry of updates) {
      updateStmt.run(
        entry.activation, entry.retrievability, entry.status,
        entry.stability, entry.promoted_at, entry.archived_at,
        entry.id
      );
    }
  });
  tx();

  res.json({
    agent_name,
    total_processed: result.recalculated,
    promoted: result.promoted.length,
    archived: result.archived.length,
    promoted_ids: result.promoted,
    archived_ids: result.archived,
  });
});

// GET /api/memory/stats - Memory health dashboard
router.get("/stats", (req: Request, res: Response) => {
  const { agent_name = "author" } = req.query as { agent_name?: string };
  const db = getDb();

  const total = db
    .prepare("SELECT COUNT(*) as count FROM memory_entries WHERE agent_name = ?")
    .get(agent_name) as { count: number };

  const byStatus = db
    .prepare("SELECT status, COUNT(*) as count FROM memory_entries WHERE agent_name = ? GROUP BY status")
    .all(agent_name) as { status: string; count: number }[];

  const byCategory = db
    .prepare("SELECT category, COUNT(*) as count FROM memory_entries WHERE agent_name = ? AND status != 'archived' GROUP BY category")
    .all(agent_name) as { category: string; count: number }[];

  const avgRetrievability = db
    .prepare("SELECT AVG(retrievability) as avg FROM memory_entries WHERE agent_name = ? AND status != 'archived'")
    .get(agent_name) as { avg: number | null };

  const recentAccess = db
    .prepare("SELECT id, heading, category, access_count, last_accessed_at FROM memory_entries WHERE agent_name = ? AND status != 'archived' ORDER BY last_accessed_at DESC LIMIT 5")
    .all(agent_name) as { id: string; heading: string; category: string; access_count: number; last_accessed_at: number }[];

  res.json({
    agent_name,
    total: total.count,
    by_status: Object.fromEntries(byStatus.map((r) => [r.status, r.count])),
    by_category: Object.fromEntries(byCategory.map((r) => [r.category, r.count])),
    avg_retrievability: avgRetrievability.avg ? Math.round(avgRetrievability.avg * 100) / 100 : null,
    recently_accessed: recentAccess,
  });
});

// DELETE /api/memory/entries/:id - Delete a memory entry
router.delete("/entries/:id", (req: Request, res: Response) => {
  const db = getDb();
  const result = db.prepare("DELETE FROM memory_entries WHERE id = ?").run(req.params.id);
  if (result.changes === 0) {
    res.status(404).json({ error: "memory entry not found" });
    return;
  }
  res.json({ ok: true });
});

// PUT /api/memory/entries/:id - Update a memory entry
router.put("/entries/:id", (req: Request, res: Response) => {
  const db = getDb();
  const existing = db.prepare("SELECT * FROM memory_entries WHERE id = ?").get(req.params.id) as MemoryEntryRow | undefined;

  if (!existing) {
    res.status(404).json({ error: "memory entry not found" });
    return;
  }

  const { heading, content, importance, emotional_weight, category, status } = req.body as {
    heading?: string;
    content?: string;
    importance?: number;
    emotional_weight?: number;
    category?: string;
    status?: string;
  };

  const updates: string[] = [];
  const params: (string | number)[] = [];

  if (heading !== undefined) { updates.push("heading = ?"); params.push(heading); }
  if (content !== undefined) {
    const hash = crypto.createHash("sha256").update(content).digest("hex").slice(0, 16);
    updates.push("content = ?", "content_hash = ?");
    params.push(content, hash);
  }
  if (importance !== undefined) { updates.push("importance = ?"); params.push(Math.max(1, Math.min(5, Math.round(importance)))); }
  if (emotional_weight !== undefined) { updates.push("emotional_weight = ?"); params.push(Math.max(1.0, Math.min(2.0, emotional_weight))); }
  if (category !== undefined) { updates.push("category = ?"); params.push(category); }
  if (status !== undefined) { updates.push("status = ?"); params.push(status); }

  if (updates.length === 0) {
    res.status(400).json({ error: "no fields to update" });
    return;
  }

  const entryId = String(req.params.id);
  params.push(entryId);
  db.prepare(`UPDATE memory_entries SET ${updates.join(", ")} WHERE id = ?`).run(...params);

  // Re-generate embedding if heading or content changed
  if (heading !== undefined || content !== undefined) {
    const updatedRow = db.prepare("SELECT heading, content FROM memory_entries WHERE id = ?").get(entryId) as { heading: string; content: string };
    generateEmbedding(`${updatedRow.heading}\n${updatedRow.content}`).then((buf) => {
      if (buf) {
        getDb().prepare("UPDATE memory_entries SET embedding = ? WHERE id = ?").run(buf, entryId);
      }
    }).catch(() => {});
  }

  res.json({ ok: true });
});

// POST /api/memory/reindex - Generate embeddings for entries that don't have one
router.post("/reindex", async (req: Request, res: Response) => {
  const { agent_name = "author" } = req.body as { agent_name?: string };

  const available = await isEmbeddingAvailable();
  if (!available) {
    res.status(503).json({ error: "Ollama is not running. Start with: ollama serve" });
    return;
  }

  const db = getDb();
  const rows = db
    .prepare("SELECT id, heading, content FROM memory_entries WHERE agent_name = ? AND embedding IS NULL AND status != 'archived'")
    .all(agent_name) as { id: string; heading: string; content: string }[];

  let indexed = 0;
  let failed = 0;
  for (const row of rows) {
    const buf = await generateEmbedding(`${row.heading}\n${row.content}`);
    if (buf) {
      db.prepare("UPDATE memory_entries SET embedding = ? WHERE id = ?").run(buf, row.id);
      indexed++;
    } else {
      failed++;
    }
  }

  res.json({ total: rows.length, indexed, failed });
});

export default router;
