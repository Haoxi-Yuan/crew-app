export declare function parseMentions(content: string): string[];
export declare function getChannelProjectId(channelId?: string): string | null;
export declare function getActiveProjectAgentNames(projectId: string): string[];
export declare function expandMentions(mentions: string[], channelId?: string): string[];
export declare function createPendingMentions(messageId: number, agentNames: string[], channelId?: string): void;
