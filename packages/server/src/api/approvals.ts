import { Router, type Request, type Response } from "express";
import type { Router as RouterType } from "express";
import {
  getActiveApprovals,
  getApprovalForAgent,
  sendApprovalResponse,
} from "../tmux-monitor.js";

const router: RouterType = Router();

// GET /api/approvals - List all pending tool approvals
router.get("/", (_req: Request, res: Response) => {
  res.json(getActiveApprovals());
});

// GET /api/approvals/:agentName - Get pending approval for a specific agent
router.get("/:agentName", (req: Request, res: Response) => {
  const { agentName } = req.params;
  const approval = getApprovalForAgent(agentName as string);
  if (!approval) {
    res.status(404).json({ error: "No pending approval for this agent" });
    return;
  }
  res.json(approval);
});

// POST /api/approvals/:agentName/respond - Respond to a tool approval
router.post("/:agentName/respond", async (req: Request, res: Response) => {
  const { agentName } = req.params;
  const { key } = req.body as { key?: string };

  if (!key) {
    res.status(400).json({ error: "key is required (e.g. '1', '2', '3', 'Escape')" });
    return;
  }

  const approval = getApprovalForAgent(agentName as string);
  if (!approval) {
    res.status(404).json({ error: "No pending approval for this agent" });
    return;
  }

  const ok = await sendApprovalResponse(agentName as string, key);
  if (ok) {
    res.json({ ok: true, agentName, key });
  } else {
    res.status(500).json({ error: "Failed to send response to agent tmux session" });
  }
});

export default router;
