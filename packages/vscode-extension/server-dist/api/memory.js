import crypto from "node:crypto";
import { Router } from "express";
import { getDb } from "../db/index.js";
import { computeActivation, computeRetrievability, computeSearchScore, consolidate, onMemoryAccessed, } from "../memory-engine.js";
import { bufferToVector, cosineSimilarity, generateEmbedding, isEmbeddingAvailable, } from "../embedding.js";
import { inferMemoryIntent, listProjectScopeIds, resolveScope } from "../storage-scope.js";
const router = Router();
const VALID_CATEGORIES = ["contact", "preference", "decision", "project", "pattern", "feedback", "daily"];
function rowToEntry(row) {
    return { ...row };
}
function buildScopeFilter(projectId, scopeType, scopeId) {
    if (scopeType && (scopeType === "global" || scopeType === "project" || scopeType === "workplace")) {
        return {
            sql: "scope_type = ? AND scope_id = ?",
            params: [scopeType, scopeType === "global" ? "" : (scopeId || "")],
        };
    }
    if (projectId) {
        const scopeIds = listProjectScopeIds(projectId);
        const params = [projectId, ...scopeIds.workplaceIds];
        const placeholders = scopeIds.workplaceIds.map(() => "?").join(", ");
        const workplaceClause = scopeIds.workplaceIds.length > 0
            ? ` OR (scope_type = 'workplace' AND scope_id IN (${placeholders}))`
            : "";
        return {
            sql: `(scope_type = 'project' AND scope_id = ?${workplaceClause})`,
            params,
        };
    }
    return {
        sql: "scope_type = 'global' AND scope_id = ''",
        params: [],
    };
}
router.post("/entries", (req, res) => {
    const { agent_name = "author", category, source_file = "", heading, content, importance = 3, emotional_weight = 1.0, linked_ids = [], project_id = null, scope_type = null, scope_id = null, scope_kind = null, } = req.body;
    if (!category || !heading || !content) {
        res.status(400).json({ error: "category, heading, and content are required" });
        return;
    }
    if (!VALID_CATEGORIES.includes(category)) {
        res.status(400).json({ error: `category must be one of: ${VALID_CATEGORIES.join(", ")}` });
        return;
    }
    let resolvedScope;
    try {
        resolvedScope = resolveScope({
            scopeType: scope_type,
            scopeId: scope_id,
            projectId: project_id,
            intent: inferMemoryIntent(category, scope_kind),
        });
    }
    catch (err) {
        res.status(400).json({ error: err.message });
        return;
    }
    const db = getDb();
    const now = Date.now();
    const id = crypto.randomUUID();
    const contentHash = crypto.createHash("sha256").update(content).digest("hex").slice(0, 16);
    const existing = db.prepare(`
    SELECT id
    FROM memory_entries
    WHERE agent_name = ? AND content_hash = ? AND scope_type = ? AND scope_id = ? AND status != 'archived'
  `).get(agent_name, contentHash, resolvedScope.scopeType, resolvedScope.scopeId);
    if (existing) {
        res.status(409).json({ error: "duplicate content", existing_id: existing.id });
        return;
    }
    const clampedImportance = Math.max(1, Math.min(5, Math.round(importance)));
    const clampedEmotional = Math.max(1.0, Math.min(2.0, emotional_weight));
    const permanentCategories = new Set(["contact", "preference"]);
    const initialStatus = permanentCategories.has(category) ? "permanent" : "active";
    db.prepare(`
    INSERT INTO memory_entries (
      id, agent_name, category, source_file, heading, content, content_hash,
      importance, emotional_weight, created_at, last_accessed_at,
      access_count, access_timestamps, stability, difficulty,
      activation, retrievability, status, linked_ids, project_id, scope_type, scope_id
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, '[]', 1.0, 0.3, 0.0, 1.0, ?, ?, ?, ?, ?)
  `).run(id, agent_name, category, source_file, heading, content, contentHash, clampedImportance, clampedEmotional, now, now, initialStatus, JSON.stringify(linked_ids), resolvedScope.projectId, resolvedScope.scopeType, resolvedScope.scopeId);
    const row = db.prepare("SELECT * FROM memory_entries WHERE id = ?").get(id);
    const entry = rowToEntry(row);
    const activation = computeActivation(entry, now);
    const retrievability = computeRetrievability(activation);
    db.prepare("UPDATE memory_entries SET activation = ?, retrievability = ? WHERE id = ?")
        .run(activation, retrievability, id);
    generateEmbedding(`${heading}\n${content}`).then((buf) => {
        if (buf) {
            getDb().prepare("UPDATE memory_entries SET embedding = ? WHERE id = ?").run(buf, id);
        }
    }).catch(() => { });
    res.json({
        id,
        status: initialStatus,
        activation,
        retrievability,
        scope_type: resolvedScope.scopeType,
        scope_id: resolvedScope.scopeId,
        project_id: resolvedScope.projectId,
    });
});
router.get("/entries/:id", (req, res) => {
    const db = getDb();
    const row = db.prepare("SELECT * FROM memory_entries WHERE id = ?").get(req.params.id);
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
  `).run(updated.access_count, updated.access_timestamps, updated.last_accessed_at, updated.stability, updated.activation, updated.retrievability, updated.id);
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
        project_id: updated.project_id || null,
        scope_type: updated.scope_type || "global",
        scope_id: updated.scope_id || "",
    });
});
router.get("/search", async (req, res) => {
    const { q, agent_name = "author", category, include_weak, limit = "5", summary_only = "true", project_id, scope_type, scope_id, } = req.query;
    if (!q) {
        res.status(400).json({ error: "q (query) is required" });
        return;
    }
    const db = getDb();
    const now = Date.now();
    const maxResults = Math.min(parseInt(limit, 10) || 5, 20);
    const summary = summary_only !== "false";
    const scopeFilter = buildScopeFilter(project_id, scope_type, scope_id);
    let sql = `
    SELECT * FROM memory_entries
    WHERE agent_name = ? AND status != 'archived' AND ${scopeFilter.sql}
  `;
    const params = [agent_name, ...scopeFilter.params];
    if (category) {
        sql += " AND category = ?";
        params.push(category);
    }
    if (!include_weak || include_weak === "false") {
        sql += " AND retrievability > 0.05";
    }
    sql += " ORDER BY retrievability DESC";
    const rows = db.prepare(sql).all(...params);
    const embeddingAvailable = await isEmbeddingAvailable();
    let queryVector = null;
    if (embeddingAvailable) {
        const queryBuf = await generateEmbedding(q);
        if (queryBuf)
            queryVector = bufferToVector(queryBuf);
    }
    const queryTerms = q.toLowerCase().split(/\s+/).filter(Boolean);
    const scored = rows.map((row) => {
        const entry = rowToEntry(row);
        entry.activation = computeActivation(entry, now);
        entry.retrievability = computeRetrievability(entry.activation);
        const text = `${entry.heading} ${entry.content}`.toLowerCase();
        let matchCount = 0;
        for (const term of queryTerms) {
            if (text.includes(term))
                matchCount++;
        }
        const keywordRelevance = queryTerms.length > 0 ? matchCount / queryTerms.length : 0;
        let vectorSimilarity = 0;
        if (queryVector && row.embedding) {
            vectorSimilarity = Math.max(0, cosineSimilarity(queryVector, bufferToVector(row.embedding)));
        }
        if (matchCount === 0 && vectorSimilarity < 0.3)
            return null;
        const searchRelevance = queryVector && row.embedding
            ? 0.5 * keywordRelevance + 0.5 * vectorSimilarity
            : keywordRelevance;
        const hoursSinceAccess = Math.max(0, (now - entry.last_accessed_at) / 3600000);
        const recentAccessBoost = entry.access_count > 0
            ? Math.max(0, 0.2 - Math.min(hoursSinceAccess, 24) * (0.2 / 24))
            : 0;
        const finalScore = computeSearchScore(searchRelevance, entry.retrievability) + recentAccessBoost;
        return { entry, finalScore };
    }).filter(Boolean);
    scored.sort((a, b) => (b.finalScore - a.finalScore)
        || (b.entry.retrievability - a.entry.retrievability)
        || (b.entry.last_accessed_at - a.entry.last_accessed_at));
    const results = scored.slice(0, maxResults);
    for (const { entry } of results) {
        const updated = onMemoryAccessed(entry, now);
        db.prepare(`
      UPDATE memory_entries SET
        access_count = ?, access_timestamps = ?, last_accessed_at = ?,
        stability = ?, activation = ?, retrievability = ?
      WHERE id = ?
    `).run(updated.access_count, updated.access_timestamps, updated.last_accessed_at, updated.stability, updated.activation, updated.retrievability, updated.id);
    }
    res.json({
        count: results.length,
        entries: results.map(({ entry, finalScore }) => ({
            id: entry.id,
            heading: entry.heading,
            category: entry.category,
            ...(summary ? {} : { content: entry.content, status: entry.status, access_count: entry.access_count }),
            importance: entry.importance,
            retrievability: Math.round(entry.retrievability * 100) / 100,
            score: Math.round(finalScore * 100) / 100,
            project_id: entry.project_id || null,
            scope_type: entry.scope_type || "global",
            scope_id: entry.scope_id || "",
        })),
    });
});
router.post("/consolidate", (req, res) => {
    const { agent_name = "author", project_id = null, scope_type = null, scope_id = null, } = req.body;
    const db = getDb();
    const now = Date.now();
    const scopeFilter = buildScopeFilter(project_id, scope_type, scope_id);
    const rows = db.prepare(`
    SELECT * FROM memory_entries
    WHERE agent_name = ? AND status != 'archived' AND ${scopeFilter.sql}
  `).all(agent_name, ...scopeFilter.params);
    const { result, updates } = consolidate(rows.map(rowToEntry), now);
    const updateStmt = db.prepare(`
    UPDATE memory_entries SET
      activation = ?, retrievability = ?, status = ?, stability = ?, promoted_at = ?, archived_at = ?
    WHERE id = ?
  `);
    const tx = db.transaction(() => {
        for (const entry of updates) {
            updateStmt.run(entry.activation, entry.retrievability, entry.status, entry.stability, entry.promoted_at, entry.archived_at, entry.id);
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
        scope_type: scope_type || (project_id ? "project+workplaces" : "global"),
        scope_id: scope_id || project_id || "",
    });
});
router.get("/stats", (req, res) => {
    const { agent_name = "author", project_id, scope_type, scope_id, } = req.query;
    const db = getDb();
    const scopeFilter = buildScopeFilter(project_id, scope_type, scope_id);
    const total = db.prepare(`
    SELECT COUNT(*) as count
    FROM memory_entries
    WHERE agent_name = ? AND ${scopeFilter.sql}
  `).get(agent_name, ...scopeFilter.params);
    const byStatus = db.prepare(`
    SELECT status, COUNT(*) as count
    FROM memory_entries
    WHERE agent_name = ? AND ${scopeFilter.sql}
    GROUP BY status
  `).all(agent_name, ...scopeFilter.params);
    const byCategory = db.prepare(`
    SELECT category, COUNT(*) as count
    FROM memory_entries
    WHERE agent_name = ? AND status != 'archived' AND ${scopeFilter.sql}
    GROUP BY category
  `).all(agent_name, ...scopeFilter.params);
    const avgRetrievability = db.prepare(`
    SELECT AVG(retrievability) as avg
    FROM memory_entries
    WHERE agent_name = ? AND status != 'archived' AND ${scopeFilter.sql}
  `).get(agent_name, ...scopeFilter.params);
    const recentAccess = db.prepare(`
    SELECT id, heading, category, access_count, last_accessed_at
    FROM memory_entries
    WHERE agent_name = ? AND status != 'archived' AND ${scopeFilter.sql}
    ORDER BY last_accessed_at DESC
    LIMIT 5
  `).all(agent_name, ...scopeFilter.params);
    res.json({
        agent_name,
        total: total.count,
        by_status: Object.fromEntries(byStatus.map((row) => [row.status, row.count])),
        by_category: Object.fromEntries(byCategory.map((row) => [row.category, row.count])),
        avg_retrievability: avgRetrievability.avg ? Math.round(avgRetrievability.avg * 100) / 100 : null,
        recently_accessed: recentAccess,
        scope_type: scope_type || (project_id ? "project+workplaces" : "global"),
        scope_id: scope_id || project_id || "",
    });
});
router.delete("/entries/:id", (req, res) => {
    const db = getDb();
    const result = db.prepare("DELETE FROM memory_entries WHERE id = ?").run(req.params.id);
    if (result.changes === 0) {
        res.status(404).json({ error: "memory entry not found" });
        return;
    }
    res.json({ ok: true });
});
router.put("/entries/:id", (req, res) => {
    const db = getDb();
    const entryId = typeof req.params.id === "string" ? req.params.id : String(req.params.id);
    const existing = db.prepare("SELECT * FROM memory_entries WHERE id = ?").get(entryId);
    if (!existing) {
        res.status(404).json({ error: "memory entry not found" });
        return;
    }
    const { heading, content, importance, emotional_weight, category, status } = req.body;
    const updates = [];
    const params = [];
    if (heading !== undefined) {
        updates.push("heading = ?");
        params.push(heading);
    }
    if (content !== undefined) {
        updates.push("content = ?", "content_hash = ?");
        params.push(content, crypto.createHash("sha256").update(content).digest("hex").slice(0, 16));
    }
    if (importance !== undefined) {
        updates.push("importance = ?");
        params.push(Math.max(1, Math.min(5, Math.round(importance))));
    }
    if (emotional_weight !== undefined) {
        updates.push("emotional_weight = ?");
        params.push(Math.max(1.0, Math.min(2.0, emotional_weight)));
    }
    if (category !== undefined) {
        updates.push("category = ?");
        params.push(category);
    }
    if (status !== undefined) {
        updates.push("status = ?");
        params.push(status);
    }
    if (updates.length === 0) {
        res.status(400).json({ error: "no fields to update" });
        return;
    }
    params.push(entryId);
    db.prepare(`UPDATE memory_entries SET ${updates.join(", ")} WHERE id = ?`).run(...params);
    if (heading !== undefined || content !== undefined) {
        const updatedRow = db.prepare("SELECT heading, content FROM memory_entries WHERE id = ?").get(entryId);
        generateEmbedding(`${updatedRow.heading}\n${updatedRow.content}`).then((buf) => {
            if (buf) {
                getDb().prepare("UPDATE memory_entries SET embedding = ? WHERE id = ?").run(buf, entryId);
            }
        }).catch(() => { });
    }
    res.json({ ok: true });
});
router.post("/reindex", async (req, res) => {
    const { agent_name = "author", project_id = null, scope_type = null, scope_id = null, } = req.body;
    const available = await isEmbeddingAvailable();
    if (!available) {
        res.status(503).json({ error: "Ollama could not be started automatically. Check bin/ollama exists and model is available." });
        return;
    }
    const db = getDb();
    const scopeFilter = buildScopeFilter(project_id, scope_type, scope_id);
    const rows = db.prepare(`
    SELECT id, heading, content
    FROM memory_entries
    WHERE agent_name = ? AND embedding IS NULL AND status != 'archived' AND ${scopeFilter.sql}
  `).all(agent_name, ...scopeFilter.params);
    let indexed = 0;
    let failed = 0;
    for (const row of rows) {
        const buf = await generateEmbedding(`${row.heading}\n${row.content}`);
        if (buf) {
            db.prepare("UPDATE memory_entries SET embedding = ? WHERE id = ?").run(buf, row.id);
            indexed++;
        }
        else {
            failed++;
        }
    }
    res.json({ total: rows.length, indexed, failed });
});
export default router;
//# sourceMappingURL=memory.js.map