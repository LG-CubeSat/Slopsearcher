import { createHash } from "node:crypto";
import type { Db } from "../db/index.ts";
import { toFtsQuery } from "./query.ts";
import type {
  SearchHit,
  SearchOptions,
  SourceInput,
  SourceRow,
} from "./types.ts";

/**
 * Hash the normalized text so that cosmetic differences (trailing whitespace,
 * CRLF from a Drive export) don't present as a changed document and trigger a
 * pointless reindex.
 */
export function contentHash(text: string): string {
  const normalized = text.replace(/\r\n/g, "\n").trim();
  return createHash("sha256").update(normalized).digest("hex");
}

export interface UpsertResult {
  inserted: number;
  updated: number;
  unchanged: number;
}

export class SourceIndex {
  readonly #db: Db;

  constructor(db: Db) {
    this.#db = db;
  }

  /**
   * Idempotent write. A source whose hash is unchanged is left completely
   * alone -- no UPDATE, so the FTS triggers don't fire and reindexing an
   * already-indexed channel costs a hash comparison per row.
   */
  upsertMany(inputs: readonly SourceInput[]): UpsertResult {
    const selectExisting = this.#db.prepare<
      [string, string],
      { id: number; content_hash: string; deleted_at: number | null }
    >(
      "SELECT id, content_hash, deleted_at FROM sources WHERE kind = ? AND external_id = ?",
    );

    const insert = this.#db.prepare(
      `INSERT INTO sources
         (kind, external_id, url, channel_id, channel_name, author, parent_id,
          title, ts, text, content_hash, fetched_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );

    const update = this.#db.prepare(
      `UPDATE sources
          SET url = ?, channel_id = ?, channel_name = ?, author = ?, parent_id = ?,
              title = ?, ts = ?, text = ?, content_hash = ?, fetched_at = ?, deleted_at = NULL, extracted_hash = NULL
        WHERE id = ?`,
    );

    const result: UpsertResult = { inserted: 0, updated: 0, unchanged: 0 };

    // One transaction for the whole batch: thousands of messages commit once
    // instead of once per row, which is the difference between a backfill
    // taking minutes and taking hours.
    this.#db.transaction(() => {
      for (const input of inputs) {
        const hash = contentHash(
          JSON.stringify([
            contentHash(input.text),
            input.title ?? null,
            input.url,
            input.channelId ?? null,
            input.channelName ?? null,
            input.author ?? null,
            input.parentId ?? null,
            input.ts,
          ]),
        );
        const now = Date.now();
        const existing = selectExisting.get(input.kind, input.externalId);

        if (!existing) {
          insert.run(
            input.kind,
            input.externalId,
            input.url,
            input.channelId ?? null,
            input.channelName ?? null,
            input.author ?? null,
            input.parentId ?? null,
            input.title ?? null,
            input.ts,
            input.text,
            hash,
            now,
          );
          result.inserted += 1;
        } else if (
          existing.content_hash !== hash ||
          existing.deleted_at !== null
        ) {
          update.run(
            input.url,
            input.channelId ?? null,
            input.channelName ?? null,
            input.author ?? null,
            input.parentId ?? null,
            input.title ?? null,
            input.ts,
            input.text,
            hash,
            now,
            existing.id,
          );
          this.#db
            .prepare(
              "UPDATE memories SET stale_at = COALESCE(stale_at, ?) WHERE id IN (SELECT memory_id FROM memory_sources WHERE source_id = ?)",
            )
            .run(now, existing.id);
          result.updated += 1;
        } else {
          this.#db
            .prepare("UPDATE sources SET fetched_at = ? WHERE id = ?")
            .run(now, existing.id);
          result.unchanged += 1;
        }
      }
    })();

    return result;
  }

  upsert(input: SourceInput): UpsertResult {
    return this.upsertMany([input]);
  }

  /** BM25-ranked full-text search over indexed messages and documents. */
  search(rawQuery: string, options: SearchOptions = {}): SearchHit[] {
    const match = toFtsQuery(rawQuery);
    if (match === null) return [];

    const limit = Math.min(Math.max(options.limit ?? 20, 1), 200);
    const filters: string[] = ["s.deleted_at IS NULL"];
    const params: unknown[] = [match];

    if (options.allowedChannelIds) {
      const ids = options.allowedChannelIds;
      filters.push(
        `(s.kind = 'drive' ${options.includeDrive === false ? "AND 0" : ""} OR s.channel_id IN (${ids.map(() => "?").join(",") || "NULL"}))`,
      );
      params.push(...ids);
    }
    if (options.includeDrive === false) filters.push("s.kind != 'drive'");
    if (options.kind) {
      filters.push("s.kind = ?");
      params.push(options.kind);
    }
    if (options.channelId) {
      filters.push("s.channel_id = ?");
      params.push(options.channelId);
    }
    if (options.after !== undefined) {
      filters.push("s.ts >= ?");
      params.push(options.after);
    }
    if (options.before !== undefined) {
      filters.push("s.ts <= ?");
      params.push(options.before);
    }

    const where = filters.length > 0 ? `AND ${filters.join(" AND ")}` : "";
    params.push(limit);

    return this.#db
      .prepare<unknown[], SearchHit>(
        `SELECT s.*,
                bm25(sources_fts, 10.0, 5.0, 1.0) AS score,
                snippet(sources_fts, 0, '«', '»', ' … ', 24) AS snippet
           FROM sources_fts
           JOIN sources s ON s.id = sources_fts.rowid
          WHERE sources_fts MATCH ?
            ${where}
          ORDER BY score
          LIMIT ?`,
      )
      .all(...params);
  }

  getById(id: number): SourceRow | null {
    return (
      this.#db
        .prepare<[number], SourceRow>(
          "SELECT * FROM sources WHERE id = ? AND deleted_at IS NULL",
        )
        .get(id) ?? null
    );
  }

  getByExternalId(
    kind: SourceRow["kind"],
    externalId: string,
  ): SourceRow | null {
    return (
      this.#db
        .prepare<[string, string], SourceRow>(
          "SELECT * FROM sources WHERE kind = ? AND external_id = ? AND deleted_at IS NULL",
        )
        .get(kind, externalId) ?? null
    );
  }

  /**
   * The messages surrounding a given one. This is what lets the bot "account
   * for the message being replied to and the nearby conversation" -- a Discord
   * answer is rarely self-contained, so a hit is close to useless without the
   * exchange around it.
   */
  getConversation(
    messageId: string,
    radius = 10,
  ): { anchor: SourceRow; before: SourceRow[]; after: SourceRow[] } | null {
    const anchor = this.getByExternalId("discord", messageId);
    if (!anchor || anchor.channel_id === null) return null;

    const span = Math.min(Math.max(radius, 1), 100);

    const before = this.#db
      .prepare<[string, number, number], SourceRow>(
        `SELECT * FROM sources
          WHERE deleted_at IS NULL AND channel_id = ? AND ts < ?
          ORDER BY ts DESC LIMIT ?`,
      )
      .all(anchor.channel_id, anchor.ts, span)
      .reverse();

    const after = this.#db
      .prepare<[string, number, number], SourceRow>(
        `SELECT * FROM sources
          WHERE deleted_at IS NULL AND channel_id = ? AND ts > ?
          ORDER BY ts ASC LIMIT ?`,
      )
      .all(anchor.channel_id, anchor.ts, span);

    return { anchor, before, after };
  }

  /** Walks `parent_id` up to the root of a reply chain. */
  getReplyChain(messageId: string, maxDepth = 10): SourceRow[] {
    const chain: SourceRow[] = [];
    const seen = new Set<string>();
    let cursor: string | null = messageId;

    while (cursor !== null && chain.length < maxDepth && !seen.has(cursor)) {
      seen.add(cursor);
      const row: SourceRow | null = this.getByExternalId("discord", cursor);
      if (!row) break;
      chain.unshift(row);
      cursor = row.parent_id;
    }
    return chain;
  }

  retire(kind: SourceRow["kind"], externalId: string): void {
    this.#db.transaction(() => {
      const row = this.getByExternalId(kind, externalId);
      if (!row) return;
      this.#db
        .prepare("UPDATE sources SET deleted_at = ? WHERE id = ?")
        .run(Date.now(), row.id);
      this.#db
        .prepare(
          "UPDATE memories SET stale_at = COALESCE(stale_at, ?) WHERE id IN (SELECT memory_id FROM memory_sources WHERE source_id = ?)",
        )
        .run(Date.now(), row.id);
    })();
  }

  stats(): { total: number; discord: number; drive: number } {
    const row = this.#db
      .prepare<[], { total: number; discord: number; drive: number }>(
        `SELECT COUNT(*) AS total,
                COALESCE(SUM(kind = 'discord'), 0) AS discord,
                COALESCE(SUM(kind = 'drive'), 0) AS drive
           FROM sources WHERE deleted_at IS NULL`,
      )
      .get();
    return row ?? { total: 0, discord: 0, drive: 0 };
  }
}
