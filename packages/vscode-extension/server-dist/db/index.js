import BetterSqlite3 from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { DB_PATH } from "../config.js";
import { initSchema } from "./schema.js";
let db;
export function getDb() {
    if (!db) {
        fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
        db = new BetterSqlite3(DB_PATH);
        initSchema(db);
    }
    return db;
}
//# sourceMappingURL=index.js.map