-- Keep direct homework edits when a historical lesson is re-published.
ALTER TABLE tasks ADD COLUMN manualEditedAt TEXT NOT NULL DEFAULT '';
