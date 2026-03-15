/**
 * Unified transport layer for API calls and WebSocket.
 *
 * Centralizes all HTTP fetch and WebSocket communication.
 * Supports two environments:
 * - Standalone browser: derives URLs from window.location
 * - VS Code WebView: uses injected window.__CREW_BASE_URL / __CREW_WS_URL
 */

import type { WsEvent } from "./types.js";

// ---------------------------------------------------------------------------
// URL resolution
// ---------------------------------------------------------------------------

declare global {
  interface Window {
    __CREW_BASE_URL?: string;
    __CREW_WS_URL?: string;
  }
}

function resolveBaseUrl(): string {
  if (typeof window !== "undefined" && window.__CREW_BASE_URL) {
    return window.__CREW_BASE_URL;
  }
  return "";
}

function resolveWsUrl(): string {
  if (typeof window !== "undefined" && window.__CREW_WS_URL) {
    return window.__CREW_WS_URL;
  }
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${location.host}/ws`;
}

// ---------------------------------------------------------------------------
// API Error
// ---------------------------------------------------------------------------

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly body: string,
  ) {
    super(`API ${status}: ${body.slice(0, 200)}`);
    this.name = "ApiError";
  }

  /** Try to extract `{ error: "..." }` from the JSON body, fallback to raw body. */
  get errorMessage(): string {
    try {
      const parsed = JSON.parse(this.body);
      if (typeof parsed?.error === "string") return parsed.error;
    } catch { /* not JSON */ }
    return this.body || this.message;
  }
}

// ---------------------------------------------------------------------------
// API client
// ---------------------------------------------------------------------------

async function request<T>(
  method: string,
  path: string,
  body?: unknown,
): Promise<T> {
  const base = resolveBaseUrl();
  const url = path.startsWith("/") ? `${base}${path}` : path;

  const init: RequestInit = { method };
  if (body !== undefined) {
    init.headers = { "Content-Type": "application/json" };
    init.body = JSON.stringify(body);
  }

  const res = await fetch(url, init);
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new ApiError(res.status, text);
  }

  const contentType = res.headers.get("content-type") || "";
  if (contentType.includes("application/json")) {
    return res.json() as Promise<T>;
  }
  // For 204 No Content or non-JSON responses
  return undefined as T;
}

/**
 * Centralized API client. All HTTP calls should go through this object.
 *
 * Usage:
 *   const agents = await api.get<Agent[]>("/api/agents");
 *   await api.post("/api/wake", { name: "alice" });
 */
export const api = {
  get: <T = unknown>(path: string) => request<T>("GET", path),
  post: <T = unknown>(path: string, body?: unknown) => request<T>("POST", path, body),
  put: <T = unknown>(path: string, body?: unknown) => request<T>("PUT", path, body),
  del: <T = unknown>(path: string, body?: unknown) => request<T>("DELETE", path, body),
};

// ---------------------------------------------------------------------------
// WebSocket client
// ---------------------------------------------------------------------------

type WsEventHandler = (event: WsEvent) => void;
type WsStatusHandler = (status: "connected" | "disconnected" | "error") => void;

export class WsClient {
  private ws: WebSocket | null = null;
  private handlers: WsEventHandler[] = [];
  private statusHandlers: WsStatusHandler[] = [];
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private url: string;
  private disposed = false;

  constructor(url?: string) {
    this.url = url || resolveWsUrl();
  }

  connect(): void {
    if (this.disposed) return;
    this.cleanup();

    const ws = new WebSocket(this.url);
    this.ws = ws;

    ws.onopen = () => {
      this.notifyStatus("connected");
    };

    ws.onclose = () => {
      this.notifyStatus("disconnected");
      if (!this.disposed) {
        this.reconnectTimer = setTimeout(() => this.connect(), 3000);
      }
    };

    ws.onerror = () => {
      this.notifyStatus("error");
    };

    ws.onmessage = (event) => {
      try {
        const parsed: WsEvent = JSON.parse(event.data);
        for (const handler of this.handlers) {
          handler(parsed);
        }
      } catch {
        // Ignore non-JSON messages
      }
    };
  }

  /** Subscribe to all WebSocket events. Returns unsubscribe function. */
  onEvent(handler: WsEventHandler): () => void {
    this.handlers.push(handler);
    return () => {
      this.handlers = this.handlers.filter((h) => h !== handler);
    };
  }

  /** Subscribe to connection status changes. Returns unsubscribe function. */
  onStatus(handler: WsStatusHandler): () => void {
    this.statusHandlers.push(handler);
    return () => {
      this.statusHandlers = this.statusHandlers.filter((h) => h !== handler);
    };
  }

  dispose(): void {
    this.disposed = true;
    this.cleanup();
    this.handlers = [];
    this.statusHandlers = [];
  }

  private cleanup(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      this.ws.onopen = null;
      this.ws.onclose = null;
      this.ws.onerror = null;
      this.ws.onmessage = null;
      if (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING) {
        this.ws.close();
      }
      this.ws = null;
    }
  }

  private notifyStatus(status: "connected" | "disconnected" | "error"): void {
    for (const handler of this.statusHandlers) {
      handler(status);
    }
  }
}

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

let wsClient: WsClient | null = null;

/** Get the shared WsClient singleton. Creates and connects if needed. */
export function getWsClient(): WsClient {
  if (!wsClient) {
    wsClient = new WsClient();
    wsClient.connect();
  }
  return wsClient;
}
