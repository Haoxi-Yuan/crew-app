// Ollama embedding client with auto-start
// Automatically starts Ollama when needed, pulls model if missing

import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import { OLLAMA_BASE_URL, OLLAMA_MODEL, OLLAMA_BIN, OLLAMA_MODELS_DIR } from "./config.js";

const EMBEDDING_DIM = 768; // nomic-embed-text output dimension

let ollamaAvailable: boolean | null = null;
let lastCheckAt = 0;
const CHECK_INTERVAL_MS = 60_000;

let ollamaProcess: ChildProcess | null = null;
let autoStartAttempted = false;
let autoStartInProgress: Promise<boolean> | null = null;

function findOllamaBin(): string | null {
  if (fs.existsSync(OLLAMA_BIN)) return OLLAMA_BIN;
  // Fallback: check common system paths
  const candidates = [
    "/opt/homebrew/bin/ollama",
    "/usr/local/bin/ollama",
    "/usr/bin/ollama",
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return null;
}

async function pollUntilReady(maxWaitMs: number): Promise<boolean> {
  const start = Date.now();
  const interval = 500;
  while (Date.now() - start < maxWaitMs) {
    try {
      const resp = await fetch(`${OLLAMA_BASE_URL}/api/tags`, {
        signal: AbortSignal.timeout(2000),
      });
      if (resp.ok) return true;
    } catch { /* not ready yet */ }
    await new Promise((r) => setTimeout(r, interval));
  }
  return false;
}

async function ensureModelAvailable(): Promise<boolean> {
  try {
    const resp = await fetch(`${OLLAMA_BASE_URL}/api/tags`, {
      signal: AbortSignal.timeout(5000),
    });
    if (!resp.ok) return false;
    const data = (await resp.json()) as { models: { name: string }[] };
    const modelNames = (data.models || []).map((m) => m.name);
    // Check if model is available (name may include :latest tag)
    if (modelNames.some((n) => n === OLLAMA_MODEL || n.startsWith(`${OLLAMA_MODEL}:`))) {
      return true;
    }
    // Model not found, pull it
    console.log(`[embedding] Model "${OLLAMA_MODEL}" not found, pulling...`);
    const pullResp = await fetch(`${OLLAMA_BASE_URL}/api/pull`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: OLLAMA_MODEL }),
      signal: AbortSignal.timeout(300_000), // 5 min timeout for pull
    });
    if (!pullResp.ok) {
      console.error(`[embedding] Failed to pull model: ${pullResp.status}`);
      return false;
    }
    // Stream response to completion (pull returns streaming JSON)
    const reader = pullResp.body?.getReader();
    if (reader) {
      while (true) {
        const { done } = await reader.read();
        if (done) break;
      }
    }
    console.log(`[embedding] Model "${OLLAMA_MODEL}" pulled successfully`);
    return true;
  } catch (err) {
    console.error(`[embedding] Model check failed: ${(err as Error).message}`);
    return false;
  }
}

async function autoStartOllama(): Promise<boolean> {
  if (autoStartAttempted) return false;
  autoStartAttempted = true;

  const bin = findOllamaBin();
  if (!bin) {
    console.log("[embedding] Ollama binary not found, skipping auto-start");
    return false;
  }

  console.log(`[embedding] Auto-starting Ollama from ${bin}...`);
  const env = { ...process.env, OLLAMA_MODELS: OLLAMA_MODELS_DIR };
  ollamaProcess = spawn(bin, ["serve"], {
    stdio: "ignore",
    detached: true,
    env,
  });

  ollamaProcess.unref();

  ollamaProcess.on("error", (err) => {
    console.error(`[embedding] Ollama process error: ${err.message}`);
    ollamaProcess = null;
  });

  ollamaProcess.on("exit", (code) => {
    if (code !== null && code !== 0) {
      console.error(`[embedding] Ollama exited with code ${code}`);
    }
    ollamaProcess = null;
    // Allow retry on next request
    autoStartAttempted = false;
    ollamaAvailable = false;
    lastCheckAt = 0;
  });

  const ready = await pollUntilReady(15_000);
  if (!ready) {
    console.error("[embedding] Ollama failed to start within 15s");
    return false;
  }

  console.log("[embedding] Ollama started successfully");

  const modelOk = await ensureModelAvailable();
  if (!modelOk) {
    console.error("[embedding] Required model not available");
    return false;
  }

  return true;
}

async function ensureOllamaRunning(): Promise<boolean> {
  const now = Date.now();
  // Use cached result within check interval
  if (ollamaAvailable === true && now - lastCheckAt < CHECK_INTERVAL_MS) {
    return true;
  }

  // Probe the server
  try {
    const resp = await fetch(`${OLLAMA_BASE_URL}/api/tags`, {
      signal: AbortSignal.timeout(2000),
    });
    if (resp.ok) {
      ollamaAvailable = true;
      lastCheckAt = now;
      return true;
    }
  } catch { /* not running */ }

  // Not running - attempt auto-start (deduplicate concurrent calls)
  if (autoStartInProgress) {
    return autoStartInProgress;
  }

  autoStartInProgress = autoStartOllama().then((ok) => {
    ollamaAvailable = ok;
    lastCheckAt = Date.now();
    autoStartInProgress = null;
    return ok;
  });

  return autoStartInProgress;
}

// Cleanup on process exit
function cleanupOllama(): void {
  if (ollamaProcess && !ollamaProcess.killed) {
    console.log("[embedding] Stopping Ollama child process...");
    ollamaProcess.kill("SIGTERM");
    ollamaProcess = null;
  }
}

process.on("exit", cleanupOllama);
process.on("SIGINT", () => { cleanupOllama(); process.exit(0); });
process.on("SIGTERM", () => { cleanupOllama(); process.exit(0); });

export async function generateEmbedding(text: string): Promise<Buffer | null> {
  if (!(await ensureOllamaRunning())) return null;

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
  return ensureOllamaRunning();
}

export { EMBEDDING_DIM };
