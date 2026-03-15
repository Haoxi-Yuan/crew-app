import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { Router } from "express";
import { getDb } from "../db/index.js";
import { getProjectById, getWorkplaceById, inferScopeIntent, listProjectScopeIds, resolveScope, } from "../storage-scope.js";
import { broadcast } from "../ws/handler.js";
const router = Router();
const MAX_FILE_SIZE = 1024 * 1024;
function sanitizePath(filePath) {
    const normalized = path.normalize(filePath).replace(/^\/+/, "");
    if (normalized.includes("..") || path.isAbsolute(normalized))
        return null;
    if (!/^[\w][\w\-./]*$/.test(normalized))
        return null;
    return normalized;
}
function buildScopeSql(projectId, scopeType, scopeId) {
    if (scopeType && (scopeType === "global" || scopeType === "project" || scopeType === "workplace")) {
        return {
            sql: "scope_type = ? AND scope_id = ?",
            params: [scopeType, scopeType === "global" ? "" : (scopeId || "")],
        };
    }
    if (projectId) {
        const scopes = listProjectScopeIds(projectId);
        const placeholders = scopes.workplaceIds.map(() => "?").join(", ");
        const workplaceClause = scopes.workplaceIds.length > 0
            ? ` OR (scope_type = 'workplace' AND scope_id IN (${placeholders}))`
            : "";
        return {
            sql: `(scope_type = 'project' AND scope_id = ?${workplaceClause})`,
            params: [projectId, ...scopes.workplaceIds],
        };
    }
    return { sql: "scope_type = 'global' AND scope_id = ''", params: [] };
}
function findScopedRow(pathValue, projectId, scopeType, scopeId) {
    const db = getDb();
    if (scopeType) {
        return db.prepare("SELECT * FROM shared_files WHERE path = ? AND scope_type = ? AND scope_id = ?")
            .get(pathValue, scopeType, scopeType === "global" ? "" : (scopeId || "")) || null;
    }
    if (projectId) {
        const scopeSql = buildScopeSql(projectId);
        const rows = db.prepare(`
      SELECT *
      FROM shared_files
      WHERE path = ? AND ${scopeSql.sql}
      ORDER BY scope_type = 'workplace' DESC, updated_at DESC
    `).all(pathValue, ...scopeSql.params);
        if (rows.length === 1)
            return rows[0];
        if (rows.length > 1) {
            throw new Error(`ambiguous file path "${pathValue}" across project/workplace scopes`);
        }
        return null;
    }
    return db.prepare("SELECT * FROM shared_files WHERE path = ? AND scope_type = 'global' AND scope_id = ''")
        .get(pathValue) || null;
}
function inferProjectFromAuthor(createdBy) {
    if (!createdBy || createdBy === "user" || createdBy === "unknown")
        return null;
    const db = getDb();
    const row = db.prepare(`
    SELECT project_id
    FROM project_agents
    WHERE agent_name = ? AND status = 'active'
    ORDER BY assigned_at DESC
    LIMIT 1
  `).get(createdBy);
    return row?.project_id || null;
}
function decorateFile(row) {
    if (row.scope_type === "project") {
        const project = getProjectById(row.scope_id);
        return {
            ...row,
            project_id: project?.id || null,
            workplace_id: null,
            scope_name: project?.name || "Project",
        };
    }
    if (row.scope_type === "workplace") {
        const workplace = getWorkplaceById(row.scope_id);
        return {
            ...row,
            project_id: workplace?.project_id || null,
            workplace_id: workplace?.id || null,
            scope_name: workplace?.name || "Workplace",
        };
    }
    return {
        ...row,
        project_id: null,
        workplace_id: null,
        scope_name: "Global",
    };
}
router.get("/", (req, res) => {
    const projectId = req.query.project_id;
    const scopeType = req.query.scope_type;
    const scopeId = req.query.scope_id;
    const db = getDb();
    const scopeSql = buildScopeSql(projectId, scopeType, scopeId);
    const rows = db.prepare(`
    SELECT *
    FROM shared_files
    WHERE ${scopeSql.sql}
    ORDER BY updated_at DESC
  `).all(...scopeSql.params);
    res.json(rows.map(decorateFile));
});
router.get("/*filePath", (req, res) => {
    const fp = req.params.filePath;
    const rawPath = Array.isArray(fp) ? fp.join("/") : String(fp);
    const safePath = sanitizePath(rawPath);
    if (!safePath) {
        res.status(400).json({ error: "invalid file path" });
        return;
    }
    let resolvedScope;
    try {
        const matchedRow = findScopedRow(safePath, req.query.project_id, req.query.scope_type, req.query.scope_id);
        resolvedScope = resolveScope({
            scopeType: matchedRow?.scope_type || req.query.scope_type,
            scopeId: matchedRow?.scope_id || req.query.scope_id,
            projectId: req.query.project_id,
            workplaceId: req.query.workplace_id,
            intent: "derived",
        });
    }
    catch (err) {
        res.status(400).json({ error: err.message });
        return;
    }
    const fullPath = path.join(resolvedScope.directory, safePath);
    if (!fs.existsSync(fullPath)) {
        res.status(404).json({ error: "file not found" });
        return;
    }
    const db = getDb();
    const meta = db.prepare(`
    SELECT *
    FROM shared_files
    WHERE path = ? AND scope_type = ? AND scope_id = ?
  `).get(safePath, resolvedScope.scopeType, resolvedScope.scopeId);
    const decorated = meta ? decorateFile(meta) : null;
    res.json({
        path: safePath,
        content: fs.readFileSync(fullPath, "utf-8"),
        created_by: meta?.created_by || "unknown",
        description: meta?.description || "",
        updated_at: meta?.updated_at || 0,
        size_bytes: meta?.size_bytes || 0,
        scope_type: resolvedScope.scopeType,
        scope_id: resolvedScope.scopeId,
        project_id: decorated?.project_id || resolvedScope.projectId,
        workplace_id: decorated?.workplace_id || resolvedScope.workplaceId,
        scope_name: decorated?.scope_name || null,
    });
});
router.put("/*filePath", (req, res) => {
    const fp = req.params.filePath;
    const rawPath = Array.isArray(fp) ? fp.join("/") : String(fp);
    const safePath = sanitizePath(rawPath);
    if (!safePath) {
        res.status(400).json({ error: "invalid file path" });
        return;
    }
    const { content, created_by, description, project_id, workplace_id, scope_type, scope_id, artifact_kind, } = req.body;
    if (typeof content !== "string") {
        res.status(400).json({ error: "content is required" });
        return;
    }
    if (Buffer.byteLength(content, "utf-8") > MAX_FILE_SIZE) {
        res.status(400).json({ error: "file exceeds 1MB limit" });
        return;
    }
    let resolvedScope;
    try {
        resolvedScope = resolveScope({
            scopeType: scope_type,
            scopeId: scope_id,
            projectId: project_id || inferProjectFromAuthor(created_by),
            workplaceId: workplace_id,
            intent: inferScopeIntent(safePath, artifact_kind),
        });
    }
    catch (err) {
        res.status(400).json({ error: err.message });
        return;
    }
    const fullPath = path.join(resolvedScope.directory, safePath);
    fs.mkdirSync(path.dirname(fullPath), { recursive: true });
    fs.writeFileSync(fullPath, content, "utf-8");
    const db = getDb();
    const now = Date.now();
    const sizeBytes = Buffer.byteLength(content, "utf-8");
    const existing = db.prepare(`
    SELECT id
    FROM shared_files
    WHERE path = ? AND scope_type = ? AND scope_id = ?
  `).get(safePath, resolvedScope.scopeType, resolvedScope.scopeId);
    const fileId = existing?.id || crypto.randomUUID();
    db.prepare(`
    INSERT INTO shared_files (id, path, scope_type, scope_id, created_by, description, updated_at, size_bytes, metadata)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      path = excluded.path,
      scope_type = excluded.scope_type,
      scope_id = excluded.scope_id,
      created_by = excluded.created_by,
      description = excluded.description,
      updated_at = excluded.updated_at,
      size_bytes = excluded.size_bytes,
      metadata = excluded.metadata
  `).run(fileId, safePath, resolvedScope.scopeType, resolvedScope.scopeId, created_by || "unknown", description || "", now, sizeBytes, JSON.stringify({
        project_id: resolvedScope.projectId,
        workplace_id: resolvedScope.workplaceId,
    }));
    broadcast({
        type: "file:updated",
        data: {
            id: fileId,
            path: safePath,
            scope_type: resolvedScope.scopeType,
            scope_id: resolvedScope.scopeId,
            project_id: resolvedScope.projectId,
            workplace_id: resolvedScope.workplaceId,
            updated_at: now,
        },
    });
    res.json({
        success: true,
        id: fileId,
        path: safePath,
        scope_type: resolvedScope.scopeType,
        scope_id: resolvedScope.scopeId,
        project_id: resolvedScope.projectId,
        workplace_id: resolvedScope.workplaceId,
    });
});
router.delete("/*filePath", (req, res) => {
    const fp = req.params.filePath;
    const rawPath = Array.isArray(fp) ? fp.join("/") : String(fp);
    const safePath = sanitizePath(rawPath);
    if (!safePath) {
        res.status(400).json({ error: "invalid file path" });
        return;
    }
    let resolvedScope;
    try {
        const matchedRow = findScopedRow(safePath, req.query.project_id, req.query.scope_type, req.query.scope_id);
        resolvedScope = resolveScope({
            scopeType: matchedRow?.scope_type || req.query.scope_type,
            scopeId: matchedRow?.scope_id || req.query.scope_id,
            projectId: req.query.project_id,
            workplaceId: req.query.workplace_id,
            intent: "derived",
        });
    }
    catch (err) {
        res.status(400).json({ error: err.message });
        return;
    }
    const fullPath = path.join(resolvedScope.directory, safePath);
    if (fs.existsSync(fullPath)) {
        fs.unlinkSync(fullPath);
    }
    const db = getDb();
    db.prepare(`
    DELETE FROM shared_files
    WHERE path = ? AND scope_type = ? AND scope_id = ?
  `).run(safePath, resolvedScope.scopeType, resolvedScope.scopeId);
    res.json({ success: true });
});
export default router;
//# sourceMappingURL=shared-files.js.map