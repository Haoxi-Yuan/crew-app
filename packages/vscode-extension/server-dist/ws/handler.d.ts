import { WebSocketServer } from "ws";
import type { Server } from "node:http";
export declare function initWebSocket(server: Server): WebSocketServer;
export declare function broadcast(event: {
    type: string;
    data: unknown;
}): void;
