-- MailHarbor portal schema.
-- Lives in its own `portal` schema so listmonk's native tables are never
-- modified. listmonk remains the system of record for subscribers, lists and
-- campaigns; these tables add audit, suppression, consent and import history.

-- The `portal` schema is created by the migration runner (or pre-created for a
-- least-privilege role by deploy/postgres/portal-role.sql).

-- Portal operators (separate from listmonk's own admin users).
CREATE TABLE portal.users (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email           TEXT NOT NULL,
    name            TEXT NOT NULL,
    password_hash   TEXT NOT NULL,
    role            TEXT NOT NULL CHECK (role IN ('admin', 'manager', 'viewer')),
    status          TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
    failed_logins   INTEGER NOT NULL DEFAULT 0,
    locked_until    TIMESTAMPTZ,
    last_login_at   TIMESTAMPTZ,
    password_changed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX users_email_uniq ON portal.users (LOWER(email));

-- express-session store (connect-pg-simple layout).
CREATE TABLE portal.sessions (
    sid     VARCHAR NOT NULL PRIMARY KEY,
    sess    JSON NOT NULL,
    expire  TIMESTAMP(6) NOT NULL
);
CREATE INDEX sessions_expire_idx ON portal.sessions (expire);

-- Permanent suppression register. A row with lifted_at IS NULL blocks the
-- address from ever being imported or re-activated without an authorised,
-- documented reactivation. email may be NULL after a POPIA erasure; the hash
-- keeps the suppression effective with the minimum personal information.
CREATE TABLE portal.suppressions (
    id              BIGSERIAL PRIMARY KEY,
    email           TEXT,
    email_hash      TEXT NOT NULL,
    reason          TEXT NOT NULL CHECK (reason IN
                      ('hard_bounce', 'complaint', 'unsubscribe', 'manual', 'blocklisted', 'erased')),
    source          TEXT NOT NULL DEFAULT '',
    details         JSONB NOT NULL DEFAULT '{}'::jsonb,
    subscriber_id   INTEGER,
    created_by      UUID REFERENCES portal.users(id) ON DELETE SET NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    lifted_at       TIMESTAMPTZ,
    lifted_by       UUID REFERENCES portal.users(id) ON DELETE SET NULL,
    lift_reason     TEXT,
    lift_basis      JSONB
);
CREATE UNIQUE INDEX suppressions_active_uniq ON portal.suppressions (email_hash) WHERE lifted_at IS NULL;
CREATE INDEX suppressions_created_idx ON portal.suppressions (created_at DESC);
CREATE INDEX suppressions_reason_idx ON portal.suppressions (reason) WHERE lifted_at IS NULL;

-- Every status change and noteworthy action per recipient.
CREATE TABLE portal.recipient_events (
    id              BIGSERIAL PRIMARY KEY,
    subscriber_id   INTEGER,
    email_hash      TEXT,
    event_type      TEXT NOT NULL,
    from_status     TEXT,
    to_status       TEXT,
    details         JSONB NOT NULL DEFAULT '{}'::jsonb,
    actor_type      TEXT NOT NULL CHECK (actor_type IN ('user', 'system', 'listmonk')),
    actor_id        UUID REFERENCES portal.users(id) ON DELETE SET NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX recipient_events_sub_idx ON portal.recipient_events (subscriber_id, created_at DESC);
CREATE INDEX recipient_events_hash_idx ON portal.recipient_events (email_hash, created_at DESC);
CREATE INDEX recipient_events_type_idx ON portal.recipient_events (event_type, created_at DESC);

-- Detailed, classified copy of each listmonk bounce record.
CREATE TABLE portal.bounce_events (
    id                  BIGSERIAL PRIMARY KEY,
    listmonk_bounce_id  INTEGER NOT NULL UNIQUE,
    subscriber_id       INTEGER,
    email_hash          TEXT,
    campaign_id         INTEGER,
    listmonk_type       TEXT NOT NULL,
    classification      TEXT NOT NULL CHECK (classification IN ('hard', 'soft', 'complaint', 'review')),
    smtp_code           TEXT,
    enhanced_code       TEXT,
    reason              TEXT,
    source              TEXT,
    action_taken        TEXT NOT NULL DEFAULT 'none',
    bounced_at          TIMESTAMPTZ NOT NULL,
    processed_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX bounce_events_sub_idx ON portal.bounce_events (subscriber_id, bounced_at DESC);
CREATE INDEX bounce_events_date_idx ON portal.bounce_events (bounced_at DESC);
CREATE INDEX bounce_events_camp_idx ON portal.bounce_events (campaign_id);

-- Consent evidence (POPIA section 69).
CREATE TABLE portal.consent_records (
    id              BIGSERIAL PRIMARY KEY,
    subscriber_id   INTEGER,
    email           TEXT,
    email_hash      TEXT NOT NULL,
    action          TEXT NOT NULL CHECK (action IN ('granted', 'withdrawn', 'reconfirmed')),
    method          TEXT NOT NULL DEFAULT '',
    purpose         TEXT NOT NULL DEFAULT '',
    source          TEXT NOT NULL DEFAULT '',
    obtained_at     TIMESTAMPTZ,
    evidence        TEXT NOT NULL DEFAULT '',
    import_id       UUID,
    recorded_by     UUID REFERENCES portal.users(id) ON DELETE SET NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX consent_records_hash_idx ON portal.consent_records (email_hash, created_at DESC);
CREATE INDEX consent_records_sub_idx ON portal.consent_records (subscriber_id);
CREATE INDEX consent_records_created_idx ON portal.consent_records (created_at DESC);

-- CSV import sessions and their staged rows.
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
    subscriber_id   INTEGER,
    PRIMARY KEY (import_id, row_no)
);
CREATE INDEX import_rows_class_idx ON portal.import_rows (import_id, classification);

-- Contacts that need a human decision (e.g. 5.7.1 policy rejections).
CREATE TABLE portal.review_queue (
    id              BIGSERIAL PRIMARY KEY,
    subscriber_id   INTEGER NOT NULL,
    email_hash      TEXT NOT NULL,
    reason          TEXT NOT NULL,
    details         JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    resolved_at     TIMESTAMPTZ,
    resolved_by     UUID REFERENCES portal.users(id) ON DELETE SET NULL,
    resolution      TEXT
);
CREATE UNIQUE INDEX review_queue_open_uniq ON portal.review_queue (subscriber_id) WHERE resolved_at IS NULL;

-- Administrative audit trail.
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

-- Operational alerts (bounce mailbox failures, sync failures, etc).
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

-- Small key/value store for sync cursors and worker heartbeats.
CREATE TABLE portal.sync_state (
    key         TEXT PRIMARY KEY,
    value       JSONB NOT NULL,
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
