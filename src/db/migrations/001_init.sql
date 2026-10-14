-- Everything the service knows, in one table. Discord messages and Drive
-- documents share a shape so search, citation, and the runner tools never have
-- to branch on where a fact came from.
CREATE TABLE sources (
  id            INTEGER PRIMARY KEY,
  kind          TEXT    NOT NULL CHECK (kind IN ('discord', 'drive')),
  external_id   TEXT    NOT NULL,          -- Discord message ID / Drive file ID
  url           TEXT    NOT NULL,          -- jump link or Drive view URL
  channel_id    TEXT,                      -- Discord channel; NULL for Drive
  channel_name  TEXT,
  author        TEXT,
  parent_id     TEXT,                      -- replied-to message ID, if any
  title         TEXT,                      -- Drive file title; NULL for Discord
  ts            INTEGER NOT NULL,          -- epoch ms of the source's own time
  text          TEXT    NOT NULL,
  content_hash  TEXT    NOT NULL,          -- sha256 of normalized text
  fetched_at    INTEGER NOT NULL
);

-- Re-ingesting the same message must be a no-op, which is what makes backfill
-- safely restartable and reindexing nearly free.
CREATE UNIQUE INDEX sources_external_uniq ON sources (kind, external_id);

-- Fetching the conversation around a message is the hot path for @-mentions.
CREATE INDEX sources_channel_ts ON sources (channel_id, ts);
CREATE INDEX sources_ts         ON sources (ts);
CREATE INDEX sources_parent     ON sources (parent_id);

-- External-content FTS5: the text lives once, in `sources`. The index stores
-- only the terms, and triggers keep the two in step.
CREATE VIRTUAL TABLE sources_fts USING fts5 (
  text,
  title,
  author,
  content = 'sources',
  content_rowid = 'id',
  tokenize = 'unicode61 remove_diacritics 2'
);

CREATE TRIGGER sources_ai AFTER INSERT ON sources BEGIN
  INSERT INTO sources_fts (rowid, text, title, author)
  VALUES (new.id, new.text, new.title, new.author);
END;

CREATE TRIGGER sources_ad AFTER DELETE ON sources BEGIN
  INSERT INTO sources_fts (sources_fts, rowid, text, title, author)
  VALUES ('delete', old.id, old.text, old.title, old.author);
END;

CREATE TRIGGER sources_au AFTER UPDATE ON sources BEGIN
  INSERT INTO sources_fts (sources_fts, rowid, text, title, author)
  VALUES ('delete', old.id, old.text, old.title, old.author);
  INSERT INTO sources_fts (rowid, text, title, author)
  VALUES (new.id, new.text, new.title, new.author);
END;

-- Distilled project knowledge. A memory is never deleted when it goes stale --
-- it is superseded, so the history of a decision stays answerable.
CREATE TABLE memories (
  id            INTEGER PRIMARY KEY,
  claim         TEXT    NOT NULL,
  kind          TEXT    NOT NULL CHECK (
                  kind IN ('fact', 'decision', 'requirement', 'rationale', 'open_question')
                ),
  subsystem     TEXT,                      -- 'adcs', 'thermals', 'obc', ...
  confidence    REAL    NOT NULL DEFAULT 0.5 CHECK (confidence BETWEEN 0 AND 1),
  created_at    INTEGER NOT NULL,
  superseded_by INTEGER REFERENCES memories (id) ON DELETE SET NULL
);

CREATE INDEX memories_kind      ON memories (kind);
CREATE INDEX memories_subsystem ON memories (subsystem);
CREATE INDEX memories_live      ON memories (superseded_by) WHERE superseded_by IS NULL;

-- A memory with no source cannot be cited, and an uncitable memory is worse
-- than no memory. The extraction path enforces at least one row here.
CREATE TABLE memory_sources (
  memory_id INTEGER NOT NULL REFERENCES memories (id) ON DELETE CASCADE,
  source_id INTEGER NOT NULL REFERENCES sources (id) ON DELETE CASCADE,
  PRIMARY KEY (memory_id, source_id)
);

CREATE INDEX memory_sources_source ON memory_sources (source_id);

CREATE VIRTUAL TABLE memories_fts USING fts5 (
  claim,
  content = 'memories',
  content_rowid = 'id',
  tokenize = 'unicode61 remove_diacritics 2'
);

CREATE TRIGGER memories_ai AFTER INSERT ON memories BEGIN
  INSERT INTO memories_fts (rowid, claim) VALUES (new.id, new.claim);
END;

CREATE TRIGGER memories_ad AFTER DELETE ON memories BEGIN
  INSERT INTO memories_fts (memories_fts, rowid, claim) VALUES ('delete', old.id, old.claim);
END;

CREATE TRIGGER memories_au AFTER UPDATE ON memories BEGIN
  INSERT INTO memories_fts (memories_fts, rowid, claim) VALUES ('delete', old.id, old.claim);
  INSERT INTO memories_fts (rowid, claim) VALUES (new.id, new.claim);
END;

-- Long-running investigations. `runner_thread_id` is what lets a task survive a
-- restart: on boot we resume the runner thread rather than starting over.
CREATE TABLE tasks (
  id                 INTEGER PRIMARY KEY,
  question           TEXT    NOT NULL,
  requested_by       TEXT,
  origin_channel_id  TEXT,
  origin_message_id  TEXT,
  discord_channel_id TEXT,                 -- the dedicated slopsearches channel
  runner_thread_id   TEXT,
  status             TEXT    NOT NULL CHECK (
                       status IN ('pending', 'running', 'paused', 'completed', 'failed', 'cancelled')
                     ),
  progress_json      TEXT    NOT NULL DEFAULT '{}',
  report_file_id     TEXT,                 -- Drive file once the report is written
  error              TEXT,
  created_at         INTEGER NOT NULL,
  updated_at         INTEGER NOT NULL
);

CREATE INDEX tasks_status ON tasks (status);

-- Append-only. A restart replays this log instead of inferring what happened.
CREATE TABLE task_events (
  id        INTEGER PRIMARY KEY,
  task_id   INTEGER NOT NULL REFERENCES tasks (id) ON DELETE CASCADE,
  at        INTEGER NOT NULL,
  type      TEXT    NOT NULL,
  data_json TEXT    NOT NULL DEFAULT '{}'
);

CREATE INDEX task_events_task ON task_events (task_id, id);

-- Resumption points: ('discord', <channel id>) -> last indexed message ID,
-- ('drive', 'page_token') -> changes.list token.
CREATE TABLE cursors (
  scope      TEXT NOT NULL,
  key        TEXT NOT NULL,
  value      TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (scope, key)
);
