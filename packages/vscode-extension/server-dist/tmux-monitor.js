import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import path from "node:path";
import { broadcast } from "./ws/handler.js";
import { getDb } from "./db/index.js";
import { PROJECT_ROOT, SESSION_AUTO_CYCLE_CONTEXT_PERCENT, SESSION_AUTO_CYCLE_COOLDOWN_MS, MONITOR_INTERVAL_MS, CAPTURE_LINES, } from "./config.js";
import { findBinary } from "./utils/find-binary.js";
import { startVerifiedClaudeSession } from "./api/agents.js";
const execFileAsync = promisify(execFile);
// In-memory store of active approvals (keyed by agentName since one agent can only have one prompt at a time)
const activeApprovals = new Map();
const agentStates = new Map();
// In-memory store of terminal content and context percent per agent
const agentTerminalContent = new Map();
const agentContextPercent = new Map();
let approvalIdCounter = 0;
export function getActiveApprovals() {
    return Array.from(activeApprovals.values());
}
export function getApprovalForAgent(agentName) {
    return activeApprovals.get(agentName);
}
export function removeApproval(agentName) {
    activeApprovals.delete(agentName);
}
export function getAgentTmuxState(agentName) {
    return agentStates.get(agentName) || "no_session";
}
export function getAllAgentTmuxStates() {
    return new Map(agentStates);
}
export function getAgentContextPercent(agentName) {
    return agentContextPercent.get(agentName) || 0;
}
export function getAllAgentContextPercents() {
    return new Map(agentContextPercent);
}
export function getAgentTerminalContent(agentName) {
    return agentTerminalContent.get(agentName) || "";
}
/**
 * Parse context usage percentage from Claude Code terminal output.
 *
 * Claude Code shows context in several ways:
 * - Compaction message: "context window XX% full" or "XX% context"
 * - Status bar dots: filled squares (U+25AA) indicate usage level
 * - Token display: "120k/200k tokens"
 */
