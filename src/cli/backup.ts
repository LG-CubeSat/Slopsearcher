import { loadConfig } from "../config.ts";
import { openAndMigrate } from "../db/index.ts";
import { createBackup } from "../backup.ts";
const cfg = loadConfig(); const db = openAndMigrate(cfg.dbPath);
try { console.log(await createBackup(db, cfg.dbPath)); } finally { db.close(); }
