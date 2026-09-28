-- Optional textbook name; legacy homework keeps its existing content.
ALTER TABLE tasks ADD COLUMN material TEXT NOT NULL DEFAULT '';
