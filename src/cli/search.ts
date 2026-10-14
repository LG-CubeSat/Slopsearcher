import { loadConfig } from "../config.ts";
import { openAndMigrate } from "../db/index.ts";
import { SourceIndex } from "../index/index.ts";
import { setLogLevel } from "../log.ts";

const query = process.argv.slice(2).join(" ").trim();
if (query.length === 0) {
  console.error('Usage: pnpm search "<query>"');
  process.exit(2);
}

const cfg = loadConfig();
setLogLevel(cfg.logLevel);
const db = openAndMigrate(cfg.dbPath);
const index = new SourceIndex(db);

const hits = index.search(query, { limit: 15 });
const stats = index.stats();

if (hits.length === 0) {
  console.log(`No matches for "${query}" (index holds ${stats.total} sources).`);
} else {
  console.log(`${hits.length} match(es) for "${query}":\n`);
  for (const hit of hits) {
    const where =
      hit.kind === "discord"
        ? `#${hit.channel_name ?? hit.channel_id} · ${hit.author ?? "unknown"}`
        : (hit.title ?? "drive document");
    console.log(`${where} · ${new Date(hit.ts).toISOString().slice(0, 10)}`);
    console.log(`  ${hit.snippet.replace(/\s+/g, " ")}`);
    console.log(`  ${hit.url}\n`);
  }
}

db.close();
