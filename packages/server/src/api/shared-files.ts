import { Router, type Request, type Response } from "express";
import type { Router as RouterType } from "express";
import fs from "node:fs";
import path from "node:path";
import { getDb, type SharedFileRow } from "../db/index.js";
import { SHARED_DIR } from "../config.js";
import { broadcast } from "../ws/handler.js";

const router: RouterType = Router();

const MAX_FILE_SIZE = 1024 * 1024; // 1MB

function sanitizePath(filePath: string): string | null {
  const normalized = path.normalize(filePath).replace(/^\/+/, "");
  if (normalized.includes("..") || path.isAbsolute(normalized)) {
    return null;
  }
  if (!/^[\w][\w\-./]*$/.test(normalized)) {
    return null;
  }
  return normalized;
}

router.get("/", (_req: Request, res: Response) => {
  const db = getDb();
  const files = db
    .prepare("SELECT * FROM shared_files ORDER BY updated_at DESC")
    .all() as SharedFileRow[];
  res.json(files);
});

router.get("/*filePath", (req: Request, res: Response) => {
  const fp = req.params.filePath;
  const rawPath = Array.isArray(fp) ? fp.join("/") : String(fp);
  const safePath = sanitizePath(rawPath);
  if (!safePath) {
    res.status(400).json({ error: "invalid file path" });
    return;
  }

  const fullPath = path.join(SHARED_DIR, safePath);
  if (!fs.existsSync(fullPath)) {
    res.status(404).json({ error: "file not found" });
    return;
  }

  const content = fs.readFileSync(fullPath, "utf-8");
  const db = getDb();
  const meta = db
    .prepare("SELECT * FROM shared_files WHERE path = ?")
    .get(safePath) as SharedFileRow | undefined;

  res.json({
    path: safePath,
    content,
    created_by: meta?.created_by || "unknown",
    description: meta?.description || "",
    updated_at: meta?.updated_at || 0,
  });
});

router.put("/*filePath", (req: Request, res: Response) => {
  const fp = req.params.filePath;
  const rawPath = Array.isArray(fp) ? fp.join("/") : String(fp);
  const safePath = sanitizePath(rawPath);
  if (!safePath) {
    res.status(400).json({ error: "invalid file path" });
    return;
  }

  const { content, created_by, description } = req.body as {
    content?: string;
    created_by?: string;
    description?: string;
  };

  if (typeof content !== "string") {
    res.status(400).json({ error: "content is required" });
    return;
  }

  if (Buffer.byteLength(content, "utf-8") > MAX_FILE_SIZE) {
    res.status(400).json({ error: "file exceeds 1MB limit" });
    return;
  }

  const fullPath = path.join(SHARED_DIR, safePath);
  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  fs.writeFileSync(fullPath, content, "utf-8");

  const db = getDb();
  const now = Date.now();
  const sizeBytes = Buffer.byteLength(content, "utf-8");

  db.prepare(
    `INSERT INTO shared_files (path, created_by, description, updated_at, size_bytes)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(path) DO UPDATE SET
       updated_at = excluded.updated_at,
       size_bytes = excluded.size_bytes,
       description = COALESCE(excluded.description, description)`
  ).run(safePath, created_by || "unknown", description || "", now, sizeBytes);

  broadcast({ type: "file:updated", data: { path: safePath, created_by, updated_at: now } });

  res.json({ success: true, path: safePath });
});

router.delete("/*filePath", (req: Request, res: Response) => {
  const fp = req.params.filePath;
  const rawPath = Array.isArray(fp) ? fp.join("/") : String(fp);
  const safePath = sanitizePath(rawPath);
  if (!safePath) {
    res.status(400).json({ error: "invalid file path" });
    return;
  }

  const fullPath = path.join(SHARED_DIR, safePath);
  if (fs.existsSync(fullPath)) {
    fs.unlinkSync(fullPath);
  }

  const db = getDb();
  db.prepare("DELETE FROM shared_files WHERE path = ?").run(safePath);

  res.json({ success: true });
});

export default router;
