import { loadConfig } from "../config.ts";
import { setLogLevel } from "../log.ts";
import { openAndMigrate } from "./index.ts";

const cfg = loadConfig();
setLogLevel(cfg.logLevel);
const db = openAndMigrate(cfg.dbPath);
db.close();
console.log(`Schema is current at ${cfg.dbPath}`);
