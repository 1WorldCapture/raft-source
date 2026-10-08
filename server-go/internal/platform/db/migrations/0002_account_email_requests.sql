-- Send-attempt quota metadata must outlive consumed/replaced account tokens.
-- No bearer token, email content, or credential is stored in this ledger.
CREATE TABLE account_email_requests (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    kind TEXT NOT NULL CHECK (kind IN ('email_verification', 'password_reset')),
    created_at INTEGER NOT NULL
);
CREATE INDEX account_email_requests_user_kind_time
    ON account_email_requests(user_id, kind, created_at);

-- Preserve what is still available from the initial account schema. Historical
-- attempts whose tokens were already deleted cannot be reconstructed.
INSERT INTO account_email_requests (id, user_id, kind, created_at)
SELECT id, user_id, kind, created_at FROM account_tokens;
