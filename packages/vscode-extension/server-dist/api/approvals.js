import { Router } from "express";
import { getActiveApprovals, getApprovalForAgent, sendApprovalResponse, } from "../tmux-monitor.js";
import { getCodexApproval, getCodexApprovals, respondToCodexApproval, } from "../providers/codex.js";
import { getProvider } from "../agent-runtime.js";
const router = Router();
// GET /api/approvals - List all pending tool approvals
router.get("/", (_req, res) => {
    res.json([...getActiveApprovals(), ...getCodexApprovals()]);
});
// GET /api/approvals/:agentName - Get pending approval for a specific agent
router.get("/:agentName", (req, res) => {
    const { agentName } = req.params;
    const approval = getProvider(agentName) === "codex"
        ? getCodexApproval(agentName)
        : getApprovalForAgent(agentName);
    if (!approval) {
        res.status(404).json({ error: "No pending approval for this agent" });
        return;
    }
    res.json(approval);
});
// POST /api/approvals/:agentName/respond - Respond to a tool approval
router.post("/:agentName/respond", async (req, res) => {
    const { agentName } = req.params;
    const { key } = req.body;
    if (!key) {
        res.status(400).json({ error: "key is required (e.g. '1', '2', '3', 'Escape')" });
        return;
    }
    const provider = getProvider(agentName);
    const approval = provider === "codex"
        ? getCodexApproval(agentName)
        : getApprovalForAgent(agentName);
    if (!approval) {
        res.status(404).json({ error: "No pending approval for this agent" });
        return;
    }
    const ok = provider === "codex"
        ? await respondToCodexApproval(agentName, key)
        : await sendApprovalResponse(agentName, key);
    if (ok) {
        res.json({ ok: true, agentName, key });
    }
    else {
        res.status(500).json({ error: "Failed to send response to agent runtime" });
    }
});
export default router;
//# sourceMappingURL=approvals.js.map