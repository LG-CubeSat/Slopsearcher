ALTER TABLE tasks ADD COLUMN channel_closed_at INTEGER;
CREATE INDEX tasks_research_channel ON tasks(discord_channel_id,kind,project_key);
