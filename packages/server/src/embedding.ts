// Ollama embedding client with graceful degradation
// When Ollama is not running, all functions return null silently

import { OLLAMA_BASE_URL, OLLAMA_MODEL } from "./config.js";

const EMBEDDING_DIM = 768; // nomic-embed-text output dimension

let ollamaAvailable: boolean | null = null;
let lastCheckAt = 0;
const CHECK_INTERVAL_MS = 60_000; // Re-check Ollama availability every 60s

async function isOllamaRunning(): Promise<boolean> {
  const now = Date.now();
  if (ollamaAvailable !== null && now - lastCheckAt < CHECK_INTERVAL_MS) {
    return ollamaAvailable;
  }

  try {
    const resp = await fetch(`${OLLAMA_BASE_URL}/api/tags`, {
      signal: AbortSignal.timeout(2000),
    });
    ollamaAvailable = resp.ok;
  } catch {
    ollamaAvailable = false;
  }
  lastCheckAt = now;
  return ollamaAvailable;
}

export async function generateEmbedding(text: string): Promise<Buffer | null> {
  if (!(await isOllamaRunning())) return null;

  try {
    const resp = await fetch(`${OLLAMA_BASE_URL}/api/embed`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: OLLAMA_MODEL, input: text }),
      signal: AbortSignal.timeout(10000),
    });

    if (!resp.ok) {
      console.error(`[embedding] Ollama returned ${resp.status}`);
      return null;
    }

    const data = (await resp.json()) as { embeddings: number[][] };
    if (!data.embeddings || data.embeddings.length === 0) return null;

    const vec = data.embeddings[0];
    if (vec.length !== EMBEDDING_DIM) {
      console.error(`[embedding] unexpected dimension: ${vec.length}, expected ${EMBEDDING_DIM}`);
      return null;
    }

    // Pack float64 array into Buffer for SQLite BLOB storage
    const buf = Buffer.alloc(EMBEDDING_DIM * 8);
    for (let i = 0; i < EMBEDDING_DIM; i++) {
      buf.writeDoubleLE(vec[i], i * 8);
    }
    return buf;
  } catch (err) {
    console.error(`[embedding] generation failed: ${(err as Error).message}`);
    // Mark as unavailable so we don't keep retrying failed connections
    ollamaAvailable = false;
    lastCheckAt = Date.now();
    return null;
  }
}

export function bufferToVector(buf: Buffer): number[] {
  const vec: number[] = new Array(EMBEDDING_DIM);
  for (let i = 0; i < EMBEDDING_DIM; i++) {
    vec[i] = buf.readDoubleLE(i * 8);
  }
  return vec;
}

export function cosineSimilarity(a: number[], b: number[]): number {
  let dotProduct = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dotProduct += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denominator = Math.sqrt(normA) * Math.sqrt(normB);
  if (denominator === 0) return 0;
  return dotProduct / denominator;
}

export function isEmbeddingAvailable(): Promise<boolean> {
  return isOllamaRunning();
}

export { EMBEDDING_DIM };
