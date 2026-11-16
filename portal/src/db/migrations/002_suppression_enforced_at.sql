-- When the suppression was first confirmed as applied in listmonk (contact
-- blocklisted). A suppressed contact that is later found enabled again was
-- re-activated outside MailHarbor, which raises an alert.
ALTER TABLE portal.suppressions ADD COLUMN enforced_at TIMESTAMPTZ;