function parseContextPercent(paneContent) {
    // Direct percentage patterns (compaction messages)
    const percentMatch = paneContent.match(/(\d{1,3})%\s*context/i)
        || paneContent.match(/context[:\s]+(\d{1,3})%/i)
        || paneContent.match(/(\d{1,3})%\s*full/i)
        || paneContent.match(/compacting.*?(\d{1,3})%/i);
    if (percentMatch) {
        const val = parseInt(percentMatch[1]);
        if (val >= 0 && val <= 100)
            return val;
    }
    // Token count pattern: "120k/200k" or "120,000/200,000"
    const tokenMatch = paneContent.match(/([\d,.]+)k?\s*\/\s*([\d,.]+)k?\s*tokens?/i);
    if (tokenMatch) {
        let used = parseFloat(tokenMatch[1].replace(/,/g, ""));
        let total = parseFloat(tokenMatch[2].replace(/,/g, ""));
        if (tokenMatch[1].includes("k") || tokenMatch[0].toLowerCase().includes("k")) {
            // already in k
        }
        if (total > 0) {
            const pct = Math.round((used / total) * 100);
            if (pct >= 0 && pct <= 100)
                return pct;
        }
    }
    // Status bar filled squares: count filled (U+25AA or similar) vs total dots
    // Claude Code uses a pattern like: ──── ▪▪▪ ─ (3 filled of ~5 possible)
    const dotMatch = paneContent.match(/[\u2500]+\s*([\u25AA\u25AB\u2022\u25CF\u25CB\u2B24]+)\s*[\u2500]+/);
    if (dotMatch) {
        const dots = dotMatch[1];
        const filled = (dots.match(/[\u25AA\u2022\u25CF\u2B24]/g) || []).length;
        const total = dots.length;
        if (total > 0) {
            return Math.round((filled / total) * 100);
        }
    }
    return null;
}
function detectApprovalType(paneContent) {
    if (paneContent.includes("Do you want to proceed?"))
        return "tool_use";
    if (paneContent.includes("Do you want to make this edit"))
        return "file_edit";
    if (paneContent.includes("Do you want to create"))
        return "file_create";
    if (paneContent.includes("Do you want to execute"))
        return "bash";
    if (paneContent.includes("Would you like to proceed?"))
        return "plan_execute";
    if (paneContent.includes("How is Claude doing this session?"))
        return "session_feedback";
    if (paneContent.includes("Enter to confirm") && paneContent.includes("MCP server"))
        return "mcp_setup";
    return null;
}
function parseApprovalPrompt(paneContent, agentName) {
    const promptType = detectApprovalType(paneContent);
    if (!promptType)
        return null;
    let toolServer = "unknown";
    let toolName = "unknown";
    let params = "";
    let description = "";
    if (promptType === "tool_use") {
        const toolMatch = paneContent.match(/(?:Tool use\s*\n?\s*)([\w-]+)\s*-\s*([\w_]+)\(([^)]*(?:\([^)]*\))*[^)]*)\)\s*\(MCP\)/s);
        if (toolMatch) {
            toolServer = toolMatch[1].trim();
            toolName = toolMatch[2].trim();
            params = toolMatch[3].trim();
        }
        else {
            const simpleMatch = paneContent.match(/([\w-]+)\s*-\s*([\w_]+)\(/);
            if (simpleMatch) {
                toolServer = simpleMatch[1].trim();
                toolName = simpleMatch[2].trim();
            }
        }
        const descMatch = paneContent.match(/\(MCP\)\s*\n\s*([\s\S]*?)\n\s*Do you want to proceed\?/);
        if (descMatch) {
            description = descMatch[1].trim().replace(/\s+/g, " ");
        }
    }
    else if (promptType === "file_edit") {
        toolServer = "claude";
        toolName = "Edit";
        const fileMatch = paneContent.match(/Do you want to make this edit to\s+(.+?)\s*\?/);
        if (fileMatch) {
            params = fileMatch[1].trim();
            description = `Edit file: ${params}`;
        }
    }
    else if (promptType === "file_create") {
        toolServer = "claude";
        toolName = "Create";
        const fileMatch = paneContent.match(/Do you want to create\s+(.+?)\s*\?/);
        if (fileMatch) {
            params = fileMatch[1].trim();
            description = `Create file: ${params}`;
        }
    }
    else if (promptType === "bash") {
        toolServer = "claude";
        toolName = "Bash";
        const cmdMatch = paneContent.match(/Do you want to execute\s+(.+?)\s*\?/);
        if (cmdMatch) {
            params = cmdMatch[1].trim();
        }
        description = "Execute bash command";
    }
    else if (promptType === "plan_execute") {
        toolServer = "claude";
        toolName = "Plan Execute";
        description = "Claude has written up a plan and is ready to execute.";
    }
    else if (promptType === "session_feedback") {
        toolServer = "claude";
        toolName = "Session Feedback";
        description = "Claude is asking for session feedback rating.";
    }
    else if (promptType === "mcp_setup") {
        toolServer = "system";
        toolName = "MCP Server Setup";
        description = "Claude Code is asking to enable the MCP server for this agent.";
        const serverMatch = paneContent.match(/MCP Server:\s*([\w-]+)/i) ||
            paneContent.match(/claude-crew/);
        if (serverMatch) {
            params = `server: ${serverMatch[0]}`;
        }
        else {
            params = "MCP server activation";
        }
    }
    // Extract numbered options from pane content
    const options = [];
    const optionRegex = /(\d+)\.\s+(.+?)(?=\n\s*\d+\.|\n\s*Esc|\n\s*Enter|\n\s*$)/gs;
    // Find the section with options (after the last occurrence of a question/instruction)
    const anchorIdx = Math.max(paneContent.lastIndexOf("Do you want to proceed?"), paneContent.lastIndexOf("Do you want to make this edit"), paneContent.lastIndexOf("Do you want to create"), paneContent.lastIndexOf("Do you want to execute"), paneContent.lastIndexOf("Would you like to proceed?"), paneContent.lastIndexOf("How is Claude doing this session?"), paneContent.lastIndexOf("Enter to confirm"), paneContent.lastIndexOf("MCP documentation"));
    const optionSection = anchorIdx >= 0 ? paneContent.slice(Math.max(0, anchorIdx - 300)) : paneContent;
    let optMatch;
    while ((optMatch = optionRegex.exec(optionSection)) !== null) {
        options.push({
            key: optMatch[1],
            label: optMatch[2].trim().replace(/\s+/g, " "),
        });
    }
    // For session feedback, parse the "1: Bad  2: Fine  3: Good  0: Dismiss" format
    if (promptType === "session_feedback" && options.length === 0) {
        const feedbackRegex = /(\d+):\s*(\w+)/g;
        let fbMatch;
        const fbSection = paneContent.slice(Math.max(0, paneContent.lastIndexOf("How is Claude doing")));
        while ((fbMatch = feedbackRegex.exec(fbSection)) !== null) {
            options.push({ key: fbMatch[1], label: fbMatch[2] });
        }
    }
    // Defaults if parsing failed
    if (options.length === 0) {
        if (promptType === "mcp_setup") {
            options.push({ key: "1", label: "Use this and all future MCP servers in this project" }, { key: "2", label: "Use this MCP server" }, { key: "3", label: "Continue without using this MCP server" });
        }
        else if (promptType === "session_feedback") {
            options.push({ key: "1", label: "Bad" }, { key: "2", label: "Fine" }, { key: "3", label: "Good" }, { key: "0", label: "Dismiss" });
        }
        else if (promptType === "plan_execute") {
            options.push({ key: "1", label: "Yes, clear context and auto-accept edits" }, { key: "2", label: "Yes, auto-accept edits" }, { key: "3", label: "Yes, manually approve edits" }, { key: "4", label: "Edit plan" });
        }
        else {
            options.push({ key: "1", label: "Yes" }, { key: "2", label: "Yes, and don't ask again" }, { key: "3", label: "No" });
        }
    }
    const displayParams = params.length > 300 ? params.slice(0, 300) + "..." : params;
    return {
        id: `approval-${agentName}-${++approvalIdCounter}`,
        agentName,
        toolServer,
        toolName,
        params: displayParams,
        description,
        options,
        promptType: promptType === "mcp_setup" ? "mcp_setup" : "tool_use",
        detectedAt: Date.now(),
    };
}
/**
 * Detect the state of a Claude Code session from tmux pane content.
 */
