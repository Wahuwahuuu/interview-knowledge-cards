-- Existing pending records remain pending; deployment must not execute old drafts.
ALTER TABLE user_import_batches ADD COLUMN error_message TEXT NOT NULL DEFAULT '';
