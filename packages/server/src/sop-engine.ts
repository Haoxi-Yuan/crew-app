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

import crypto from "node:crypto";
import { getDb, type SharedStandardRow, type StandardsHistoryRow } from "./db/index.js";
import { broadcast } from "./ws/handler.js";
import {
  MAX_STANDARDS_BUDGET,
  STANDARDS_AUTO_APPLY_CONFIDENCE,
  STANDARDS_CONSENSUS_MIN,
} from "./config.js";

interface ProposedUpdate {
  action?: string;
  section?: string;
  current_text?: string;
  proposed_text?: string;
  rationale?: string;
  confidence?: number;
  [key: string]: unknown;
}

/**
 * Review a proposed standard update. Returns whether it was auto-applied or needs manual review.
 * When forceApply=true (manual approval), skips auto-apply criteria checks.
 */
export function reviewProposedUpdate(
  update: Record<string, unknown>,
  reflectionConfidence: number,
  agentName: string,
  forceApply = false
): { action: string; reason: string } {
  const proposed = update as ProposedUpdate;
  const db = getDb();

  if (!proposed.action || !proposed.proposed_text || !proposed.section) {
    return { action: "skipped", reason: "missing required fields (action, proposed_text, section)" };
  }

  // Force apply path (manual approval)
  if (forceApply) {
    return applyUpdate(proposed, agentName, "manual_approval");
  }

  // Auto-apply criteria check
  const effectiveConfidence = Math.min(reflectionConfidence, proposed.confidence || reflectionConfidence);

  // 1. Confidence threshold
  if (effectiveConfidence < STANDARDS_AUTO_APPLY_CONFIDENCE) {
    return { action: "needs_review", reason: `confidence ${effectiveConfidence.toFixed(2)} < ${STANDARDS_AUTO_APPLY_CONFIDENCE} threshold` };
  }

  // 2. Only additive changes auto-apply
  if (proposed.action !== "add") {
    return { action: "needs_review", reason: `non-additive action '${proposed.action}' requires manual review` };
  }

  // 3. Budget check
  const existing = db.prepare("SELECT content FROM shared_standards WHERE status = 'active'").all() as { content: string }[];
  const currentTotal = existing.reduce((sum, r) => sum + r.content.length, 0);
  if (currentTotal + proposed.proposed_text.length > MAX_STANDARDS_BUDGET) {
    return { action: "needs_review", reason: "would exceed standards budget" };
  }

  // 4. Contradiction check
  const contradiction = detectContradiction(proposed.proposed_text);
  if (contradiction) {
    return { action: "needs_review", reason: `potential contradiction with existing standard: ${contradiction}` };
  }

  // 5. Agent consensus check (>= N different agents proposed similar pattern)
  const consensusCount = checkAgentConsensus(proposed.section, proposed.proposed_text, agentName);
  if (consensusCount < STANDARDS_CONSENSUS_MIN) {
    // Store as pending pattern, don't auto-apply yet
    return { action: "needs_review", reason: `only ${consensusCount} agent(s) proposed this pattern, need >= ${STANDARDS_CONSENSUS_MIN} for auto-apply` };
  }

  // All criteria met -> auto-apply
  return applyUpdate(proposed, agentName, "auto");
}

/**
 * Apply a standard update (create or modify).
 */
function applyUpdate(
  proposed: ProposedUpdate,
  agentName: string,
  appliedBy: string
): { action: string; reason: string } {
  const db = getDb();
  const now = Date.now();

  if (proposed.action === "add") {
    const id = crypto.randomUUID();
    // Infer category from section name
    const category = inferCategory(proposed.section || "");

    db.prepare(`
      INSERT INTO shared_standards (id, category, name, content, priority, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, 0, 'active', ?, ?)
    `).run(id, category, proposed.section, proposed.proposed_text, now, now);

    db.prepare(`
      INSERT INTO standards_history (standard_id, version, content, change_summary, source_reflection_ids, applied_by, created_at)
      VALUES (?, 1, ?, ?, '[]', ?, ?)
    `).run(id, proposed.proposed_text, proposed.rationale || "Auto-applied from reflection", appliedBy, now);

    broadcast({ type: "standards:updated", data: { action: "created", id, appliedBy } });
    return { action: "applied", reason: `new standard created (${appliedBy})` };
  }

  if (proposed.action === "modify" && proposed.current_text) {
    // Find matching standard
    const match = db.prepare(
      "SELECT * FROM shared_standards WHERE status = 'active' AND content LIKE ?"
    ).get(`%${proposed.current_text.slice(0, 50)}%`) as SharedStandardRow | undefined;

    if (!match) {
      return { action: "skipped", reason: "could not find matching standard to modify" };
    }

    const lastVersion = db.prepare(
      "SELECT MAX(version) as v FROM standards_history WHERE standard_id = ?"
    ).get(match.id) as { v: number | null };
    const nextVersion = (lastVersion.v || 0) + 1;

    db.prepare("UPDATE shared_standards SET content = ?, updated_at = ? WHERE id = ?")
      .run(proposed.proposed_text, now, match.id);

    db.prepare(`
      INSERT INTO standards_history (standard_id, version, content, change_summary, source_reflection_ids, applied_by, created_at)
      VALUES (?, ?, ?, ?, '[]', ?, ?)
    `).run(match.id, nextVersion, proposed.proposed_text, proposed.rationale || "Modified via reflection", appliedBy, now);

    broadcast({ type: "standards:updated", data: { action: "updated", id: match.id, appliedBy } });
    return { action: "applied", reason: `standard updated (${appliedBy})` };
  }

  if (proposed.action === "remove") {
    const match = db.prepare(
      "SELECT * FROM shared_standards WHERE status = 'active' AND name = ?"
    ).get(proposed.section) as SharedStandardRow | undefined;

    if (!match) {
      return { action: "skipped", reason: "could not find matching standard to remove" };
    }

    db.prepare("UPDATE shared_standards SET status = 'disabled', updated_at = ? WHERE id = ?")
      .run(now, match.id);

    broadcast({ type: "standards:updated", data: { action: "disabled", id: match.id, appliedBy } });
    return { action: "applied", reason: `standard disabled (${appliedBy})` };
  }

  return { action: "skipped", reason: `unsupported action: ${proposed.action}` };
}

