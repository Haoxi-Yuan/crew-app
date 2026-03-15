export interface MemoryEntry {
    id: string;
    agent_name: string;
    category: string;
    source_file: string;
    heading: string;
    content: string;
    content_hash: string;
    importance: number;
    emotional_weight: number;
    created_at: number;
    last_accessed_at: number;
    access_count: number;
    access_timestamps: string;
    stability: number;
    difficulty: number;
    activation: number;
    retrievability: number;
    status: string;
    promoted_at: number | null;
    archived_at: number | null;
    linked_ids: string;
    embedding: Buffer | null;
    project_id?: string | null;
    scope_type?: string;
    scope_id?: string;
}
export declare function computeActivation(entry: MemoryEntry, now: number): number;
export declare function computeRetrievability(activation: number): number;
export declare function onMemoryAccessed(entry: MemoryEntry, now: number): MemoryEntry;
export declare function shouldPromote(entry: MemoryEntry, _now: number): boolean;
export declare function shouldArchive(entry: MemoryEntry, now: number): boolean;
export interface ConsolidationResult {
    promoted: string[];
    archived: string[];
    recalculated: number;
}
export declare function consolidate(entries: MemoryEntry[], now: number): {
    result: ConsolidationResult;
    updates: MemoryEntry[];
};
export declare function computeSearchScore(searchRelevance: number, retrievability: number): number;
