-- Templates can be designed in the drag-and-drop builder. The design is kept in
-- body_json; html holds the server-rendered (sanitised) result used for sending.
ALTER TABLE portal.templates
  ADD COLUMN IF NOT EXISTS editor TEXT NOT NULL DEFAULT 'html' CHECK (editor IN ('builder', 'html')),
  ADD COLUMN IF NOT EXISTS body_json JSONB;
