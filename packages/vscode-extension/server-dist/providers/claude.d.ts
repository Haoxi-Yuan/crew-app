/**
 * Claude runtime provider.
 *
 * Wraps tmux-based session management for Claude Code agents.
 * Delegates to tmux-monitor for state tracking and to agents.ts
 * for verified session startup.
 */
import type { RuntimeProvider } from "./runtime.js";
export declare const claudeProvider: RuntimeProvider;
