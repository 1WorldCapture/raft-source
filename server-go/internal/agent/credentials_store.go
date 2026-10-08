// Credential and bootstrap-token persistence (TS agentCredentialService).
package agent

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"raft.local/server-go/internal/auth"
	"raft.local/server-go/internal/platform/db"
)

// CredentialLookup is the authenticated principal (middleware result).
type CredentialLookup struct {
	CredentialID string
	AgentID      string
	WorkspaceID  string
	Scopes       []string
}

type credentialRow struct {
	ID         string
	AgentID    string
	APIKeyHash string
	Scopes     string
}

// FindCredentialByAPIKey ports findAgentCredentialByApiKey: prefix-index
// candidate lookup over non-revoked rows, argon2id verify, then the agent
// join that keeps soft-deleted agents' credentials unusable. Returns nil for
// every failure mode (never distinguishes them on the wire).
func (s *Store) FindCredentialByAPIKey(ctx context.Context, apiKey string) (*CredentialLookup, error) {
	if !IsAgentAPIKey(apiKey) {
		return nil, nil
	}
	if s.hasher == nil {
		return nil, fmt.Errorf("agent credential hasher is not configured")
	}
	rows, err := s.db.QueryContext(ctx, `
		SELECT id, agent_id, api_key_hash, scopes FROM agent_credentials
		WHERE api_key_prefix = ? AND revoked_at IS NULL`, APIKeyPrefix(apiKey))
	if err != nil {
		return nil, fmt.Errorf("credential lookup: %w", err)
	}
	defer rows.Close()
	var candidates []credentialRow
	for rows.Next() {
		var row credentialRow
		if err := rows.Scan(&row.ID, &row.AgentID, &row.APIKeyHash, &row.Scopes); err != nil {
			return nil, fmt.Errorf("scan credential: %w", err)
		}
		candidates = append(candidates, row)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	verified := -1
	for i, candidate := range candidates {
		if s.hasher.Verify(apiKey, candidate.APIKeyHash) {
			verified = i
			break
		}
	}
	if verified < 0 {
		return nil, nil
	}
	// Argon finished. Revocation (or deletion) that landed during the slow
	// verify must not still authenticate. This re-read is a point lookup,
	// never another hash, and it is not inside a write transaction.
	s.noteSlowSecret()
	row := candidates[verified]
	var revoked sql.NullInt64
	var scopesRaw string
	err = s.db.QueryRowContext(ctx, `
		SELECT scopes, revoked_at FROM agent_credentials WHERE id = ?`, row.ID).
		Scan(&scopesRaw, &revoked)
	if errors.Is(err, sql.ErrNoRows) || revoked.Valid {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("credential revocation recheck: %w", err)
	}

	var workspaceID string
	var agentDeleted, workspaceDeleted sql.NullInt64
	var workspaceRowID sql.NullString
	err = s.db.QueryRowContext(ctx, `
		SELECT a.workspace_id, a.deleted_at, w.id, w.deleted_at
		FROM agents a
		LEFT JOIN workspaces w ON w.id = a.workspace_id
		WHERE a.id = ?`, row.AgentID).Scan(&workspaceID, &agentDeleted, &workspaceRowID, &workspaceDeleted)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("credential agent lookup: %w", err)
	}
	// Match authenticateAgentCredential's order: a deleted server is reported
	// before a deleted agent. Unknown keys stay indistinguishable (nil above).
	if !workspaceRowID.Valid || workspaceDeleted.Valid {
		return nil, ErrAuthenticatedServerGone
	}
	if agentDeleted.Valid {
		return nil, ErrAuthenticatedAgentGone
	}
	scopes, err := decodeScopes(scopesRaw)
	if err != nil {
		return nil, err
	}
	return &CredentialLookup{
		CredentialID: row.ID,
		AgentID:      row.AgentID,
		WorkspaceID:  workspaceID,
		Scopes:       scopes,
	}, nil
}

