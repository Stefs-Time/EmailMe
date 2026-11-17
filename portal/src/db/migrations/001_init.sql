-- MailHarbor schema: a self-contained email marketing and recipient
-- management platform (contacts, lists, campaigns, sending, tracking,
-- bounces, suppression, consent, audit). Everything lives in `portal`.

-- ---------------------------------------------------------------------------
-- Platform
-- ---------------------------------------------------------------------------
CREATE TABLE portal.settings (
    key         TEXT PRIMARY KEY,
    value       JSONB NOT NULL,
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_by  UUID
);

-- Values the application generates for itself (session secret, encryption key).
CREATE TABLE portal.app_secrets (
    key         TEXT PRIMARY KEY,
    value       TEXT NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE portal.users (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email           TEXT NOT NULL,
    name            TEXT NOT NULL,
    password_hash   TEXT NOT NULL,
    role            TEXT NOT NULL CHECK (role IN ('admin', 'manager', 'viewer')),
    status          TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
    managed_by_env  BOOLEAN NOT NULL DEFAULT FALSE,
    failed_logins   INTEGER NOT NULL DEFAULT 0,
    locked_until    TIMESTAMPTZ,
    last_login_at   TIMESTAMPTZ,
    password_changed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX users_email_uniq ON portal.users (LOWER(email));

CREATE TABLE portal.sessions (
    sid     VARCHAR NOT NULL PRIMARY KEY,
    sess    JSON NOT NULL,
    expire  TIMESTAMP(6) NOT NULL
);
CREATE INDEX sessions_expire_idx ON portal.sessions (expire);

-- ---------------------------------------------------------------------------
-- Audience
-- ---------------------------------------------------------------------------
CREATE TABLE portal.lists (
    id          SERIAL PRIMARY KEY,
    name        TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    optin       TEXT NOT NULL DEFAULT 'single' CHECK (optin IN ('single', 'double')),
    tags        TEXT[] NOT NULL DEFAULT '{}',
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX lists_name_uniq ON portal.lists (LOWER(name));

CREATE TABLE portal.contacts (
    id              SERIAL PRIMARY KEY,
    uuid            UUID NOT NULL UNIQUE DEFAULT gen_random_uuid(),
    email           TEXT NOT NULL,
    -- SHA-256 of the lower-cased address, kept in sync by the application;
    -- joins against the suppression register survive erasure.
    email_hash      TEXT NOT NULL,
    first_name      TEXT NOT NULL DEFAULT '',
    last_name       TEXT NOT NULL DEFAULT '',
    company         TEXT NOT NULL DEFAULT '',
    source          TEXT NOT NULL DEFAULT '',
    attribs         JSONB NOT NULL DEFAULT '{}'::jsonb,
    consent         JSONB NOT NULL DEFAULT '{}'::jsonb,
    soft_bounces    INTEGER NOT NULL DEFAULT 0,
    last_sent_at    TIMESTAMPTZ,
    last_open_at    TIMESTAMPTZ,
    last_click_at   TIMESTAMPTZ,
    last_bounce_at  TIMESTAMPTZ,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX contacts_email_uniq ON portal.contacts (LOWER(email));
CREATE INDEX contacts_hash_idx ON portal.contacts (email_hash);
CREATE INDEX contacts_created_idx ON portal.contacts (created_at DESC);
CREATE INDEX contacts_source_idx ON portal.contacts (source);

CREATE TABLE portal.list_members (
    contact_id      INTEGER NOT NULL REFERENCES portal.contacts(id) ON DELETE CASCADE,
    list_id         INTEGER NOT NULL REFERENCES portal.lists(id) ON DELETE CASCADE,
    -- subscribed: receives campaigns. unconfirmed: awaiting double opt-in.
    -- unsubscribed: opted out of this list; never re-added automatically.
    status          TEXT NOT NULL CHECK (status IN ('subscribed', 'unconfirmed', 'unsubscribed')),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    confirmed_at    TIMESTAMPTZ,
    unsubscribed_at TIMESTAMPTZ,
    PRIMARY KEY (contact_id, list_id)
);
CREATE INDEX list_members_list_idx ON portal.list_members (list_id, status);

-- ---------------------------------------------------------------------------
-- Campaigns and delivery
-- ---------------------------------------------------------------------------
CREATE TABLE portal.templates (
    id          SERIAL PRIMARY KEY,
    name        TEXT NOT NULL,
    html        TEXT NOT NULL,
    is_default  BOOLEAN NOT NULL DEFAULT FALSE,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX templates_one_default ON portal.templates (is_default) WHERE is_default;

CREATE TABLE portal.campaigns (
    id              SERIAL PRIMARY KEY,
    uuid            UUID NOT NULL UNIQUE DEFAULT gen_random_uuid(),
    name            TEXT NOT NULL,
    subject         TEXT NOT NULL DEFAULT '',
    preheader       TEXT NOT NULL DEFAULT '',
    from_name       TEXT NOT NULL DEFAULT '',
    from_email      TEXT NOT NULL DEFAULT '',
    reply_to        TEXT NOT NULL DEFAULT '',
    template_id     INTEGER REFERENCES portal.templates(id) ON DELETE SET NULL,
    editor          TEXT NOT NULL DEFAULT 'visual' CHECK (editor IN ('visual', 'html')),
    body_html       TEXT NOT NULL DEFAULT '',
    body_text       TEXT NOT NULL DEFAULT '',
    track_opens     BOOLEAN NOT NULL DEFAULT TRUE,
    track_clicks    BOOLEAN NOT NULL DEFAULT TRUE,
    status          TEXT NOT NULL DEFAULT 'draft'
                      CHECK (status IN ('draft', 'scheduled', 'sending', 'paused', 'cancelled', 'sent')),
    send_at         TIMESTAMPTZ,
    started_at      TIMESTAMPTZ,
    finished_at     TIMESTAMPTZ,
    pause_reason    TEXT,
    created_by      UUID REFERENCES portal.users(id) ON DELETE SET NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX campaigns_status_idx ON portal.campaigns (status, send_at);

CREATE TABLE portal.campaign_lists (
    campaign_id INTEGER NOT NULL REFERENCES portal.campaigns(id) ON DELETE CASCADE,
    list_id     INTEGER REFERENCES portal.lists(id) ON DELETE SET NULL,
    list_name   TEXT NOT NULL,
    UNIQUE (campaign_id, list_id)
);

-- One row per individual email (campaign recipient, opt-in or test).
-- `uuid` is the recipient token used in unsubscribe and tracking links.
CREATE TABLE portal.messages (
    id              BIGSERIAL PRIMARY KEY,
    uuid            UUID NOT NULL UNIQUE DEFAULT gen_random_uuid(),
    kind            TEXT NOT NULL CHECK (kind IN ('campaign', 'optin', 'test')),
    campaign_id     INTEGER REFERENCES portal.campaigns(id) ON DELETE CASCADE,
    contact_id      INTEGER REFERENCES portal.contacts(id) ON DELETE SET NULL,
    email           TEXT,
    status          TEXT NOT NULL DEFAULT 'queued'
                      CHECK (status IN ('queued', 'sending', 'sent', 'failed', 'skipped', 'cancelled', 'unknown')),
    attempts        INTEGER NOT NULL DEFAULT 0,
    next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    sent_at         TIMESTAMPTZ,
    smtp_message_id TEXT,
    error           TEXT,
    payload         JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX messages_queue_idx ON portal.messages (next_attempt_at, id) WHERE status = 'queued';
CREATE INDEX messages_campaign_idx ON portal.messages (campaign_id, status);
CREATE INDEX messages_contact_idx ON portal.messages (contact_id, created_at DESC);
CREATE UNIQUE INDEX messages_campaign_contact_uniq ON portal.messages (campaign_id, contact_id) WHERE kind = 'campaign';

CREATE TABLE portal.links (
    id          SERIAL PRIMARY KEY,
    campaign_id INTEGER NOT NULL REFERENCES portal.campaigns(id) ON DELETE CASCADE,
    url         TEXT NOT NULL,
    UNIQUE (campaign_id, url)
);

CREATE TABLE portal.tracking_events (
    id          BIGSERIAL PRIMARY KEY,
    kind        TEXT NOT NULL CHECK (kind IN ('open', 'click')),
    message_id  BIGINT REFERENCES portal.messages(id) ON DELETE CASCADE,
    campaign_id INTEGER REFERENCES portal.campaigns(id) ON DELETE CASCADE,
    contact_id  INTEGER REFERENCES portal.contacts(id) ON DELETE SET NULL,
    link_id     INTEGER REFERENCES portal.links(id) ON DELETE SET NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX tracking_campaign_idx ON portal.tracking_events (campaign_id, kind, created_at);
CREATE INDEX tracking_contact_idx ON portal.tracking_events (contact_id, created_at DESC);

-- ---------------------------------------------------------------------------
-- Delivery outcomes, suppression, consent
-- ---------------------------------------------------------------------------
CREATE TABLE portal.bounce_events (
    id              BIGSERIAL PRIMARY KEY,
    source          TEXT NOT NULL CHECK (source IN ('smtp', 'mailbox', 'webhook', 'manual')),
    source_ref      TEXT,
    message_id      BIGINT REFERENCES portal.messages(id) ON DELETE SET NULL,
    contact_id      INTEGER REFERENCES portal.contacts(id) ON DELETE SET NULL,
    email_hash      TEXT,
    campaign_id     INTEGER REFERENCES portal.campaigns(id) ON DELETE SET NULL,
    classification  TEXT NOT NULL CHECK (classification IN ('hard', 'soft', 'complaint', 'review')),
    smtp_code       TEXT,
    enhanced_code   TEXT,
    reason          TEXT,
    diagnostic      TEXT,
    action_taken    TEXT NOT NULL DEFAULT 'recorded',
    bounced_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX bounce_events_ref_uniq ON portal.bounce_events (source, source_ref) WHERE source_ref IS NOT NULL;
CREATE INDEX bounce_events_contact_idx ON portal.bounce_events (contact_id, bounced_at DESC);
CREATE INDEX bounce_events_date_idx ON portal.bounce_events (bounced_at DESC);
CREATE INDEX bounce_events_campaign_idx ON portal.bounce_events (campaign_id);

-- Permanent suppression register (scope §4). One active row per address.
CREATE TABLE portal.suppressions (
    id              BIGSERIAL PRIMARY KEY,
    email           TEXT,
    email_hash      TEXT NOT NULL,
    reason          TEXT NOT NULL CHECK (reason IN
                      ('hard_bounce', 'soft_limit', 'complaint', 'unsubscribe', 'manual', 'erased')),
    source          TEXT NOT NULL DEFAULT '',
    details         JSONB NOT NULL DEFAULT '{}'::jsonb,
    contact_id      INTEGER,
    campaign_id     INTEGER,
    created_by      UUID REFERENCES portal.users(id) ON DELETE SET NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    lifted_at       TIMESTAMPTZ,
    lifted_by       UUID REFERENCES portal.users(id) ON DELETE SET NULL,
    lift_reason     TEXT,
    lift_basis      JSONB
);
CREATE UNIQUE INDEX suppressions_active_uniq ON portal.suppressions (email_hash) WHERE lifted_at IS NULL;
CREATE INDEX suppressions_created_idx ON portal.suppressions (created_at DESC);

CREATE TABLE portal.review_queue (
    id              BIGSERIAL PRIMARY KEY,
    contact_id      INTEGER NOT NULL REFERENCES portal.contacts(id) ON DELETE CASCADE,
    email_hash      TEXT NOT NULL,
    reason          TEXT NOT NULL,
    details         JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    resolved_at     TIMESTAMPTZ,
    resolved_by     UUID REFERENCES portal.users(id) ON DELETE SET NULL,
    resolution      TEXT
);
CREATE UNIQUE INDEX review_queue_open_uniq ON portal.review_queue (contact_id) WHERE resolved_at IS NULL;

CREATE TABLE portal.consent_records (
    id              BIGSERIAL PRIMARY KEY,
    contact_id      INTEGER,
    email           TEXT,
    email_hash      TEXT NOT NULL,
    action          TEXT NOT NULL CHECK (action IN ('granted', 'withdrawn', 'reconfirmed')),
    method          TEXT NOT NULL DEFAULT '',
    purpose         TEXT NOT NULL DEFAULT '',
    source          TEXT NOT NULL DEFAULT '',
    obtained_at     TIMESTAMPTZ,
    evidence        TEXT NOT NULL DEFAULT '',
    import_id       UUID,
    campaign_id     INTEGER,
    recorded_by     UUID REFERENCES portal.users(id) ON DELETE SET NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX consent_records_hash_idx ON portal.consent_records (email_hash, created_at DESC);
CREATE INDEX consent_records_created_idx ON portal.consent_records (created_at DESC);

CREATE TABLE portal.recipient_events (
    id              BIGSERIAL PRIMARY KEY,
    contact_id      INTEGER,
    email_hash      TEXT,
    campaign_id     INTEGER,
    event_type      TEXT NOT NULL,
    from_status     TEXT,
    to_status       TEXT,
    details         JSONB NOT NULL DEFAULT '{}'::jsonb,
    actor_type      TEXT NOT NULL CHECK (actor_type IN ('user', 'system', 'recipient')),
    actor_id        UUID REFERENCES portal.users(id) ON DELETE SET NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX recipient_events_contact_idx ON portal.recipient_events (contact_id, created_at DESC);
CREATE INDEX recipient_events_hash_idx ON portal.recipient_events (email_hash, created_at DESC);
CREATE INDEX recipient_events_type_idx ON portal.recipient_events (event_type, created_at DESC);
CREATE INDEX recipient_events_campaign_idx ON portal.recipient_events (campaign_id, event_type) WHERE campaign_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- Imports, audit, operations
-- ---------------------------------------------------------------------------
CREATE TABLE portal.imports (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    filename        TEXT NOT NULL,
    status          TEXT NOT NULL CHECK (status IN
                      ('uploaded', 'previewed', 'committing', 'completed', 'failed', 'cancelled')),
    headers         JSONB NOT NULL DEFAULT '[]'::jsonb,
    mapping         JSONB NOT NULL DEFAULT '{}'::jsonb,
    options         JSONB NOT NULL DEFAULT '{}'::jsonb,
    total_rows      INTEGER NOT NULL DEFAULT 0,
    summary         JSONB NOT NULL DEFAULT '{}'::jsonb,
    error           TEXT,
    created_by      UUID REFERENCES portal.users(id) ON DELETE SET NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    completed_at    TIMESTAMPTZ,
    rows_purged_at  TIMESTAMPTZ
);
CREATE INDEX imports_created_idx ON portal.imports (created_at DESC);

CREATE TABLE portal.import_rows (
    import_id       UUID NOT NULL REFERENCES portal.imports(id) ON DELETE CASCADE,
    row_no          INTEGER NOT NULL,
    raw             JSONB NOT NULL,
    email           TEXT,
    data            JSONB,
    classification  TEXT,
    message         TEXT,
    contact_id      INTEGER,
    PRIMARY KEY (import_id, row_no)
);
CREATE INDEX import_rows_class_idx ON portal.import_rows (import_id, classification);

CREATE TABLE portal.audit_log (
    id              BIGSERIAL PRIMARY KEY,
    actor_id        UUID REFERENCES portal.users(id) ON DELETE SET NULL,
    actor_email     TEXT,
    action          TEXT NOT NULL,
    target_type     TEXT,
    target_id       TEXT,
    details         JSONB NOT NULL DEFAULT '{}'::jsonb,
    ip              TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX audit_log_created_idx ON portal.audit_log (created_at DESC);
CREATE INDEX audit_log_action_idx ON portal.audit_log (action, created_at DESC);

CREATE TABLE portal.alerts (
    id              BIGSERIAL PRIMARY KEY,
    key             TEXT NOT NULL,
    severity        TEXT NOT NULL CHECK (severity IN ('info', 'warning', 'critical')),
    message         TEXT NOT NULL,
    details         JSONB NOT NULL DEFAULT '{}'::jsonb,
    occurrences     INTEGER NOT NULL DEFAULT 1,
    first_seen      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_seen       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    resolved_at     TIMESTAMPTZ
);
CREATE UNIQUE INDEX alerts_open_uniq ON portal.alerts (key) WHERE resolved_at IS NULL;

-- Worker heartbeats and cursors.
CREATE TABLE portal.sync_state (
    key         TEXT PRIMARY KEY,
    value       JSONB NOT NULL,
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
