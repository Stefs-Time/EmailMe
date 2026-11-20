-- Inbox: replies to campaigns, read and answered inside MailHarbor.
--
-- A conversation is one thread with one correspondent, linked to the contact
-- and (when known) the campaign that started it. Messages are inbound replies,
-- outbound answers sent from MailHarbor, and internal notes.

CREATE TABLE portal.conversations (
    id              SERIAL PRIMARY KEY,
    contact_id      INTEGER REFERENCES portal.contacts(id) ON DELETE SET NULL,
    campaign_id     INTEGER REFERENCES portal.campaigns(id) ON DELETE SET NULL,
    email           TEXT NOT NULL,
    name            TEXT NOT NULL DEFAULT '',
    subject         TEXT NOT NULL DEFAULT '',
    status          TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed')),
    category        TEXT NOT NULL DEFAULT 'reply' CHECK (category IN ('reply', 'auto_reply', 'unsubscribe_request')),
    assigned_to     UUID REFERENCES portal.users(id) ON DELETE SET NULL,
    unread          BOOLEAN NOT NULL DEFAULT TRUE,
    last_direction  TEXT NOT NULL DEFAULT 'in' CHECK (last_direction IN ('in', 'out', 'note')),
    last_message_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    message_count   INTEGER NOT NULL DEFAULT 0,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX conversations_status_idx ON portal.conversations (status, last_message_at DESC);
CREATE INDEX conversations_contact_idx ON portal.conversations (contact_id);
CREATE INDEX conversations_campaign_idx ON portal.conversations (campaign_id);
CREATE INDEX conversations_email_idx ON portal.conversations (LOWER(email), last_message_at DESC);
CREATE INDEX conversations_assigned_idx ON portal.conversations (assigned_to) WHERE status = 'open';

CREATE TABLE portal.inbox_messages (
    id              BIGSERIAL PRIMARY KEY,
    conversation_id INTEGER NOT NULL REFERENCES portal.conversations(id) ON DELETE CASCADE,
    direction       TEXT NOT NULL CHECK (direction IN ('in', 'out', 'note')),
    rfc_message_id  TEXT,                 -- Message-ID header (inbound) or the one we generated (outbound)
    in_reply_to     TEXT,
    references_hdr  TEXT,
    from_email      TEXT,
    from_name       TEXT NOT NULL DEFAULT '',
    to_email        TEXT,
    subject         TEXT NOT NULL DEFAULT '',
    text_body       TEXT NOT NULL DEFAULT '',
    html_body       TEXT,                 -- sanitised; only ever served with a sandbox CSP
    message_id      BIGINT REFERENCES portal.messages(id) ON DELETE SET NULL, -- the campaign email this answers
    matched_by      TEXT,                 -- header | sender | none
    sent_by         UUID REFERENCES portal.users(id) ON DELETE SET NULL,
    send_status     TEXT CHECK (send_status IN ('sent', 'failed')),
    error           TEXT,
    source          TEXT,                 -- bounce mailbox | replies mailbox | portal
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX inbox_messages_conv_idx ON portal.inbox_messages (conversation_id, created_at);
-- The same email fetched twice (e.g. from both mailboxes) is stored once.
CREATE UNIQUE INDEX inbox_messages_rfc_in_uniq ON portal.inbox_messages (rfc_message_id) WHERE direction = 'in' AND rfc_message_id IS NOT NULL;
CREATE INDEX inbox_messages_rfc_idx ON portal.inbox_messages (rfc_message_id) WHERE rfc_message_id IS NOT NULL;

CREATE TABLE portal.inbox_attachments (
    id               BIGSERIAL PRIMARY KEY,
    inbox_message_id BIGINT NOT NULL REFERENCES portal.inbox_messages(id) ON DELETE CASCADE,
    filename         TEXT NOT NULL DEFAULT 'attachment',
    content_type     TEXT NOT NULL DEFAULT 'application/octet-stream',
    size             INTEGER NOT NULL DEFAULT 0,
    data             BYTEA                 -- NULL when larger than the limit (only listed)
);
CREATE INDEX inbox_attachments_msg_idx ON portal.inbox_attachments (inbox_message_id);

-- Replies quote our Message-ID in In-Reply-To / References: find the campaign email fast.
CREATE INDEX IF NOT EXISTS messages_smtp_message_id_idx ON portal.messages (smtp_message_id) WHERE smtp_message_id IS NOT NULL;