// RecordCredentialUse writes the best-effort observability triple; failures
// are swallowed by the caller (observability must not affect auth).
func (s *Store) RecordCredentialUse(ctx context.Context, credentialID string, ip, userAgent *string) error {
	_, err := s.db.ExecContext(ctx, `
		UPDATE agent_credentials SET last_used_at = ?, last_used_ip = ?, last_used_user_agent = ?
		WHERE id = ?`, s.now(), ip, userAgent, credentialID)
	if err != nil {
		return fmt.Errorf("record credential use: %w", err)
	}
	return nil
}

// MintedCredential is the mint result; the raw API key is returned exactly
// once and never persists.
type MintedCredential struct {
	CredentialID string
	APIKey       string
	Scopes       []string
	AgentID      string
	WorkspaceID  string
	AgentName    string
}

// MintCredential ports mintAgentCredential: fresh `sk_agent_*` bound to a
// live agent of a live workspace. Existing credentials are NOT auto-revoked.
// The argon2id hash runs before the write transaction. Inside that
// transaction the agent, workspace and (when set) issuing user are read
// again, so a delete or demotion during hashing does not persist a key.
func (s *Store) MintCredential(ctx context.Context, agentID string, scopes []string, name *string, createdByUserID *string) (*MintedCredential, error) {
	if s.hasher == nil {
		return nil, fmt.Errorf("agent credential hasher is not configured")
	}
	if _, err := s.readLiveAgent(ctx, s.db, agentID); err != nil {
		return nil, err
	}

	apiKey, apiKeyHash, prefix, err := s.hasher.newAPIKeyMaterial()
	if err != nil {
		return nil, err
	}
	scopesJSON, err := encodeScopes(scopes)
	if err != nil {
		return nil, err
	}
	s.noteSlowSecret()

	id := auth.NewUUID()
	minted := &MintedCredential{CredentialID: id, APIKey: apiKey, Scopes: scopes, AgentID: agentID}
	err = s.withTx(ctx, func(tx *sql.Tx) error {
		live, err := s.readLiveAgent(ctx, tx, agentID)
		if err != nil {
			return err
		}
		if err := s.recheckIssuer(ctx, tx, live, createdByUserID); err != nil {
			return err
		}
		if _, err := tx.ExecContext(ctx, `
			INSERT INTO agent_credentials (id, agent_id, api_key_hash, api_key_prefix, name, scopes, created_by_user_id, created_at)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
			id, agentID, apiKeyHash, prefix, name, scopesJSON, createdByUserID, s.now()); err != nil {
			return fmt.Errorf("insert credential: %w", err)
		}
		minted.WorkspaceID = live.workspaceID
		minted.AgentName = live.name
		return nil
	})
	if err != nil {
		return nil, err
	}
	return minted, nil
}

type liveAgent struct {
	name        string
	workspaceID string
	creatorType sql.NullString
	creatorID   sql.NullString
}

func (s *Store) readLiveAgent(ctx context.Context, q executor, agentID string) (liveAgent, error) {
	var live liveAgent
	err := q.QueryRowContext(ctx, `
		SELECT a.name, a.workspace_id, a.creator_type, a.creator_id
		FROM agents a
		JOIN workspaces w ON w.id = a.workspace_id
		WHERE a.id = ? AND a.deleted_at IS NULL AND w.deleted_at IS NULL
		  AND w.kind != 'joint_storage'`, agentID).
		Scan(&live.name, &live.workspaceID, &live.creatorType, &live.creatorID)
	if errors.Is(err, sql.ErrNoRows) {
		return liveAgent{}, ErrAgentMissing
	}
	if err != nil {
		return liveAgent{}, fmt.Errorf("read live agent: %w", err)
	}
	return live, nil
}

// recheckIssuer confirms the human who started the mint is still a member
// allowed to issue. A nil issuer (bootstrap exchange, computer-hosted mint)
// has no user to recheck; the agent and workspace liveness checks still apply.
func (s *Store) recheckIssuer(ctx context.Context, q executor, live liveAgent, createdByUserID *string) error {
	if createdByUserID == nil || *createdByUserID == "" {
		return nil
	}
	var role string
	err := q.QueryRowContext(ctx, `
		SELECT m.role FROM workspace_memberships m
		JOIN workspaces w ON w.id = m.workspace_id
		WHERE m.workspace_id = ? AND m.user_id = ?
		  AND w.deleted_at IS NULL AND w.kind != 'joint_storage'`,
		live.workspaceID, *createdByUserID).Scan(&role)
	if errors.Is(err, sql.ErrNoRows) {
		return ErrAgentMissing
	}
	if err != nil {
		return fmt.Errorf("recheck credential issuer: %w", err)
	}
	creator := live.creatorType.Valid && live.creatorType.String == "user" &&
		live.creatorID.Valid && live.creatorID.String == *createdByUserID
	if !HasServerCapability(role, "issueAgentCredentials") && !creator {
		return errf(403, "insufficient_role",
			"The `issueAgentCredentials` capability or human creator authority is required to manage agent credentials")
	}
	return nil
}

// CredentialMetadata is the safe list projection (no key material, no IPs).
type CredentialMetadata struct {
	ID          string   `json:"id"`
	MaskedToken string   `json:"maskedToken"`
	Name        *string  `json:"name"`
	Scopes      []string `json:"scopes"`
	CreatedAt   string   `json:"createdAt"`
	LastUsedAt  *string  `json:"lastUsedAt"`
	RevokedAt   *string  `json:"revokedAt"`
}

// ListCredentials ports listAgentCredentials (masked prefixes only).
func (s *Store) ListCredentials(ctx context.Context, agentID string) ([]CredentialMetadata, error) {
	rows, err := s.db.QueryContext(ctx, `
		SELECT id, api_key_prefix, name, scopes, created_at, last_used_at, revoked_at
		FROM agent_credentials WHERE agent_id = ?
		ORDER BY created_at DESC, id DESC`, agentID)
	if err != nil {
		return nil, fmt.Errorf("list credentials: %w", err)
	}
	defer rows.Close()
	out := []CredentialMetadata{}
	for rows.Next() {
		var id, prefix, scopes string
		var name sql.NullString
		var createdAt int64
		var lastUsed, revoked sql.NullInt64
		if err := rows.Scan(&id, &prefix, &name, &scopes, &createdAt, &lastUsed, &revoked); err != nil {
			return nil, fmt.Errorf("scan credential metadata: %w", err)
		}
		decoded, err := decodeScopes(scopes)
		if err != nil {
			return nil, err
		}
		metadata := CredentialMetadata{
			ID:          id,
			MaskedToken: maskedCredentialToken(prefix),
			Scopes:      decoded,
			CreatedAt:   isoMillis(createdAt),
		}
		if name.Valid {
			value := name.String
			metadata.Name = &value
		}
		if lastUsed.Valid {
			metadata.LastUsedAt = isoStringPtr(lastUsed.Int64)
		}
		if revoked.Valid {
			metadata.RevokedAt = isoStringPtr(revoked.Int64)
		}
		out = append(out, metadata)
	}
	return out, rows.Err()
}

// RevokeCredential ports revokeAgentCredential: soft revoke, terminal, rows
// stay. agentID/workspaceID bound checks use empty string for "skip".
// The first revoked_at wins. A repeat call, including one that races the
// first writer, does not move the timestamp or replace the reason.
func (s *Store) RevokeCredential(ctx context.Context, credentialID, agentID, workspaceID, reason string, revokedByUserID *string) (bool, error) {
	var found bool
	err := s.withTx(ctx, func(tx *sql.Tx) error {
		var rowAgent string
		var revoked sql.NullInt64
		var rowWorkspace string
		err := tx.QueryRowContext(ctx, `
			SELECT c.agent_id, c.revoked_at, a.workspace_id
			FROM agent_credentials c JOIN agents a ON a.id = c.agent_id
			WHERE c.id = ?`, credentialID).Scan(&rowAgent, &revoked, &rowWorkspace)
		if errors.Is(err, sql.ErrNoRows) {
			found = false
			return nil
		}
		if err != nil {
			return fmt.Errorf("read credential for revoke: %w", err)
		}
		if agentID != "" && rowAgent != agentID {
			found = false
			return nil
		}
		if workspaceID != "" && rowWorkspace != workspaceID {
			found = false
			return nil
		}
		found = true
		if revoked.Valid {
			return nil
		}
		res, err := tx.ExecContext(ctx, `
			UPDATE agent_credentials SET revoked_at = ?, revoked_reason = ?, revoked_by_user_id = ?
			WHERE id = ? AND revoked_at IS NULL`, s.now(), reason, revokedByUserID, credentialID)
		if err != nil {
			return fmt.Errorf("revoke credential: %w", err)
		}
		if changed, _ := res.RowsAffected(); changed == 0 {
			// Lost the race. Leave the winner's timestamp and reason alone.
			return nil
		}
		return nil
	})
	if err != nil {
		return false, err
	}
	return found, nil
}

// ---------------------------------------------------------------------------
// Bootstrap tokens
// ---------------------------------------------------------------------------

// IssuedBootstrapToken is the mint result; the raw token is shown once.
type IssuedBootstrapToken struct {
	TokenID        string
	RawToken       string
	TokenPrefix    string
	TTLExpiresAtMS int64
	Scopes         []string
}

const defaultBootstrapTTLMS = int64(30 * 60 * 1000) // RFC §7 default 30 minutes
const maxBootstrapTTLMS = int64(24 * 60 * 60 * 1000)

// IssueBootstrapToken ports issueAgentBootstrapToken.
func (s *Store) IssueBootstrapToken(ctx context.Context, agentID, workspaceID, issuedByUserID string, scopes []string, ttlMS *int64) (*IssuedBootstrapToken, error) {
	if s.hasher == nil {
		return nil, fmt.Errorf("agent credential hasher is not configured")
	}
	var rowWorkspace string
	err := s.db.QueryRowContext(ctx, `
		SELECT workspace_id FROM agents WHERE id = ? AND deleted_at IS NULL`,
		agentID).Scan(&rowWorkspace)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrAgentMissing
	}
	if err != nil {
		return nil, fmt.Errorf("read agent for bootstrap: %w", err)
	}
	if rowWorkspace != workspaceID {
		return nil, errf(409, "", "agent_server_mismatch")
	}

	raw, lookupHash, tokenHash, prefix, err := s.hasher.newBootstrapToken()
	if err != nil {
		return nil, err
	}
	scopesJSON, err := encodeScopes(scopes)
	if err != nil {
		return nil, err
	}
	ttl := defaultBootstrapTTLMS
	if ttlMS != nil {
		ttl = *ttlMS
	}
	s.noteSlowSecret()
	id := auth.NewUUID()
	var expires int64
	err = s.withTx(ctx, func(tx *sql.Tx) error {
		var currentWorkspace string
		err := tx.QueryRowContext(ctx, `
			SELECT workspace_id FROM agents WHERE id = ? AND deleted_at IS NULL`,
			agentID).Scan(&currentWorkspace)
		if errors.Is(err, sql.ErrNoRows) {
			return ErrAgentMissing
		}
		if err != nil {
			return fmt.Errorf("recheck agent for bootstrap: %w", err)
		}
		if currentWorkspace != workspaceID {
			return errf(409, "", "agent_server_mismatch")
		}
		expires = s.now() + ttl
		if _, err := tx.ExecContext(ctx, `
			INSERT INTO agent_bootstrap_tokens
				(id, token_lookup_hash, token_hash, token_prefix, target_agent_id, workspace_id,
				 issued_by_user_id, scopes, ttl_expires_at, created_at)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			id, lookupHash, tokenHash, prefix, agentID, workspaceID, issuedByUserID, scopesJSON, expires, s.now()); err != nil {
			if db.IsUniqueViolation(err, "token_lookup_hash") {
				return fmt.Errorf("bootstrap token collision: %w", err)
			}
			return fmt.Errorf("insert bootstrap token: %w", err)
		}
		return nil
	})
	if err != nil {
		return nil, err
	}
	return &IssuedBootstrapToken{
		TokenID:        id,
		RawToken:       raw,
		TokenPrefix:    prefix,
		TTLExpiresAtMS: expires,
		Scopes:         scopes,
	}, nil
}

