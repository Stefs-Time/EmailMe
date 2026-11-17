-- Image library, sign-up forms, saved segments and UTM tagging.

-- Images: compressed on upload and stored in PostgreSQL (so they are in every
-- backup). Served publicly at /img/<token>.<ext> because email clients load them.
CREATE TABLE portal.images (
    id              SERIAL PRIMARY KEY,
    token           UUID NOT NULL UNIQUE DEFAULT gen_random_uuid(),
    name            TEXT NOT NULL,
    mime            TEXT NOT NULL CHECK (mime IN ('image/jpeg', 'image/png', 'image/gif')),
    width           INTEGER NOT NULL,
    height          INTEGER NOT NULL,
    bytes           INTEGER NOT NULL,
    original_bytes  INTEGER NOT NULL,
    sha256          TEXT NOT NULL,
    data            BYTEA NOT NULL,
    created_by      UUID REFERENCES portal.users(id) ON DELETE SET NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX images_sha_idx ON portal.images (sha256);
CREATE INDEX images_created_idx ON portal.images (created_at DESC);

-- Saved segments: rule sets evaluated live against contacts.
CREATE TABLE portal.segments (
    id          SERIAL PRIMARY KEY,
    name        TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    rules       JSONB NOT NULL,
    created_by  UUID REFERENCES portal.users(id) ON DELETE SET NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX segments_name_idx ON portal.segments (LOWER(name));

-- Campaigns: optional segment narrowing, UTM settings (frozen at start).
ALTER TABLE portal.campaigns
  ADD COLUMN segment_id INTEGER REFERENCES portal.segments(id) ON DELETE RESTRICT,
  ADD COLUMN segment_name TEXT,
  ADD COLUMN utm_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  ADD COLUMN utm_campaign TEXT NOT NULL DEFAULT '',
  ADD COLUMN utm_params JSONB;

-- Sign-up forms (hosted page + embeddable).
CREATE TABLE portal.forms (
    id              SERIAL PRIMARY KEY,
    token           UUID NOT NULL UNIQUE DEFAULT gen_random_uuid(),
    name            TEXT NOT NULL,
    status          TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
    list_ids        INTEGER[] NOT NULL,
    settings        JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_by      UUID REFERENCES portal.users(id) ON DELETE SET NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE portal.form_submissions (
    id          BIGSERIAL PRIMARY KEY,
    form_id     INTEGER NOT NULL REFERENCES portal.forms(id) ON DELETE CASCADE,
    contact_id  INTEGER REFERENCES portal.contacts(id) ON DELETE SET NULL,
    email_hash  TEXT,
    outcome     TEXT NOT NULL CHECK (outcome IN ('subscribed', 'confirmation_sent', 'already_subscribed', 'suppressed', 'rejected')),
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX form_submissions_form_idx ON portal.form_submissions (form_id, created_at DESC);