function detectState(paneContent) {
    // Check for any approval prompt type
    if (detectApprovalType(paneContent) !== null) {
        return "approval_pending";
    }
    const lines = paneContent.trim().split("\n");
    const lastFewLines = lines.slice(-5).join("\n");
    if (lastFewLines.includes("Esc to interrupt")) {
        return "busy";
    }
    if (lastFewLines.includes("Running")) {
        return "busy";
    }
    return "idle";
}
/**
 * Send a key response to an agent's tmux session.
 */
export async function sendApprovalResponse(agentName, key) {
    const sessionName = `crew-${agentName}`;
    try {
        await execFileAsync("tmux", ["has-session", "-t", sessionName]);
    }
    catch {
        return false;
    }
    // Check prompt type to determine how to send the key
    const approval = activeApprovals.get(agentName);
    const isMcpSetup = approval?.promptType === "mcp_setup";
    try {
        if (key === "Escape") {
            await execFileAsync("tmux", ["send-keys", "-t", sessionName, "Escape"]);
        }
        else if (isMcpSetup) {
            // MCP server setup prompt: navigate with arrow keys to the option, then Enter
            // Option 1 is already selected by default (cursor at position 1)
            const targetNum = parseInt(key);
            if (!isNaN(targetNum) && targetNum > 1) {
                // Press Down arrow (targetNum - 1) times to reach the option
                for (let i = 1; i < targetNum; i++) {
                    await execFileAsync("tmux", ["send-keys", "-t", sessionName, "Down"]);
                }
            }
            // Press Enter to confirm
            await execFileAsync("tmux", ["send-keys", "-t", sessionName, "Enter"]);
        }
        else {
            // Tool use approval: just send the number key
            await execFileAsync("tmux", ["send-keys", "-t", sessionName, key]);
        }
        // Remove the approval from active list
        removeApproval(agentName);
        return true;
    }
    catch (err) {
        console.error(`[tmux-monitor] Failed to send approval response to ${agentName}:`, err.message);
        return false;
    }
}
/**
 * Scan all crew-* tmux sessions and update states / detect approvals.
 */