// ConsumeBootstrapToken ports consumeAgentBootstrapToken: locate by HMAC
// lookup hash, argon2id verify, mint, then CAS-claim the row; the race loser
// gets the just-minted credential revoked and token_consumed.
func (s *Store) ConsumeBootstrapToken(ctx context.Context, raw string, ip, userAgent *string) (*MintedCredential, error) {
	if s.hasher == nil {
		return nil, fmt.Errorf("agent credential hasher is not configured")
	}
	if raw == "" {
		return nil, ErrTokenInvalid
	}
	lookupHash := s.hasher.bootstrapLookupHash(raw)
	var row struct {
		ID        string
		TokenHash string
		AgentID   string
		Scopes    string
		TTL       int64
		Consumed  sql.NullInt64
		Revoked   sql.NullInt64
	}
	err := s.db.QueryRowContext(ctx, `
		SELECT id, token_hash, target_agent_id, scopes, ttl_expires_at, consumed_at, revoked_at
		FROM agent_bootstrap_tokens WHERE token_lookup_hash = ?`, lookupHash).
		Scan(&row.ID, &row.TokenHash, &row.AgentID, &row.Scopes, &row.TTL, &row.Consumed, &row.Revoked)
	if errors.Is(err, sql.ErrNoRows) {
		s.hasher.Burn()
		return nil, ErrTokenInvalid
	}
	if err != nil {
		return nil, fmt.Errorf("bootstrap lookup: %w", err)
	}
	if !s.hasher.Verify(raw, row.TokenHash) {
		return nil, ErrTokenInvalid
	}
	// Recheck terminal token state after argon. A revoke or consume that
	// landed during verify must win; the hash itself stayed outside any tx.
	s.noteSlowSecret()
	err = s.db.QueryRowContext(ctx, `
		SELECT scopes, ttl_expires_at, consumed_at, revoked_at
		FROM agent_bootstrap_tokens WHERE id = ?`, row.ID).
		Scan(&row.Scopes, &row.TTL, &row.Consumed, &row.Revoked)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrTokenInvalid
	}
	if err != nil {
		return nil, fmt.Errorf("bootstrap recheck: %w", err)
	}
	if row.Revoked.Valid {
		return nil, ErrTokenRevoked
	}
	if row.Consumed.Valid {
		return nil, ErrTokenConsumed
	}
	if row.TTL <= s.now() {
		return nil, ErrTokenExpired
	}
	scopes, err := decodeScopes(row.Scopes)
	if err != nil {
		return nil, err
	}

	minted, err := s.MintCredential(ctx, row.AgentID, scopes, nil, nil)
	if err != nil {
		if AsError(err) == ErrAgentMissing {
			return nil, ErrAgentMissing
		}
		return nil, err
	}

	// The CAS claim is the actual race defense. revoked_at IS NULL keeps a
	// token voided during mint from being marked consumed.
	res, err := s.db.ExecContext(ctx, `
		UPDATE agent_bootstrap_tokens
		SET consumed_at = ?, consumed_credential_id = ?, consumed_ip = ?, consumed_user_agent = ?
		WHERE id = ? AND consumed_at IS NULL AND revoked_at IS NULL`,
		s.now(), minted.CredentialID, ip, userAgent, row.ID)
	if err != nil {
		_, _ = s.RevokeCredential(context.Background(), minted.CredentialID, "", "", "bootstrap_exchange_failed", nil)
		return nil, fmt.Errorf("claim bootstrap token: %w", err)
	}
	if changed, _ := res.RowsAffected(); changed == 0 {
		_, _ = s.RevokeCredential(context.Background(), minted.CredentialID, "", "", "bootstrap_exchange_race_lost", nil)
		var revoked, consumed sql.NullInt64
		if err := s.db.QueryRowContext(ctx, `
			SELECT revoked_at, consumed_at FROM agent_bootstrap_tokens WHERE id = ?`, row.ID).
			Scan(&revoked, &consumed); err == nil && revoked.Valid && !consumed.Valid {
			return nil, ErrTokenRevoked
		}
		return nil, ErrTokenConsumed
	}
	return minted, nil
}