/**
 * Detect contradictions between proposed text and existing standards.
 * Uses keyword negation detection.
 */
export function detectContradiction(proposedText: string): string | null {
  const db = getDb();
  const existing = db.prepare("SELECT name, content FROM shared_standards WHERE status = 'active'").all() as { name: string; content: string }[];

  const negationPairs = [
    ["always", "never"],
    ["must", "must not"],
    ["required", "forbidden"],
    ["prefer", "avoid"],
    ["enable", "disable"],
    ["use", "do not use"],
  ];

  const proposedLower = proposedText.toLowerCase();

  for (const std of existing) {
    const stdLower = std.content.toLowerCase();

    for (const [positive, negative] of negationPairs) {
      if (
        (proposedLower.includes(positive) && stdLower.includes(negative)) ||
        (proposedLower.includes(negative) && stdLower.includes(positive))
      ) {
        // Check if they're about the same topic (share 2+ significant words)
        const proposedWords = new Set(proposedLower.split(/\s+/).filter((w) => w.length > 3));
        const stdWords = new Set(stdLower.split(/\s+/).filter((w) => w.length > 3));
        let overlap = 0;
        for (const w of proposedWords) {
          if (stdWords.has(w)) overlap++;
        }
        if (overlap >= 2) {
          return std.name;
        }
      }
    }
  }

  return null;
}

/**
 * Check how many different agents have proposed similar updates to the same section.
 * Used for consensus check before auto-applying.
 */
function checkAgentConsensus(section: string, proposedText: string, currentAgent: string): number {
  const db = getDb();

  // Search recent reflections for similar proposed updates
  const recentReflections = db.prepare(`
    SELECT agent_name, proposed_updates FROM reflections
    WHERE created_at > ? AND agent_name != ?
    ORDER BY created_at DESC LIMIT 50
  `).all(Date.now() - 7 * 24 * 60 * 60 * 1000, currentAgent) as { agent_name: string; proposed_updates: string }[];

  const agentsWithSimilar = new Set<string>();
  agentsWithSimilar.add(currentAgent); // Current agent counts

  const proposedWords = new Set(proposedText.toLowerCase().split(/\s+/).filter((w) => w.length > 3));

  for (const ref of recentReflections) {
    try {
      const updates = JSON.parse(ref.proposed_updates) as ProposedUpdate[];
      for (const u of updates) {
        if (u.section === section || (u.proposed_text && textSimilarity(u.proposed_text, proposedText, proposedWords) > 0.5)) {
          agentsWithSimilar.add(ref.agent_name);
          break;
        }
      }
    } catch {
      // Skip malformed entries
    }
  }

  return agentsWithSimilar.size;
}

/**
 * Simple text similarity based on word overlap.
 */
function textSimilarity(a: string, b: string, bWords?: Set<string>): number {
  const aWords = new Set(a.toLowerCase().split(/\s+/).filter((w) => w.length > 3));
  const targetWords = bWords || new Set(b.toLowerCase().split(/\s+/).filter((w) => w.length > 3));

  if (aWords.size === 0 || targetWords.size === 0) return 0;

  let overlap = 0;
  for (const w of aWords) {
    if (targetWords.has(w)) overlap++;
  }

  return overlap / Math.max(aWords.size, targetWords.size);
}

/**
 * Extract patterns from Peak decisions in memory.
 * Called when Peak Settlement -> Persist occurs.
 * Clusters similar decisions and proposes standards when threshold met.
 */
