export type SourceKind = "discord" | "drive";

/** A source as the ingest modules hand it over, before it has a row ID. */
export interface SourceInput {
  kind: SourceKind;
  externalId: string;
  url: string;
  channelId?: string | null;
  channelName?: string | null;
  author?: string | null;
  parentId?: string | null;
  title?: string | null;
  ts: number;
  text: string;
}

export interface SourceRow {
  id: number;
  kind: SourceKind;
  external_id: string;
  url: string;
  channel_id: string | null;
  channel_name: string | null;
  author: string | null;
  parent_id: string | null;
  title: string | null;
  ts: number;
  text: string;
  content_hash: string;
  fetched_at: number;
  deleted_at: number | null;
  extracted_hash: string | null;
}

export interface SearchHit extends SourceRow {
  /** FTS5 bm25 score, lower is better; re-exposed so callers can re-rank. */
  score: number;
  snippet: string;
}

export interface SearchOptions {
  limit?: number;
  kind?: SourceKind;
  channelId?: string;
  allowedChannelIds?: string[];
  includeDrive?: boolean;
  /** Epoch ms bounds, inclusive. */
  after?: number;
  before?: number;
}