// LatestActiveCredentialSummary feeds the external-status read.
type LatestActiveCredentialSummary struct {
	CredentialID string
	CreatedAt    int64
	LastUsedAt   *int64
}

// LatestActiveCredential ports getLatestActiveAgentCredential.
func (s *Store) LatestActiveCredential(ctx context.Context, agentID string) (*LatestActiveCredentialSummary, error) {
	var id string
	var createdAt int64
	var lastUsed sql.NullInt64
	err := s.db.QueryRowContext(ctx, `
		SELECT id, created_at, last_used_at FROM agent_credentials
		WHERE agent_id = ? AND revoked_at IS NULL
		ORDER BY created_at DESC LIMIT 1`, agentID).Scan(&id, &createdAt, &lastUsed)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("read latest credential: %w", err)
	}
	summary := &LatestActiveCredentialSummary{CredentialID: id, CreatedAt: createdAt}
	if lastUsed.Valid {
		value := lastUsed.Int64
		summary.LastUsedAt = &value
	}
	return summary, nil
}

// ---------------------------------------------------------------------------
// Pending purges (delete durability; MACHINEWS drains these on reconnect)
// ---------------------------------------------------------------------------

// PendingPurge is one durable purge intent.
type PendingPurge struct {
	MachineID string
	AgentID   string
}

