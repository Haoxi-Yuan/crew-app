import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { getDb } from "./db/index.js";
import { broadcast } from "./ws/handler.js";

const execFileAsync = promisify(execFile);

/**
 * Forward a message to agent's Claude Code tmux session.
 * Session naming convention: crew-<agentName>
 */
export async function forwardToAgent(
  agentName: string,
  senderName: string,
  content: string,
  channelId?: string,
  channelType?: string
): Promise<boolean> {
  const sessionName = `crew-${agentName}`;

  try {
    // Check if tmux session exists
    await execFileAsync("tmux", ["has-session", "-t", sessionName]);
  } catch {
    // Session doesn't exist, agent not running in tmux
    return false;
  }

  // Build the message to inject into Claude Code's input
  // Include channel context so agent knows where to reply
  let input: string;
  if (channelType === "dm") {
    input = `[${senderName} in DM]: ${content}\n(Reply using send_to_chat with channel="${channelId}")`;
  } else if (channelType === "group") {
    input = `[${senderName} in group "${channelId}"]: ${content}\n(Reply using send_to_chat with channel="${channelId}")`;
  } else {
    input = `[${senderName} in group chat]: ${content}`;
  }

  try {
    // Send the text to the tmux session
    // Use send-keys to type it into Claude Code's input
    await execFileAsync("tmux", [
      "send-keys",
      "-t",
      sessionName,
      input,
      "Enter",
    ]);
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
    const ok = await forwardToAgent(agentName, senderName, content, channelId, channelType);
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
