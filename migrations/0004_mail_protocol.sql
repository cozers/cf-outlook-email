-- Multi-protocol support: some refresh_tokens are IMAP-authorized (e.g. purchased
-- accounts consented only to https://outlook.office.com/IMAP.AccessAsUser.All) and
-- cannot obtain a Graph token at all. Those must be read over IMAP (XOAUTH2) instead
-- of the Graph REST API. `mail_protocol` records which channel an account uses.
--
--   'auto'  – not yet probed; the dispatcher tries Graph first, then IMAP, and
--             rewrites this column to the one that worked.
--   'graph' – use Microsoft Graph REST API (default for freshly OAuth'd accounts).
--   'imap'  – use IMAP over XOAUTH2 (for IMAP-only / purchased tokens).
ALTER TABLE accounts ADD COLUMN mail_protocol TEXT DEFAULT 'auto';

-- Caches the scope string that last produced a working token for this account,
-- so steady-state refreshes skip the scope-ladder probe and cost one request.
-- Empty = unknown (probe the full ladder). For IMAP accounts this holds the IMAP
-- resource scope; for Graph accounts, the granular Graph scope that was consented.
ALTER TABLE accounts ADD COLUMN token_scope TEXT DEFAULT '';
