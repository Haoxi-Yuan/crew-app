import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { getDb, type MessageRow } from "./db/index.js";
import { broadcast } from "./ws/handler.js";
import { getProvider } from "./agent-runtime.js";
import { sendMessageToCodexAgent } from "./providers/codex.js";

const execFileAsync = promisify(execFile);

const CONTEXT_MAX_MESSAGES = 15;
const CONTEXT_MAX_CHARS = 3000;

function describeChannel(channelId?: string, channelType?: string): string {
  if (!channelId) return "chat";
  if (channelType === "dm") return "DM";
  if (channelType === "group") return `group "${channelId}"`;
  return `#${channelId}`;
}

export function buildForwardedMessageInput(
  senderName: string,
  content: string,
  channelId?: string,
  channelType?: string,
  channelContext = ""
): string {
  const replyLine = channelId
    ? `(Reply using send_to_chat with channel="${channelId}")`
    : "(Reply using send_to_chat)";
  return `${channelContext}[${senderName} in ${describeChannel(channelId, channelType)}]: ${content}\n${replyLine}`;
}

/**
 * Fetch recent messages from a channel to provide context when forwarding.
 * Excludes the current message (identified by messageId).
 */
export function getRecentChannelContext(
  channelId: string,
  excludeMessageId?: number
): string {
  try {
    const db = getDb();
    const totalCountRow = db
      .prepare("SELECT COUNT(*) as cnt FROM messages WHERE channel_id = ?")
      .get(channelId) as { cnt: number };
    const totalCount = totalCountRow.cnt - (excludeMessageId ? 1 : 0);
    if (totalCount <= 0) return "";

    const isLongHistory = totalCount > CONTEXT_MAX_MESSAGES;
    const limit = isLongHistory ? CONTEXT_MAX_MESSAGES + 1 : totalCount + (excludeMessageId ? 1 : 0);
    const rows = db
      .prepare(
        "SELECT id, sender_name, content, created_at FROM messages WHERE channel_id = ? ORDER BY id DESC LIMIT ?"
      )
      .all(channelId, limit) as Pick<
      MessageRow,
      "id" | "sender_name" | "content" | "created_at"
    >[];

    const messages = rows
      .filter((m) => m.id !== excludeMessageId)
      .slice(0, isLongHistory ? CONTEXT_MAX_MESSAGES : rows.length)
      .reverse();

    if (messages.length === 0) return "";

    const fmtTime = (ts: number) => {
      const d = new Date(ts);
      return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
    };

    const lines = messages.map((m) => `#${m.id} [${m.sender_name} ${fmtTime(m.created_at)}]: ${m.content}`);
    const totalChars = lines.reduce((sum, line) => sum + line.length + 1, 0);
    let result = `--- Recent chat context in #${channelId} ---\n`;
    result += lines.join("\n");
    result += "\n";
    if (isLongHistory) {
      result += "(Older messages omitted. Use search_chat to find earlier context.)\n";
    } else if (totalChars > CONTEXT_MAX_CHARS) {
      result += "(Context is long but fully included because the recent history is short.)\n";
    }
    result += `--- End context ---\n\n`;
    return result;
  } catch {
    return "";
  }
}

/**
 * Forward a message to agent's Claude Code tmux session.
 * Session naming convention: crew-<agentName>
 */
export async function forwardToAgent(
  agentName: string,
  senderName: string,
  content: string,
  channelId?: string,
  channelType?: string,
  messageId?: number
): Promise<boolean> {
  const channelContext = channelId
    ? getRecentChannelContext(channelId, messageId)
    : "";
  const input = buildForwardedMessageInput(senderName, content, channelId, channelType, channelContext);

  if (getProvider(agentName) === "codex") {
    return sendMessageToCodexAgent(agentName, input);
  }

  const sessionName = `crew-${agentName}`;

  try {
    // Check if tmux session exists
    await execFileAsync("tmux", ["has-session", "-t", sessionName]);
  } catch {
    // Session doesn't exist, agent not running in tmux
    return false;
  }

  try {
    // Send the text to the tmux session
    // Send the full text literally, then submit it as a single prompt.
    await execFileAsync("tmux", [
      "send-keys",
      "-t",
      sessionName,
      "-l",
      "--",
      input,
    ]);
    await execFileAsync("tmux", ["send-keys", "-t", sessionName, "Enter"]);
    return true;
  } catch (err) {
    console.error(
      `[forward] failed to send to ${agentName}:`,
      (err as Error).message
    );
    return false;
  }
}

/**
 * Forward a message to all mentioned agents' tmux sessions.
 * Updates delivery_status in pending_mentions after each forward attempt.
 */
export async function forwardToMentionedAgents(
  mentions: string[],
  senderName: string,
  content: string,
  messageId?: number,
  channelId?: string,
  channelType?: string
): Promise<{ forwarded: string[]; failed: string[] }> {
  const forwarded: string[] = [];
  const failed: string[] = [];

  for (const agentName of mentions) {
    const ok = await forwardToAgent(agentName, senderName, content, channelId, channelType, messageId);
    if (ok) {
      forwarded.push(agentName);
      // Update delivery status to 'delivered'
      if (messageId) {
        updateDeliveryStatus(messageId, agentName, "delivered");
      }
    } else {
      failed.push(agentName);
    }
  }

  return { forwarded, failed };
}

/**
 * Update the delivery_status of a pending mention and broadcast the change.
 */
function updateDeliveryStatus(
  messageId: number,
  agentName: string,
  status: "sent" | "delivered" | "read"
): void {
  try {
    const db = getDb();
    db.prepare(
      "UPDATE pending_mentions SET delivery_status = ? WHERE message_id = ? AND agent_name = ?"
    ).run(status, messageId, agentName);

    broadcast({
      type: "message:status",
      data: { messageId, agentName, status },
    });
  } catch {
    // Schema might not be updated yet, ignore
  }
}
