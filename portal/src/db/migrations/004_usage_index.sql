-- Mail usage report: messages sent per day / hour.
CREATE INDEX IF NOT EXISTS messages_sent_at_idx ON portal.messages (sent_at) WHERE sent_at IS NOT NULL;