async function scanSessions() {
    // Get list of crew-* tmux sessions
    let sessionNames;
    try {
        const { stdout } = await execFileAsync("tmux", ["list-sessions", "-F", "#{session_name}"]);
        sessionNames = stdout
            .trim()
            .split("\n")
            .filter((s) => s.startsWith("crew-"));
    }
    catch {
        // tmux not running or no sessions
        // Mark all tracked agents as no_session
        for (const [name] of agentStates) {
            if (agentStates.get(name) !== "no_session") {
                agentStates.set(name, "no_session");
            }
        }
        return;
    }
    // Track which agents have sessions
    const currentAgents = new Set();
    const db = getDb();
    for (const sessionName of sessionNames) {
        const agentName = sessionName.replace("crew-", "");
        currentAgents.add(agentName);
        // Ensure agent is marked online if tmux session exists
        // This prevents agents from going offline when MCP bridge heartbeat is stale
        try {
            const agent = db
                .prepare("SELECT status FROM agents WHERE name = ?")
                .get(agentName);
            if (agent && agent.status !== "online") {
                db.prepare("UPDATE agents SET status = 'online', last_heartbeat = ? WHERE name = ?")
                    .run(Date.now(), agentName);
                broadcast({ type: "agent:status", data: { name: agentName, status: "online" } });
            }
        }
        catch {
            // DB not ready yet, skip
        }
        try {
            // Capture pane content without ANSI for state detection
            const { stdout: paneContent } = await execFileAsync("tmux", [
                "capture-pane", "-t", sessionName, "-p", "-S", `-${CAPTURE_LINES}`,
            ]);
            // Capture with ANSI escape codes for terminal display
            let paneContentAnsi = "";
            try {
                const { stdout } = await execFileAsync("tmux", [
                    "capture-pane", "-t", sessionName, "-p", "-e", "-S", `-${CAPTURE_LINES}`,
                ]);
                paneContentAnsi = stdout;
            }
            catch {
                paneContentAnsi = paneContent;
            }
            const prevState = agentStates.get(agentName);
            const newState = detectState(paneContent);
            agentStates.set(agentName, newState);
            // Parse and track context usage
            const ctxPercent = parseContextPercent(paneContent);
            if (ctxPercent !== null) {
                agentContextPercent.set(agentName, ctxPercent);
            }
            // Broadcast terminal content if changed (for DM terminal panels)
            const prevTerminal = agentTerminalContent.get(agentName);
            if (paneContentAnsi !== prevTerminal) {
                agentTerminalContent.set(agentName, paneContentAnsi);
                broadcast({
                    type: "agent:terminal",
                    data: { name: agentName, content: paneContentAnsi },
                });
            }
            if (newState === "approval_pending") {
                // Check if we already have this approval tracked
                const existing = activeApprovals.get(agentName);
                if (!existing) {
                    const approval = parseApprovalPrompt(paneContent, agentName);
                    if (approval) {
                        activeApprovals.set(agentName, approval);
                        broadcast({
                            type: "approval:pending",
                            data: approval,
                        });
                        console.error(`[tmux-monitor] Detected tool approval for ${agentName}: ${approval.toolName}`);
                    }
                }
            }
            else {
                // If approval was previously active but is now gone, it was resolved externally
                if (activeApprovals.has(agentName)) {
                    const removed = activeApprovals.get(agentName);
                    activeApprovals.delete(agentName);
                    broadcast({
                        type: "approval:resolved",
                        data: { agentName, approvalId: removed.id },
                    });
                }
            }
            // Broadcast state change (include contextPercent)
            if (prevState !== newState) {
                broadcast({
                    type: "agent:tmux_state",
                    data: {
                        name: agentName,
                        tmuxState: newState,
                        contextPercent: agentContextPercent.get(agentName) || 0,
                    },
                });
                // Update delivery status: if agent is now busy/idle after being in approval_pending,
                // it means it started processing - mark recent mentions as "read"
                if (prevState === "idle" && newState === "busy") {
                    markRecentMentionsAsRead(agentName);
                }
            }
        }
        catch {
            // Failed to capture pane
        }
    }
    // Mark agents without sessions as no_session and offline
    for (const [name, state] of agentStates) {
        if (!currentAgents.has(name) && state !== "no_session") {
            agentStates.set(name, "no_session");
            if (activeApprovals.has(name)) {
                const removed = activeApprovals.get(name);
                activeApprovals.delete(name);
                broadcast({
                    type: "approval:resolved",
                    data: { agentName: name, approvalId: removed.id },
                });
            }
            // Also mark as offline in DB when tmux session disappears
            try {
                db.prepare("UPDATE agents SET status = 'offline' WHERE name = ? AND status = 'online'")
                    .run(name);
                broadcast({ type: "agent:status", data: { name, status: "offline" } });
            }
            catch { /* ignore */ }
            broadcast({
                type: "agent:tmux_state",
                data: { name, tmuxState: "no_session" },
            });
        }
    }
}
/**
 * When an agent starts processing (idle -> busy), mark recent pending mentions as "read".
 */
