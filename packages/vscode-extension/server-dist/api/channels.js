import { Router } from "express";
import { getDb } from "../db/index.js";
import { broadcast } from "../ws/handler.js";
const router = Router();
// Helper: parse members from DB row
function parseChannel(ch) {
    return { ...ch, members: ch.members ? JSON.parse(ch.members) : null };
}
// GET /channels
router.get("/", (req, res) => {
    const status = req.query.status;
    const project_id = req.query.project_id;
    const db = getDb();
    let sql = "SELECT * FROM channels WHERE 1=1";
    const params = [];
    if (status) {
        sql += " AND status = ?";
        params.push(status);
    }
    if (project_id) {
        sql += " AND project_id = ?";
        params.push(project_id);
    }
    sql += " ORDER BY type ASC, created_at ASC";
    const channels = db.prepare(sql).all(...params);
    res.json(channels.map(parseChannel));
});
// POST /channels - create public or group channel
router.post("/", (req, res) => {
    const { name, description, type, members, project_id, workplace_id } = req.body;
    if (!name || typeof name !== "string") {
        res.status(400).json({ error: "name is required" });
        return;
    }
    const db = getDb();
    const id = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
    const now = Date.now();
    const channelType = type || "public";
    const membersJson = members && members.length > 0 ? JSON.stringify(members) : null;
    const existing = db.prepare("SELECT 1 FROM channels WHERE id = ? OR name = ?").get(id, name);
    if (existing) {
        res.status(409).json({ error: "channel already exists" });
        return;
    }
    db.prepare("INSERT INTO channels (id, name, description, type, members, project_id, workplace_id, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)").run(id, name, description || "", channelType, membersJson, project_id || null, workplace_id || null, now, now);
    const channel = { id, name, description: description || "", status: "active", type: channelType, members: members || null, project_id: project_id || null, workplace_id: workplace_id || null, created_at: now, updated_at: now };
    broadcast({ type: "channel:created", data: channel });
    res.json(channel);
});
// POST /channels/dm/:agentName - create or open DM channel
router.post("/dm/:agentName", (req, res) => {
    const { agentName } = req.params;
    const db = getDb();
    const id = `dm-${agentName}`;
    const existing = db.prepare("SELECT * FROM channels WHERE id = ?").get(id);
    if (existing) {
        // Ensure active
        if (existing.status !== "active") {
            db.prepare("UPDATE channels SET status = 'active', updated_at = ? WHERE id = ?").run(Date.now(), id);
        }
        res.json(parseChannel(existing));
        return;
    }
    const now = Date.now();
    db.prepare("INSERT INTO channels (id, name, description, type, members, status, created_at, updated_at) VALUES (?, ?, ?, 'dm', ?, 'active', ?, ?)").run(id, agentName, "", JSON.stringify([agentName]), now, now);
    const channel = { id, name: agentName, description: "", type: "dm", members: [agentName], status: "active", created_at: now, updated_at: now };
    broadcast({ type: "channel:created", data: channel });
    res.json(channel);
});
// POST /channels/:id/members - add member to group
router.post("/:id/members", (req, res) => {
    const { id } = req.params;
    const { name } = req.body;
    if (!name) {
        res.status(400).json({ error: "name is required" });
        return;
    }
    const db = getDb();
    const ch = db.prepare("SELECT * FROM channels WHERE id = ?").get(id);
    if (!ch) {
        res.status(404).json({ error: "channel not found" });
        return;
    }
    if (ch.type !== "group") {
        res.status(400).json({ error: "can only manage members on group channels" });
        return;
    }
    const members = ch.members ? JSON.parse(ch.members) : [];
    if (members.includes(name)) {
        res.json(parseChannel(ch));
        return;
    }
    members.push(name);
    const now = Date.now();
    db.prepare("UPDATE channels SET members = ?, updated_at = ? WHERE id = ?").run(JSON.stringify(members), now, id);
    const updated = { ...ch, members: JSON.stringify(members), updated_at: now };
    broadcast({ type: "channel:updated", data: parseChannel(updated) });
    res.json(parseChannel(updated));
});
// DELETE /channels/:id/members/:name - remove member from group
router.delete("/:id/members/:name", (req, res) => {
    const { id, name } = req.params;
    const db = getDb();
    const ch = db.prepare("SELECT * FROM channels WHERE id = ?").get(id);
    if (!ch) {
        res.status(404).json({ error: "channel not found" });
        return;
    }
    if (ch.type !== "group") {
        res.status(400).json({ error: "can only manage members on group channels" });
        return;
    }
    const members = ch.members ? JSON.parse(ch.members) : [];
    const newMembers = members.filter(m => m !== name);
    const now = Date.now();
    db.prepare("UPDATE channels SET members = ?, updated_at = ? WHERE id = ?").run(JSON.stringify(newMembers), now, id);
    const updated = { ...ch, members: JSON.stringify(newMembers), updated_at: now };
    broadcast({ type: "channel:updated", data: parseChannel(updated) });
    res.json(parseChannel(updated));
});
// PUT /channels/:id
router.put("/:id", (req, res) => {
    const { id } = req.params;
    const { name, description, status } = req.body;
    const db = getDb();
    const existing = db.prepare("SELECT * FROM channels WHERE id = ?").get(id);
    if (!existing) {
        res.status(404).json({ error: "channel not found" });
        return;
    }
    const now = Date.now();
    db.prepare("UPDATE channels SET name = ?, description = ?, status = ?, updated_at = ? WHERE id = ?").run(name || existing.name, description !== undefined ? description : existing.description, status || existing.status, now, id);
    const updated = { ...existing, name: name || existing.name, description: description !== undefined ? description : existing.description, status: status || existing.status, updated_at: now };
    broadcast({ type: "channel:updated", data: parseChannel(updated) });
    res.json(parseChannel(updated));
});
// DELETE /channels/:id
router.delete("/:id", (req, res) => {
    const { id } = req.params;
    if (id === "general") {
        res.status(400).json({ error: "cannot delete the general channel" });
        return;
    }
    const db = getDb();
    // Delete in FK-safe order: pending_mentions -> messages -> channel
    db.prepare("DELETE FROM pending_mentions WHERE message_id IN (SELECT id FROM messages WHERE channel_id = ?)").run(id);
    db.prepare("DELETE FROM messages WHERE channel_id = ?").run(id);
    db.prepare("DELETE FROM channels WHERE id = ?").run(id);
    broadcast({ type: "channel:deleted", data: { id } });
    res.json({ ok: true });
});
export default router;
//# sourceMappingURL=channels.js.map