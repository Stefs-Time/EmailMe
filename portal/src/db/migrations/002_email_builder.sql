-- Drag-and-drop email builder: campaigns can store a block document from which
-- the server renders body_html. 'builder' becomes the default editor.
ALTER TABLE portal.campaigns DROP CONSTRAINT IF EXISTS campaigns_editor_check;
ALTER TABLE portal.campaigns
  ADD CONSTRAINT campaigns_editor_check CHECK (editor IN ('builder', 'visual', 'html')),
  ALTER COLUMN editor SET DEFAULT 'builder',
  ADD COLUMN IF NOT EXISTS body_json JSONB;
