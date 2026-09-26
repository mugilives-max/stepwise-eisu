-- Additive review metadata; existing doneAt remains the student's completion claim.
ALTER TABLE tasks ADD COLUMN reviewedAt TEXT NOT NULL DEFAULT '';
ALTER TABLE tasks ADD COLUMN reviewNote TEXT NOT NULL DEFAULT '';
