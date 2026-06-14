ALTER TABLE takeoffs ADD COLUMN archived BOOLEAN NOT NULL DEFAULT FALSE;
CREATE INDEX takeoffs_archived_idx ON takeoffs(archived) WHERE archived = TRUE;
