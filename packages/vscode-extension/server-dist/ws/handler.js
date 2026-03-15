import { WebSocketServer, WebSocket } from "ws";
let wss;
export function initWebSocket(server) {
    wss = new WebSocketServer({ server, path: "/ws" });
    wss.on("connection", (ws) => {
        ws.on("error", (err) => {
            console.error("[ws] client error:", err.message);
        });
    });
    return wss;
}
export function broadcast(event) {
    if (!wss)
        return;
    const payload = JSON.stringify(event);
    for (const client of wss.clients) {
        if (client.readyState === WebSocket.OPEN) {
            client.send(payload);
        }
    }
}
//# sourceMappingURL=handler.js.map