// RecordPurgeAttempt bumps the attempt/outcome columns (dispatch bookkeeping).
func (s *Store) RecordPurgeAttempt(ctx context.Context, machineID, agentID, outcome string) error {
	_, err := s.db.ExecContext(ctx, `
		UPDATE machine_pending_agent_purges
		SET attempts = attempts + 1, last_attempt_at = ?, last_outcome = ?
		WHERE machine_id = ? AND agent_id = ?`, s.now(), outcome, machineID, agentID)
	if err != nil {
		return fmt.Errorf("record purge attempt: %w", err)
	}
	return nil
}

// ClearPendingPurge removes the intent after a terminal daemon outcome
// (purged / nothing_to_purge; refused_running keeps the row).
func (s *Store) ClearPendingPurge(ctx context.Context, machineID, agentID string) error {
	_, err := s.db.ExecContext(ctx, `
		DELETE FROM machine_pending_agent_purges WHERE machine_id = ? AND agent_id = ?`,
		machineID, agentID)
	if err != nil {
		return fmt.Errorf("clear pending purge: %w", err)
	}
	return nil
}

// ListPendingPurges returns the durable purge intents for a machine. The
// MACHINEWS ready-callback (or parent wiring) drains them.
func (s *Store) ListPendingPurges(ctx context.Context, machineID string) ([]PendingPurge, error) {
	rows, err := s.db.QueryContext(ctx, `
		SELECT machine_id, agent_id FROM machine_pending_agent_purges
		WHERE machine_id = ? ORDER BY created_at ASC`, machineID)
	if err != nil {
		return nil, fmt.Errorf("list pending purges: %w", err)
	}
	defer rows.Close()
	var out []PendingPurge
	for rows.Next() {
		var p PendingPurge
		if err := rows.Scan(&p.MachineID, &p.AgentID); err != nil {
			return nil, fmt.Errorf("scan pending purge: %w", err)
		}
		out = append(out, p)
	}
	return out, rows.Err()
}

