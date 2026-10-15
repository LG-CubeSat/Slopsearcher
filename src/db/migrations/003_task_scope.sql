ALTER TABLE tasks ADD COLUMN project_key TEXT NOT NULL DEFAULT '';
CREATE INDEX tasks_project ON tasks(project_key,requested_by,id);
