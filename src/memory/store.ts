import type { Db } from "../db/index.ts";
import { toFtsQuery } from "../index/query.ts";
import type { SourceRow } from "../index/types.ts";
import { z } from "zod";
export const noteSchema = z.object({ claim: z.string().min(1).max(3000), kind: z.enum(["fact","decision","requirement","rationale","open_question"]), subsystem: z.string().nullable(), confidence: z.number().min(0).max(1), sourceIds: z.array(z.number().int().positive()).min(1) });
export const extractionSchema = z.object({ notes: z.array(noteSchema).max(50) });
export class MemoryStore {
  constructor(readonly db: Db) {}
  pending(limit: number): SourceRow[] { return this.db.prepare<[number], SourceRow>("SELECT * FROM sources WHERE deleted_at IS NULL AND extracted_hash IS NOT content_hash ORDER BY ts DESC LIMIT ?").all(limit); }
  save(sources: SourceRow[], input: unknown): number {
    const { notes } = extractionSchema.parse(input);
    return this.db.transaction(() => {
      const current = sources.filter(s => this.db.prepare<[number, string], { id: number }>("SELECT id FROM sources WHERE id=? AND content_hash=? AND deleted_at IS NULL").get(s.id, s.content_hash));
      const valid = new Map(current.map(s => [s.id, s]));
      for (const source of current) this.db.prepare("UPDATE sources SET extracted_hash=content_hash WHERE id=?").run(source.id);
      let count = 0;
      for (const note of notes) {
        const ids = [...new Set(note.sourceIds)];
        if (ids.some(id => !valid.has(id))) continue;
        const id = this.db.prepare("INSERT INTO memories(claim,kind,subsystem,confidence,created_at) VALUES(?,?,?,?,?)").run(note.claim, note.kind, note.subsystem, note.confidence, Date.now()).lastInsertRowid;
        for (const sourceId of ids) this.db.prepare("INSERT INTO memory_sources(memory_id,source_id,source_hash) VALUES(?,?,?)").run(id, sourceId, valid.get(sourceId)!.content_hash);
        count++;
      }
      return count;
    })();
  }
  search(query: string, canRead: (source: SourceRow) => boolean): unknown[] {
    const match = toFtsQuery(query);
    if (!match) return [];
    const notes = this.db.prepare<[string], { id: number; claim: string; kind: string; subsystem: string | null; confidence: number }>(`SELECT m.id,m.claim,m.kind,m.subsystem,m.confidence FROM memories_fts f JOIN memories m ON m.id=f.rowid WHERE memories_fts MATCH ? AND m.stale_at IS NULL AND m.superseded_by IS NULL AND NOT EXISTS (SELECT 1 FROM memory_sources ms JOIN sources s ON s.id=ms.source_id WHERE ms.memory_id=m.id AND (s.deleted_at IS NOT NULL OR ms.source_hash IS NOT s.content_hash)) ORDER BY bm25(memories_fts) LIMIT 200`).all(match);
    return notes.flatMap(note => {
      const sources = this.db.prepare<[number], SourceRow>("SELECT s.* FROM sources s JOIN memory_sources ms ON ms.source_id=s.id WHERE ms.memory_id=?").all(note.id);
      return sources.length && sources.every(canRead) ? [{ ...note, sources: sources.map(s => ({ id: s.id, url: s.url, fetchedAt: s.fetched_at })) }] : [];
    }).slice(0, 20);
  }
}
