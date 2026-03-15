declare const EMBEDDING_DIM = 768;
export declare function generateEmbedding(text: string): Promise<Buffer | null>;
export declare function bufferToVector(buf: Buffer): number[];
export declare function cosineSimilarity(a: number[], b: number[]): number;
export declare function isEmbeddingAvailable(): Promise<boolean>;
export { EMBEDDING_DIM };
