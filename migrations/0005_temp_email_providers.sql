-- Multi-provider temp email: store per-mailbox credentials for DuckMail (mail.tm)
-- and self-hosted cloudflare_temp_email, alongside the existing GPTMail source.
-- The `source` column already records which provider a row uses.
--
-- DuckMail (mail.tm): needs the account password to re-mint a Bearer token when
-- the cached one expires, plus the current token and account id.
-- cloudflare_temp_email: mail fetch goes through the instance admin API keyed by
-- the mailbox address; we keep the returned address id for reference.

ALTER TABLE temp_emails ADD COLUMN duckmail_token TEXT DEFAULT '';
ALTER TABLE temp_emails ADD COLUMN duckmail_account_id TEXT DEFAULT '';
ALTER TABLE temp_emails ADD COLUMN duckmail_password TEXT DEFAULT '';
ALTER TABLE temp_emails ADD COLUMN cloudflare_address_id TEXT DEFAULT '';
