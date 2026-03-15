/**
 * Claude runtime provider.
 *
 * Wraps tmux-based session management for Claude Code agents.
 * Delegates to tmux-monitor for state tracking and to agents.ts
 * for verified session startup.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { PROJECT_ROOT } from "../config.js";
import { findBinary } from "../utils/find-binary.js";
import { getAgentTmuxState, getAgentTerminalContent, getAgentContextPercent, getActiveApprovals, getApprovalForAgent, sendApprovalResponse, } from "../tmux-monitor.js";
import { startVerifiedClaudeSession } from "../api/agents.js";
const execFileAsync = promisify(execFile);
function mapTmuxState(state) {
    switch (state) {
        case "idle":
        case "busy":
        case "approval_pending":
        case "no_session":
            return state;
        default:
            return "no_session";
    }
}
export const claudeProvider = {
    name: "claude",
    async start(agentName) {
        const claudePath = findBinary("claude");
        if (!claudePath) {
            throw new Error("Claude CLI not found in PATH");
        }
        const agentDir = path.join(PROJECT_ROOT, "agents", agentName);
        await startVerifiedClaudeSession(agentDir, claudePath, agentName);
    },
    async stop(agentName) {
        const session = `crew-${agentName}`;
        try {
            await execFileAsync("tmux", ["kill-session", "-t", session]);
        }
        catch {
            // Session may not exist
        }
        // Kill any lingering bridge processes
        try {
            const { stdout } = await execFileAsync("pgrep", ["-f", `crew-bridge-${agentName}`]);
            const pids = stdout.trim().split("\n").filter(Boolean);
            for (const pid of pids) {
                try {
                    process.kill(parseInt(pid, 10), "SIGTERM");
                }
                catch { /* ignore */ }
            }
        }
        catch {
            // No processes found
        }
    },
    async restart(agentName, options) {
        await this.stop(agentName);
        // Brief pause to let session cleanup complete
        await new Promise((r) => setTimeout(r, 1000));
        const claudePath = findBinary("claude");
        if (!claudePath) {
            throw new Error("Claude CLI not found in PATH");
        }
        const agentDir = path.join(PROJECT_ROOT, "agents", agentName);
        await startVerifiedClaudeSession(agentDir, claudePath, agentName, {
            forceNewSession: options?.resetSession,
        });
    },
    getState(agentName) {
        return mapTmuxState(getAgentTmuxState(agentName));
    },
    getTerminalContent(agentName) {
        return getAgentTerminalContent(agentName);
    },
    getContextPercent(agentName) {
        return getAgentContextPercent(agentName);
    },
    async interrupt(agentName) {
        try {
            await execFileAsync("tmux", ["send-keys", "-t", `crew-${agentName}`, "C-c"]);
            return true;
        }
        catch {
            return false;
        }
    },
    async resume(agentName) {
        try {
            await execFileAsync("tmux", [
                "send-keys", "-t", `crew-${agentName}`,
                "Please continue from the current task and report back in chat.",
                "Enter",
            ]);
            return true;
        }
        catch {
            return false;
        }
    },
    async sendInput(agentName, input, type) {
        const session = `crew-${agentName}`;
        if (type === "key") {
            await execFileAsync("tmux", ["send-keys", "-t", session, input]);
        }
        else {
            await execFileAsync("tmux", ["send-keys", "-t", session, input, "Enter"]);
        }
    },
    getApproval(agentName) {
        const approval = getApprovalForAgent(agentName);
        if (!approval)
            return undefined;
        return {
            agentName: approval.agentName,
            key: approval.id,
            toolServer: approval.toolServer,
            toolName: approval.toolName,
            params: approval.params,
            description: approval.description,
        };
    },
    getApprovals() {
        return getActiveApprovals().map((a) => ({
            agentName: a.agentName,
            key: a.id,
            toolServer: a.toolServer,
            toolName: a.toolName,
            params: a.params,
            description: a.description,
        }));
    },
    async respondToApproval(agentName, key) {
        return sendApprovalResponse(agentName, key);
    },
};
//# sourceMappingURL=claude.js.map