export function extractPatternFromPeaks(projectId: string): { proposed: number; applied: number } {
  const db = getDb();

  // Query decision-type memories for this project
  const decisions = db.prepare(`
    SELECT heading, content, agent_name FROM memory_entries
    WHERE category = 'decision' AND project_id = ? AND status != 'archived'
    ORDER BY created_at DESC LIMIT 100
  `).all(projectId) as { heading: string; content: string; agent_name: string }[];

  if (decisions.length < 3) {
    return { proposed: 0, applied: 0 };
  }

  // Simple clustering: group by heading keyword similarity
  const clusters: Map<string, { heading: string; contents: string[]; agents: Set<string> }> = new Map();

  for (const d of decisions) {
    const key = d.heading.toLowerCase().split(/\s+/).slice(0, 3).join(" ");
    const existing = clusters.get(key);
    if (existing) {
      existing.contents.push(d.content);
      existing.agents.add(d.agent_name);
    } else {
      clusters.set(key, {
        heading: d.heading,
        contents: [d.content],
        agents: new Set([d.agent_name]),
      });
    }
  }

  let proposed = 0;
  let applied = 0;

  // For clusters with >= 3 similar decisions, propose a standard
  for (const [, cluster] of clusters) {
    if (cluster.contents.length < 3) continue;

    // Check if a standard already exists for this topic
    const existingStd = db.prepare(
      "SELECT 1 FROM shared_standards WHERE status = 'active' AND name LIKE ?"
    ).get(`%${cluster.heading.slice(0, 30)}%`);
    if (existingStd) continue;

    // Extract the most common pattern (simplified: use the shortest content as the rule)
    const sorted = [...cluster.contents].sort((a, b) => a.length - b.length);
    const rule = sorted[0];

    const result = reviewProposedUpdate(
      {
        action: "add",
        section: `Peak pattern: ${cluster.heading}`,
        proposed_text: rule,
        rationale: `Extracted from ${cluster.contents.length} similar Peak decisions across ${cluster.agents.size} agent(s)`,
        confidence: Math.min(0.9, 0.5 + cluster.agents.size * 0.15),
      },
      0.85,
      "sop-engine"
    );

    proposed++;
    if (result.action === "applied") applied++;
  }

  return { proposed, applied };
}

/**
 * Consolidate standards to stay within budget.
 * Merges duplicates, archives zero-reference standards.
 */
export function consolidateStandards(): { merged: number; archived: number } {
  const db = getDb();
  const standards = db.prepare("SELECT * FROM shared_standards WHERE status = 'active' ORDER BY priority DESC").all() as SharedStandardRow[];

  const totalChars = standards.reduce((sum, s) => sum + s.content.length, 0);
  if (totalChars <= MAX_STANDARDS_BUDGET) {
    return { merged: 0, archived: 0 };
  }

  let merged = 0;
  let archived = 0;
  const now = Date.now();

  // 1. Find and merge duplicates (same category, high text similarity)
  const seen = new Map<string, SharedStandardRow>();
  for (const std of standards) {
    const key = std.category;
    const prev = seen.get(key);
    if (prev && textSimilarity(prev.content, std.content) > 0.6) {
      // Merge: keep higher priority, combine content
      const combined = prev.content.length >= std.content.length ? prev.content : std.content;
      db.prepare("UPDATE shared_standards SET content = ?, updated_at = ? WHERE id = ?")
        .run(combined, now, prev.id);
      db.prepare("UPDATE shared_standards SET status = 'disabled', updated_at = ? WHERE id = ?")
        .run(now, std.id);
      merged++;
    } else {
      seen.set(`${key}-${std.id}`, std);
    }
  }

  // 2. If still over budget, archive lowest-priority standards
  const remaining = db.prepare("SELECT * FROM shared_standards WHERE status = 'active' ORDER BY priority ASC").all() as SharedStandardRow[];
  let currentTotal = remaining.reduce((sum, s) => sum + s.content.length, 0);

  for (const std of remaining) {
    if (currentTotal <= MAX_STANDARDS_BUDGET) break;
    db.prepare("UPDATE shared_standards SET status = 'disabled', updated_at = ? WHERE id = ?")
      .run(now, std.id);
    currentTotal -= std.content.length;
    archived++;
  }

  if (merged > 0 || archived > 0) {
    broadcast({ type: "standards:updated", data: { action: "consolidated", merged, archived } });
  }

  return { merged, archived };
}

function inferCategory(section: string): string {
  const lower = section.toLowerCase();
  if (lower.includes("name") || lower.includes("naming") || lower.includes("convention")) return "naming";
  if (lower.includes("tool") || lower.includes("prefer") || lower.includes("library")) return "tool_preference";
  if (lower.includes("workflow") || lower.includes("process") || lower.includes("pipeline")) return "workflow";
  return "coding_norm";
}
