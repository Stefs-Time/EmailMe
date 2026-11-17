-- Ready-made template designs: remember which preset a template came from,
-- so campaign samples can use the matching template.
ALTER TABLE portal.templates ADD COLUMN IF NOT EXISTS sample_key TEXT;
CREATE INDEX IF NOT EXISTS templates_sample_key_idx ON portal.templates (sample_key) WHERE sample_key IS NOT NULL;
