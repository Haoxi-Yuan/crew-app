export declare function buildForwardedMessageInput(senderName: string, content: string, channelId?: string, channelType?: string, channelContext?: string): string;
/**
 * Fetch recent messages from a channel to provide context when forwarding.
 * Excludes the current message (identified by messageId).
 */
export declare function getRecentChannelContext(channelId: string, excludeMessageId?: number): string;
/**
 * Forward a message to agent's Claude Code tmux session.
 * Session naming convention: crew-<agentName>
 */
export declare function forwardToAgent(agentName: string, senderName: string, content: string, channelId?: string, channelType?: string, messageId?: number): Promise<boolean>;
/**
 * Forward a message to all mentioned agents' tmux sessions.
 * Updates delivery_status in pending_mentions after each forward attempt.
 */
export declare function forwardToMentionedAgents(mentions: string[], senderName: string, content: string, messageId?: number, channelId?: string, channelType?: string): Promise<{
    forwarded: string[];
    failed: string[];
}>;
