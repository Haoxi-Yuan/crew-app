import { WebSocketServer, WebSocket } from "ws";
import type { Server } from "node:http";

let wss: WebSocketServer;

export function initWebSocket(server: Server): WebSocketServer {
  wss = new WebSocketServer({ server, path: "/ws" });

  wss.on("connection", (ws: WebSocket) => {
    ws.on("error", (err) => {
      console.error("[ws] client error:", err.message);
    });
  });

  return wss;
}

export function broadcast(event: { type: string; data: unknown }): void {
  if (!wss) return;

  const payload = JSON.stringify(event);
  for (const client of wss.clients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(payload);
    }
  }
}