function markRecentMentionsAsRead(agentName) {
    try {
        const db = getDb();
        const result = db
            .prepare("UPDATE pending_mentions SET delivery_status = 'read' WHERE agent_name = ? AND delivery_status = 'delivered'")
            .run(agentName);
        if (result.changes > 0) {
            // Get the message IDs that were updated
            const updated = db
                .prepare("SELECT DISTINCT message_id FROM pending_mentions WHERE agent_name = ? AND delivery_status = 'read'")
                .all(agentName);
            for (const row of updated) {
                broadcast({
                    type: "message:status",
                    data: {
                        messageId: row.message_id,
                        agentName,
                        status: "read",
                    },
                });
            }
        }
    }
    catch {
        // Schema might not be updated yet, ignore
    }
}
// --- Auto-cycle: restart agent sessions when context usage is too high ---
// Track last cycle time per agent to enforce cooldown
const lastCycleTime = new Map();
/**
 * Check if any agent's context usage exceeds the threshold and trigger auto-cycle.
 * The cycle process:
 * 1. Send a save_worklog reminder to the agent via tmux
 * 2. Wait briefly for the agent to save state
 * 3. Kill the tmux session
 * 4. Re-wake the agent with a fresh session
 */
async function checkAutoCycle() {
    for (const [agentName, percent] of agentContextPercent) {
        if (percent < SESSION_AUTO_CYCLE_CONTEXT_PERCENT)
            continue;
        // Enforce cooldown
        const lastCycle = lastCycleTime.get(agentName) || 0;
        if (Date.now() - lastCycle < SESSION_AUTO_CYCLE_COOLDOWN_MS)
            continue;
        // Don't cycle agents that are in approval_pending state
        const state = agentStates.get(agentName);
        if (state === "approval_pending")
            continue;
        console.error(`[tmux-monitor] Auto-cycling agent "${agentName}" (context: ${percent}%)`);
        lastCycleTime.set(agentName, Date.now());
        try {
            await cycleAgentSession(agentName);
        }
        catch (err) {
            console.error(`[tmux-monitor] Failed to cycle "${agentName}":`, err.message);
        }
    }
}
async function cycleAgentSession(agentName) {
    const sessionName = `crew-${agentName}`;
    const agentDir = path.join(PROJECT_ROOT, "agents", agentName);
    // Prompt agent to reflect before cycle (best-effort, non-blocking)
    try {
        const sessionCheck = await execFileAsync("tmux", ["has-session", "-t", sessionName]).catch(() => null);
        if (sessionCheck) {
            // Send a prompt asking the agent to save worklog and reflect
            const reflectMsg = "Your session is about to restart due to high context usage. Please call save_worklog and reflect_on_task now to preserve your state and learnings.";
            await execFileAsync("tmux", ["send-keys", "-t", sessionName, reflectMsg, "Enter"]);
            // Brief pause to let agent process the message
            await new Promise((r) => setTimeout(r, 5000));
        }
    }
    catch { /* best effort */ }
    // Notify via system message in chat (upsert: one row per agent, update in-place)
    try {
        const db = getDb();
        const now = Date.now();
        const content = `[auto-cycle] ${agentName} session restarting (context ${agentContextPercent.get(agentName)}%). Worklog preserved.`;
        const existing = db.prepare("SELECT id FROM messages WHERE channel_id = 'general' AND sender_name = 'crew-manager' AND message_type = 'auto-cycle' AND metadata = ?").get(JSON.stringify({ agent: agentName }));
        if (existing) {
            db.prepare("UPDATE messages SET content = ?, created_at = ? WHERE id = ?").run(content, now, existing.id);
            broadcast({
                type: "message:update",
                data: { id: existing.id, content, created_at: now, sender_name: "crew-manager", message_type: "auto-cycle" },
            });
        }
        else {
            const result = db.prepare("INSERT INTO messages (channel_id, sender_type, sender_name, content, mentions, message_type, created_at, metadata) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run("general", "system", "crew-manager", content, "[]", "auto-cycle", now, JSON.stringify({ agent: agentName }));
            broadcast({
                type: "message:new",
                data: { id: result.lastInsertRowid, channel_id: "general", sender_name: "crew-manager", content, message_type: "auto-cycle", created_at: now },
            });
        }
    }
    catch { /* ignore message insert failure */ }
    // Kill tmux session
    try {
        await execFileAsync("tmux", ["kill-session", "-t", sessionName]);
    }
    catch { /* session might not exist */ }
    // Kill lingering MCP bridge processes
    try {
        const { stdout } = await execFileAsync("pgrep", ["-f", `mcp-bridge.*${agentName}`]);
        for (const pid of stdout.trim().split("\n").filter(Boolean)) {
            try {
                process.kill(parseInt(pid), "SIGTERM");
            }
            catch { /* ignore */ }
        }
    }
    catch { /* no matching processes */ }
    // Brief pause for cleanup
    await new Promise((r) => setTimeout(r, 2000));
    // Find claude path and re-wake
    const claudePath = findBinary("claude");
    if (!claudePath) {
        console.error(`[tmux-monitor] Cannot re-wake "${agentName}": Claude CLI not found`);
        return;
    }
    if (!fs.existsSync(agentDir)) {
        console.error(`[tmux-monitor] Cannot re-wake "${agentName}": workspace not found`);
        return;
    }
    await startVerifiedClaudeSession(agentDir, claudePath, agentName, { forceNewSession: true });
    // Reset context tracking
    agentContextPercent.set(agentName, 0);
    agentStates.set(agentName, "idle");
    console.error(`[tmux-monitor] Agent "${agentName}" re-waked successfully`);
}
let monitorInterval = null;
let autoCycleInterval = null;
export function startTmuxMonitor() {
    if (monitorInterval)
        return;
    console.error("[tmux-monitor] Starting tmux session monitor");
    // Run immediately once
    scanSessions();
    monitorInterval = setInterval(scanSessions, MONITOR_INTERVAL_MS);
    // Check auto-cycle every 30 seconds
    autoCycleInterval = setInterval(checkAutoCycle, 30_000);
}
export function stopTmuxMonitor() {
    if (monitorInterval) {
        clearInterval(monitorInterval);
        monitorInterval = null;
    }
    if (autoCycleInterval) {
        clearInterval(autoCycleInterval);
        autoCycleInterval = null;
    }
}
//# sourceMappingURL=tmux-monitor.js.map