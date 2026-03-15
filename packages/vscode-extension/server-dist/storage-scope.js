import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DATA_DIR } from "./config.js";
import { getDb } from "./db/index.js";
import { broadcast } from "./ws/handler.js";
function slugify(name) {
    return name
        .toLowerCase()
        .replace(/[^a-z0-9\u4e00-\u9fff]+/g, "-")
        .replace(/^-|-$/g, "")
        .slice(0, 64);
}
export function isCanonicalArtifactPath(filePath) {
    const normalized = filePath.toLowerCase();
    if (normalized === "readme.md" || normalized === "claude.md" || normalized === "agents.md") {
        return true;
    }
    return /^(docs\/|specs?\/|architecture\/|design\/|standards\/|src\/|app\/|packages\/)/.test(normalized);
}
export function getProjectById(projectId) {
    const db = getDb();
    return db.prepare("SELECT * FROM projects WHERE id = ?").get(projectId) || null;
}
export function getWorkplaceById(workplaceId) {
    const db = getDb();
    return db.prepare("SELECT * FROM workplaces WHERE id = ?").get(workplaceId) || null;
}
export function listWorkplacesForProject(projectId) {
    const db = getDb();
    return db
        .prepare("SELECT * FROM workplaces WHERE project_id = ? AND status = 'active' ORDER BY updated_at DESC")
        .all(projectId);
}
function ensureWorkplaceChannel(project, workplace) {
    const db = getDb();
    const channelId = `workplace-${project.slug}-${workplace.slug}`;
    const existing = db.prepare("SELECT 1 FROM channels WHERE id = ?").get(channelId);
    if (existing) {
        return;
    }
    db.prepare(`
    INSERT INTO channels (id, name, description, status, type, project_id, workplace_id, created_at, updated_at)
    VALUES (?, ?, ?, 'active', 'public', ?, ?, ?, ?)
  `).run(channelId, `${project.name}/${workplace.name}`, `Workplace channel for ${project.name} - ${workplace.name}`, project.id, workplace.id, workplace.created_at, workplace.updated_at);
    broadcast({
        type: "channel:created",
        data: {
            id: channelId,
            name: `${project.name}/${workplace.name}`,
            description: `Workplace channel for ${project.name} - ${workplace.name}`,
            status: "active",
            type: "public",
            project_id: project.id,
            workplace_id: workplace.id,
            members: null,
            created_at: workplace.created_at,
            updated_at: workplace.updated_at,
        },
    });
}
export function ensureDefaultWorkplace(projectId) {
    const db = getDb();
    const existing = db.prepare("SELECT * FROM workplaces WHERE project_id = ? AND slug = 'default'").get(projectId);
    if (existing) {
        fs.mkdirSync(existing.directory, { recursive: true });
        const project = getProjectById(projectId);
        if (project) {
            ensureWorkplaceChannel(project, existing);
        }
        return existing;
    }
    const project = getProjectById(projectId);
    if (!project) {
        throw new Error(`Project not found: ${projectId}`);
    }
    const now = Date.now();
    const id = crypto.randomUUID();
    const slug = "default";
    const directory = path.join(project.directory, ".claude-crew", "workplaces", slug);
    fs.mkdirSync(directory, { recursive: true });
    db.prepare(`
    INSERT INTO workplaces (id, project_id, name, slug, status, directory, kind, created_at, updated_at)
    VALUES (?, ?, 'Default Workplace', ?, 'active', ?, 'derived', ?, ?)
  `).run(id, projectId, slug, directory, now, now);
    const workplace = db.prepare("SELECT * FROM workplaces WHERE id = ?").get(id);
    ensureWorkplaceChannel(project, workplace);
    return workplace;
}
export function resolveScope(input) {
    const explicitScopeType = input.scopeType === "project" || input.scopeType === "workplace" || input.scopeType === "global"
        ? input.scopeType
        : undefined;
    const explicitScopeId = input.scopeId || "";
    if (explicitScopeType === "global") {
        return {
            scopeType: "global",
            scopeId: "",
            projectId: null,
            workplaceId: null,
            directory: path.join(DATA_DIR, "shared"),
            project: null,
            workplace: null,
        };
    }
    if ((explicitScopeType === "workplace" && explicitScopeId) || input.workplaceId) {
        const workplace = getWorkplaceById(explicitScopeId || input.workplaceId || "");
        if (!workplace) {
            throw new Error(`Workplace not found: ${explicitScopeId || input.workplaceId}`);
        }
        fs.mkdirSync(workplace.directory, { recursive: true });
        const project = getProjectById(workplace.project_id);
        return {
            scopeType: "workplace",
            scopeId: workplace.id,
            projectId: workplace.project_id,
            workplaceId: workplace.id,
            directory: workplace.directory,
            project,
            workplace,
        };
    }
    const projectId = explicitScopeType === "project"
        ? explicitScopeId
        : input.projectId || "";
    if (projectId) {
        const project = getProjectById(projectId);
        if (!project) {
            throw new Error(`Project not found: ${projectId}`);
        }
        const intent = input.intent || "derived";
        if (explicitScopeType === "project" || intent === "canonical") {
            fs.mkdirSync(project.directory, { recursive: true });
            return {
                scopeType: "project",
                scopeId: project.id,
                projectId: project.id,
                workplaceId: null,
                directory: project.directory,
                project,
                workplace: null,
            };
        }
        const workplace = ensureDefaultWorkplace(project.id);
        return {
            scopeType: "workplace",
            scopeId: workplace.id,
            projectId: project.id,
            workplaceId: workplace.id,
            directory: workplace.directory,
            project,
            workplace,
        };
    }
    return {
        scopeType: "global",
        scopeId: "",
        projectId: null,
        workplaceId: null,
        directory: path.join(DATA_DIR, "shared"),
        project: null,
        workplace: null,
    };
}
export function inferScopeIntent(filePath, explicitKind) {
    if (explicitKind === "canonical" || explicitKind === "core")
        return "canonical";
    if (explicitKind === "derived" || explicitKind === "artifact")
        return "derived";
    return isCanonicalArtifactPath(filePath) ? "canonical" : "derived";
}
export function inferMemoryIntent(category, explicitKind) {
    if (explicitKind === "canonical" || explicitKind === "core")
        return "canonical";
    if (explicitKind === "derived" || explicitKind === "artifact")
        return "derived";
    return category === "decision" || category === "project" ? "canonical" : "derived";
}
export function listProjectScopeIds(projectId) {
    const workplaces = listWorkplacesForProject(projectId);
    return {
        projectId,
        workplaceIds: workplaces.map((w) => w.id),
    };
}
//# sourceMappingURL=storage-scope.js.map