import { type CrewConfig } from "./config/index.js";
export interface ServerOptions {
    configOverrides?: Partial<CrewConfig>;
    signal?: AbortSignal;
    onReady?: (info: {
        port: number;
    }) => void;
    onError?: (error: Error) => void;
}
export declare function startServer(options?: ServerOptions): Promise<{
    close(): Promise<void>;
}>;
