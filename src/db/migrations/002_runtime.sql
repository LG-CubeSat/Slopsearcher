ALTER TABLE sources ADD COLUMN deleted_at INTEGER;
ALTER TABLE sources ADD COLUMN extracted_hash TEXT;
ALTER TABLE memories ADD COLUMN stale_at INTEGER;
ALTER TABLE memory_sources ADD COLUMN source_hash TEXT;
ALTER TABLE tasks ADD COLUMN kind TEXT NOT NULL DEFAULT 'research' CHECK(kind IN ('question','research'));
ALTER TABLE tasks ADD COLUMN context_json TEXT NOT NULL DEFAULT '{}';
ALTER TABLE tasks ADD COLUMN report_text TEXT;
ALTER TABLE tasks ADD COLUMN turn_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE tasks ADD COLUMN next_run_at INTEGER NOT NULL DEFAULT 0;
ALTER TABLE tasks ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE tasks ADD COLUMN delivery_pending INTEGER NOT NULL DEFAULT 0;
ALTER TABLE tasks ADD COLUMN output_message_id TEXT;
CREATE UNIQUE INDEX tasks_origin_unique ON tasks(origin_message_id) WHERE origin_message_id IS NOT NULL;
CREATE INDEX sources_pending_extraction ON sources(extracted_hash, deleted_at);
CREATE TABLE drive_files (
  file_id TEXT PRIMARY KEY,
  modified_time TEXT,
  metadata_json TEXT NOT NULL,
  indexed_at INTEGER NOT NULL
);
CREATE TABLE service_state (key TEXT PRIMARY KEY, value TEXT NOT NULL);
DROP TRIGGER sources_au;
CREATE TRIGGER sources_au AFTER UPDATE OF text,title,author ON sources
WHEN old.text IS NOT new.text OR old.title IS NOT new.title OR old.author IS NOT new.author BEGIN
  INSERT INTO sources_fts(sources_fts,rowid,text,title,author) VALUES('delete',old.id,old.text,old.title,old.author);
  INSERT INTO sources_fts(rowid,text,title,author) VALUES(new.id,new.text,new.title,new.author);
END;
