/**
 * SOP Auto-Evolution Engine
 *
 * Integrates with PEAK_SYSTEM: Peak decisions (Settlement -> Persist) are
 * the highest-quality learning signals for SOP evolution.
 *
 * Auto-apply criteria:
 * - confidence >= 0.8
 * - action is "add" (additive, not destructive)
 * - no contradiction with existing standards
 * - total budget <= 4000 chars
 * - >= 2 agent consensus (same pattern from different agents)
 *
 * Feedback loop (PEAK_SYSTEM alignment):
 * - Early: many Peaks -> frequent decisions -> system accumulates preferences
 * - Mid: fewer Peaks -> agents reference past decisions to handle routine tradeoffs
 * - Mature: rare Peaks -> user judgment systematically encoded, only novel/high-risk Peaks reported
 */
/**
 * Review a proposed standard update. Returns whether it was auto-applied or needs manual review.
 * When forceApply=true (manual approval), skips auto-apply criteria checks.
 */
export declare function reviewProposedUpdate(update: Record<string, unknown>, reflectionConfidence: number, agentName: string, forceApply?: boolean): {
    action: string;
    reason: string;
};
/**
 * Detect contradictions between proposed text and existing standards.
 * Uses keyword negation detection.
 */
export declare function detectContradiction(proposedText: string): string | null;
/**
 * Extract patterns from Peak decisions in memory.
 * Called when Peak Settlement -> Persist occurs.
 * Clusters similar decisions and proposes standards when threshold met.
 */
export declare function extractPatternFromPeaks(projectId: string): {
    proposed: number;
    applied: number;
};
/**
 * Consolidate standards to stay within budget.
 * Merges duplicates, archives zero-reference standards.
 */
export declare function consolidateStandards(): {
    merged: number;
    archived: number;
};
