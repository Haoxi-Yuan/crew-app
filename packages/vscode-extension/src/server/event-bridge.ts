import * as vscode from "vscode";
import { WebSocket } from "ws";

/**
 * Bridges server WebSocket events to VS Code tree views and notifications.
 * Connects to the server's /ws endpoint and dispatches relevant events
 * to refresh tree providers and show user notifications.
 */

interface WsEvent {
  type: string;
  data: unknown;
}

type EventHandler = (event: WsEvent) => void;

export class EventBridge {
  private ws: WebSocket | null = null;
  private handlers: EventHandler[] = [];
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private port: number | null = null;
  private disposed = false;
  private outputChannel: vscode.OutputChannel;

  constructor(outputChannel: vscode.OutputChannel) {
    this.outputChannel = outputChannel;
  }

  connect(port: number): void {
    this.port = port;
    this.disposed = false;
    this.doConnect();
  }

  disconnect(): void {
    this.cleanup();
    this.port = null;
  }

  onEvent(handler: EventHandler): vscode.Disposable {
    this.handlers.push(handler);
    return new vscode.Disposable(() => {
      this.handlers = this.handlers.filter((h) => h !== handler);
    });
  }

  dispose(): void {
    this.disposed = true;
    this.cleanup();
    this.handlers = [];
  }

  private doConnect(): void {
    if (this.disposed || !this.port) return;
    this.cleanup();

    try {
      const ws = new WebSocket(`ws://127.0.0.1:${this.port}/ws`);
      this.ws = ws;

      ws.on("open", () => {
        this.outputChannel.appendLine("[event-bridge] WebSocket connected");
      });

      ws.on("close", () => {
        this.outputChannel.appendLine("[event-bridge] WebSocket disconnected");
        if (!this.disposed && this.port) {
          this.reconnectTimer = setTimeout(() => this.doConnect(), 3000);
        }
      });

      ws.on("error", (err) => {
        this.outputChannel.appendLine(`[event-bridge] WebSocket error: ${err.message}`);
      });

      ws.on("message", (data) => {
        try {
          const event: WsEvent = JSON.parse(data.toString());
          for (const handler of this.handlers) {
            try {
              handler(event);
            } catch (err) {
              this.outputChannel.appendLine(
                `[event-bridge] handler error: ${(err as Error).message}`,
              );
            }
          }
        } catch {
          // Ignore non-JSON messages
        }
      });
    } catch (err) {
      this.outputChannel.appendLine(
        `[event-bridge] failed to connect: ${(err as Error).message}`,
      );
    }
  }

  private cleanup(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      this.ws.removeAllListeners();
      if (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING) {
        this.ws.close();
      }
      this.ws = null;
    }
  }
}