// ---------------------------------------------------------------------------
// JSON scope helpers
// ---------------------------------------------------------------------------

func encodeScopes(scopes []string) (string, error) {
	if scopes == nil {
		scopes = []string{}
	}
	encoded, err := json.Marshal(scopes)
	if err != nil {
		return "", fmt.Errorf("encode scopes: %w", err)
	}
	return string(encoded), nil
}

func decodeScopes(raw string) ([]string, error) {
	var scopes []string
	if raw == "" {
		return []string{}, nil
	}
	if err := json.Unmarshal([]byte(raw), &scopes); err != nil {
		return nil, fmt.Errorf("decode scopes: %w", err)
	}
	if scopes == nil {
		scopes = []string{}
	}
	return scopes, nil
}

// isoMillis renders ms-precision UTC ISO-8601 (the legacy JS Date JSON shape).
func isoMillis(ms int64) string {
	return time.UnixMilli(ms).UTC().Format("2006-01-02T15:04:05.000Z")
}

func isoStringPtr(ms int64) *string {
	value := isoMillis(ms)
	return &value
}

// maskedCredentialToken is the list projection. A corrupt or short stored
// prefix must not panic; the visible slice is capped at 14 bytes.
func maskedCredentialToken(prefix string) string {
	const visible = 14
	if len(prefix) > visible {
		prefix = prefix[:visible]
	}
	return prefix + "***"
}
