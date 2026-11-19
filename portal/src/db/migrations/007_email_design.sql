-- Email design replaces templates: every email uses one layout built from
-- Settings → Email design. When a campaign starts, the layout it was sent with
-- is frozen here (with its content in body_html), so sent emails and their
-- "view in browser" pages never change afterwards.
--
-- portal.templates and campaigns.template_id are no longer used. They are kept,
-- untouched, so this change can be rolled back; a later migration may drop them.
ALTER TABLE portal.campaigns ADD COLUMN IF NOT EXISTS layout_html TEXT;
