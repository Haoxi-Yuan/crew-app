// Memory decay engine based on ACT-R cognitive model + SM-2 spaced repetition
// Implements humanistic memory decay where strength = f(access frequency, spacing, importance, category)
import { MEMORY_MAX_STABILITY_DAYS, MEMORY_MAX_TIMESTAMPS, MEMORY_ARCHIVE_THRESHOLD, MEMORY_DAILY_ARCHIVE_AGE_DAYS, MEMORY_PROMOTION_MIN_ACCESSES, } from "./config.js";
const ACT_R_DECAY = 0.5;
const RETRIEVABILITY_STEEPNESS = 3.0;
const RETRIEVABILITY_THRESHOLD = -1.0;
const CATEGORY_WEIGHTS = {
    contact: 2.0,
    preference: 1.5,
    decision: 0.5,
    project: 0.3,
    pattern: 0.3,
    feedback: 0.2,
    daily: 0.0,
};
const PERMANENT_CATEGORIES = new Set(["contact", "preference"]);
const SLOW_DECAY_CATEGORIES = new Set(["decision", "project"]);
export function computeActivation(entry, now) {
    const timestamps = parseTimestamps(entry.access_timestamps);
    // Factor 1: ACT-R base-level activation
    let sumDecay = 0;
    if (timestamps.length === 0) {
        const ageDays = Math.max((now - entry.created_at) / 86400000, 0.01);
        sumDecay = Math.pow(ageDays, -ACT_R_DECAY);
    }
    else {
        for (const t of timestamps) {
            const ageDays = Math.max((now - t) / 86400000, 0.01);
            sumDecay += Math.pow(ageDays, -ACT_R_DECAY);
        }
    }
    const baseLevelActivation = Math.log(Math.max(sumDecay, 1e-10));
    // Factor 2: Importance boost (1-5 -> 0.0-1.0)
    const importanceBoost = (entry.importance - 1) * 0.25;
    // Factor 3: Emotional weight boost
    const emotionalBoost = Math.log(Math.max(entry.emotional_weight, 1.0));
    // Factor 4: Spacing bonus
    const spacingBonus = computeSpacingBonus(timestamps);
    // Factor 5: Category weight
    const categoryWeight = CATEGORY_WEIGHTS[entry.category] ?? 0.0;
    return baseLevelActivation + importanceBoost + emotionalBoost + spacingBonus + categoryWeight;
}
export function computeRetrievability(activation) {
    return 1.0 / (1.0 + Math.exp(-RETRIEVABILITY_STEEPNESS * (activation - RETRIEVABILITY_THRESHOLD)));
}
function computeSpacingBonus(timestamps) {
    if (timestamps.length < 2)
        return 0;
    const sorted = [...timestamps].sort((a, b) => a - b);
    const intervals = [];
    for (let i = 1; i < sorted.length; i++) {
        intervals.push((sorted[i] - sorted[i - 1]) / 86400000);
    }
    const mean = intervals.reduce((a, b) => a + b, 0) / intervals.length;
    if (mean < 0.01)
        return -0.2; // Cramming penalty
    // Check if intervals are roughly increasing (spaced repetition pattern)
    let increasingCount = 0;
    for (let i = 1; i < intervals.length; i++) {
        if (intervals[i] >= intervals[i - 1] * 0.8)
            increasingCount++;
    }
    const increasingRatio = intervals.length > 1
        ? increasingCount / (intervals.length - 1)
        : 0;
    return increasingRatio * 0.5 - 0.1;
}
export function onMemoryAccessed(entry, now) {
    const timestamps = parseTimestamps(entry.access_timestamps);
    const updated = { ...entry };
    updated.access_count += 1;
    updated.last_accessed_at = now;
    timestamps.push(now);
    if (timestamps.length > MEMORY_MAX_TIMESTAMPS)
        timestamps.shift();
    updated.access_timestamps = JSON.stringify(timestamps);
    // Update stability (SM-2 inspired)
    const prevAccess = timestamps.length >= 2 ? timestamps[timestamps.length - 2] : entry.created_at;
    const timeSinceLastDays = (now - prevAccess) / 86400000;
    const intervalRatio = timeSinceLastDays / Math.max(entry.stability, 0.1);
    let stabilityMultiplier;
    if (intervalRatio >= 0.5 && intervalRatio <= 3.0) {
        stabilityMultiplier = 2.5 - entry.difficulty;
    }
    else if (intervalRatio < 0.5) {
        stabilityMultiplier = 1.1; // Cramming: small boost
    }
    else {
        stabilityMultiplier = 1.5; // Late access: moderate boost
    }
    updated.stability = Math.min(entry.stability * stabilityMultiplier, MEMORY_MAX_STABILITY_DAYS);
    // Apply slow decay category rule
    if (SLOW_DECAY_CATEGORIES.has(entry.category)) {
        updated.stability = Math.max(updated.stability, 60);
    }
    updated.activation = computeActivation(updated, now);
    updated.retrievability = computeRetrievability(updated.activation);
    return updated;
}
export function shouldPromote(entry, _now) {
    if (entry.category !== "daily")
        return false;
    if (entry.status !== "active")
        return false;
    const timestamps = parseTimestamps(entry.access_timestamps);
    const uniqueDays = new Set(timestamps.map((t) => Math.floor(t / 86400000))).size;
    // Criterion 1: Accessed N+ times over N+ different days
    if (entry.access_count >= MEMORY_PROMOTION_MIN_ACCESSES && uniqueDays >= MEMORY_PROMOTION_MIN_ACCESSES)
        return true;
    // Criterion 2: High importance and accessed after creation day
    const creationDay = Math.floor(entry.created_at / 86400000);
    const accessedLater = timestamps.some((t) => Math.floor(t / 86400000) > creationDay);
    if (entry.importance >= 4 && accessedLater)
        return true;
    // Criterion 3: Manually tagged (importance=5 + emotional)
    if (entry.importance === 5 && entry.emotional_weight > 1.5)
        return true;
    return false;
}
export function shouldArchive(entry, now) {
    if (entry.status === "permanent" || entry.status === "archived")
        return false;
    if (PERMANENT_CATEGORIES.has(entry.category))
        return false;
    // Archive if retrievability drops below threshold
    if (entry.retrievability < MEMORY_ARCHIVE_THRESHOLD)
        return true;
    // Archive daily entries older than configured age with no access
    if (entry.category === "daily" && entry.access_count === 0) {
        const ageDays = (now - entry.created_at) / 86400000;
        if (ageDays > MEMORY_DAILY_ARCHIVE_AGE_DAYS)
            return true;
    }
    return false;
}
export function consolidate(entries, now) {
    const result = { promoted: [], archived: [], recalculated: 0 };
    const updates = [];
    for (const entry of entries) {
        if (entry.status === "archived")
            continue;
        const updated = { ...entry };
        // Apply permanent status for permanent categories
        if (PERMANENT_CATEGORIES.has(entry.category) && entry.status !== "permanent") {
            updated.status = "permanent";
            updated.retrievability = 1.0;
            updates.push(updated);
            result.recalculated++;
            continue;
        }
        if (updated.status === "permanent") {
            updated.retrievability = 1.0;
            updates.push(updated);
            continue;
        }
        // Recalculate activation and retrievability
        updated.activation = computeActivation(updated, now);
        updated.retrievability = computeRetrievability(updated.activation);
        result.recalculated++;
        // Check promotion
        if (shouldPromote(updated, now)) {
            updated.status = "promoted";
            updated.promoted_at = now;
            updated.stability = Math.max(updated.stability, 30);
            result.promoted.push(updated.id);
        }
        // Check archival
        else if (shouldArchive(updated, now)) {
            updated.status = "archived";
            updated.archived_at = now;
            result.archived.push(updated.id);
        }
        updates.push(updated);
    }
    return { result, updates };
}
export function computeSearchScore(searchRelevance, retrievability) {
    const retrievabilityWeight = 0.3 + 0.7 * retrievability;
    return searchRelevance * retrievabilityWeight;
}
function parseTimestamps(json) {
    try {
        const arr = JSON.parse(json);
        return Array.isArray(arr) ? arr : [];
    }
    catch {
        return [];
    }
}
//# sourceMappingURL=memory-engine.js.map