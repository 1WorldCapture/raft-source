// Independent M2 upgrade/lifecycle regression tests for the migration chain.
//
// Ownership note: this file (and only this file) belongs to the M2 upgrade
// reviewer. The migration files under migrations/ and all feature code belong
// to the implementation workers; the frozen M1 migrations 0001/0002 are never
// edited here. The suite builds a REAL M1 database by applying the unchanged
// 0001/0002 SQL to a temporary SQLite file, seeds it with the account,
// auth/session, one-shot email token, avatar-url and workspace/member data M1
// could hold, then upgrades in place through store.Open and asserts the M1
// facts survive:
//
//   - original ids, emails, roles and avatar URLs are byte-identical;
//   - password hashes still verify against the original secrets;
//   - refresh session tokens and email verification/reset tokens still
//     resolve by hash exactly as the auth package looks them up;
//   - PRAGMA foreign_key_check stays empty across the upgrade;
//   - a migration that fails mid-flight rolls back without touching M1 data,
//     and a retry after the fault clears upgrades cleanly;
//   - write-lock waits are context-cancellable end to end: already-cancelled
//     contexts never enter the wait, a deadline expiring mid-wait interrupts
//     both BeginTx and direct ExecContext within ~300ms+slack and applies
//     zero writes, the connector's retries bridge transient contention
//     exactly once, and an Open racing a held write lock never leaves
//     partially-applied state.
//
// Assertions that require the M2 migrations (>=0003) skip with an explicit
// message until those files land, so this file compiles and passes against
// the M1-only tree as well and tightens automatically afterwards.
package db_test

import (
	"context"
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"database/sql"
	"encoding/base64"
	"errors"
	"fmt"
	"io"
	"net/url"
	"os"
	"path/filepath"
	"slices"
	"sort"
	"strings"
	"testing"
	"time"

	"raft.local/server-go/internal/auth"
	store "raft.local/server-go/internal/platform/db"
)

// Fixed M1-era identifiers so dumps and assertions stay deterministic.
const (
	m2UserA = "e1f0a2b3-0001-4e1a-9c2d-a00000000001" // owner of workspace 1, member of workspace 2
	m2UserB = "e1f0a2b3-0002-4e2b-9c3d-a00000000002" // owner of workspaces 2 and 3, admin in 1
	m2UserC = "e1f0a2b3-0003-4e3c-9c4d-a00000000003" // member in workspace 1
	m2UserD = "e1f0a2b3-0004-4e4d-9c5d-a00000000004" // unverified guest in workspace 1

	m2Workspace1 = "7c3d4e5f-0001-4a7b-8b8c-b00000000001" // active, owner A
	m2Workspace2 = "7c3d4e5f-0002-4b7c-8c8d-b00000000002" // active, owner B
	m2Workspace3 = "7c3d4e5f-0003-4c7d-8d8e-b00000000003" // soft-deleted, must survive the upgrade

	m2FamilyA  = "3a2b1c0d-0001-4a1b-8a1b-c00000000001"
	m2FamilyB  = "3a2b1c0d-0002-4a2c-8a2c-c00000000002"
	m2SessionA = "9b8c7d6e-0001-4b1c-8c1d-d00000000001" // live session of the A family
	m2SessionO = "9b8c7d6e-0002-4b2d-8c2d-d00000000002" // rotated away: referenced by predecessor/receipt rows only
	m2SessionB = "9b8c7d6e-0003-4b3e-8c3e-d00000000003" // session inside the revoked B family

	m2VerifyTokenID = "1d2e3f4a-0001-4c1d-8d1e-e00000000001"
	m2ResetTokenID  = "1d2e3f4a-0002-4c2e-8d2f-e00000000002"
	m2ReceiptID     = "6f7e8d9c-0001-4d1e-8e1f-f00000000001"
	m2AcceptanceID  = "2c3d4e5f-0001-4e1f-8f1a-a10000000001"
)

// Opaque secrets in the legacy 64-hex shape. Only SHA-256 hashes live in the
// database; the raw values exist so the tests can prove the persisted hashes
// still resolve after the upgrade.
const (
	m2RefreshA0    = "a0f1e2d3c4b5a6978877665544332211ffeeddccbbaa9988776655443322110a"
	m2RefreshA1    = "a1f1e2d3c4b5a6978877665544332211ffeeddccbbaa9988776655443322110a"
	m2RefreshB1    = "b1f1e2d3c4b5a6978877665544332211ffeeddccbbaa9988776655443322110b"
	m2VerifySecret = "0d0e0f101112131415161718191a1b1c1d1e1f202122232425262728292a2b2c"
	m2ResetSecret  = "1d1e1f202122232425262728292a2b2c2d2e2f303132333435363738393a3b3c"
)

const (
	m2AvatarUserA = "/api/avatars/users/0f1e2d3c4b5a69788776655443322110.png"
	m2AvatarWS1   = "/api/avatars/workspaces/1f1e2d3c4b5a69788776655443322110.png"
)

// m2M1TableOrder fixes the deterministic dump order for every M1 table the
// upgrade must preserve. It doubles as the list of tables snapshotted before
// and after the upgrade.
var m2M1TableOrder = map[string]string{
	"users":                             "id",
	"session_families":                  "id",
	"sessions":                          "id",
	"session_token_predecessors":        "token_hash",
	"session_refresh_rotation_receipts": "id",
	"account_tokens":                    "id",
	"account_email_requests":            "id",
	"legal_acceptances":                 "id",
	"workspaces":                        "id",
	"workspace_memberships":             "workspace_id, user_id",
}

// m2MigrationFiles returns the migration file names on disk, sorted. Tests
// run with the package directory as working directory, like the existing
// safety review tests.
func m2MigrationFiles(t *testing.T) []string {
	t.Helper()
	paths, err := filepath.Glob("migrations/*.sql")
	if err != nil {
		t.Fatalf("discover migrations: %v", err)
	}
	if len(paths) == 0 {
		t.Fatal("no migrations found under migrations/; these tests must run from internal/platform/db")
	}
	names := make([]string, 0, len(paths))
	for _, p := range paths {
		names = append(names, filepath.Base(p))
	}
	sort.Strings(names)
	return names
}

// m2PendingMigrations reports whether an actual M1->M2 upgrade would run,
// i.e. whether any migration newer than the frozen M1 pair is on disk.
func m2PendingMigrations(t *testing.T) bool {
	t.Helper()
	for _, name := range m2MigrationFiles(t) {
		if strings.Compare(name, "0003") >= 0 {
			return true
		}
	}
	return false
}

// m2OpenRaw opens a direct SQLite handle outside store.Open so tests can
// build the M1 database and inject faults with the same pragmas the app uses.
func m2OpenRaw(t *testing.T, path string, immediate bool) *sql.DB {
	t.Helper()
	q := url.Values{}
	if immediate {
		q.Set("_txlock", "immediate")
	}
	q.Add("_pragma", "busy_timeout(10000)")
	q.Add("_pragma", "journal_mode(WAL)")
	q.Add("_pragma", "synchronous(FULL)")
	q.Add("_pragma", "foreign_keys(1)")
	u := url.URL{Scheme: "file", Path: filepath.ToSlash(path), RawQuery: q.Encode()}
	h, err := sql.Open("sqlite", u.String())
	if err != nil {
		t.Fatalf("open raw sqlite handle: %v", err)
	}
	h.SetMaxOpenConns(4)
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	if err := h.PingContext(ctx); err != nil {
		h.Close()
		t.Fatalf("ping raw sqlite handle: %v", err)
	}
	return h
}

type m2RefreshSeed struct {
	Raw       string
	SessionID string
	UserID    string
	FamilyID  string
}

type m2OneShotSeed struct {
	Raw    string
	ID     string
	UserID string
	Kind   string
}

type m2LegacyFixture struct {
	path string
	now  int64

	passwords map[string]string        // user id -> raw password
	refresh   map[string]m2RefreshSeed // label -> live refresh token seed
	oneshots  []m2OneShotSeed          // verification/reset token seeds

	m1Cols map[string][]string // M1 column names per table, captured pre-upgrade
	m1Dump map[string]string   // deterministic dump of every M1 table, pre-upgrade
}

// m2BuildLegacyM1 creates a real M1 database in a temp dir: the unchanged
// 0001/0002 SQL is applied verbatim, schema_migrations records exactly those
// two versions, and a representative M1 dataset is seeded. The returned
// fixture carries the pre-upgrade dump and the raw secrets needed to prove
// post-upgrade usability.
func m2BuildLegacyM1(t *testing.T) *m2LegacyFixture {
	t.Helper()

	const (
		dayMs      = int64(24 * time.Hour / time.Millisecond)
		sessionTTL = 90 * dayMs
		tokenTTL   = 7 * dayMs
	)
	f := &m2LegacyFixture{
		path: filepath.Join(t.TempDir(), "raft-m1.sqlite"),
		now:  time.Now().Add(-24 * time.Hour).UnixMilli(),
		passwords: map[string]string{
			m2UserA: "m2-upgrade-password-a",
			m2UserB: "m2-upgrade-password-b",
			m2UserC: "m2-upgrade-password-c",
			m2UserD: "m2-upgrade-password-d",
		},
		refresh: map[string]m2RefreshSeed{
			"A1": {Raw: m2RefreshA1, SessionID: m2SessionA, UserID: m2UserA, FamilyID: m2FamilyA},
			"B1": {Raw: m2RefreshB1, SessionID: m2SessionB, UserID: m2UserB, FamilyID: m2FamilyB},
		},
		oneshots: []m2OneShotSeed{
			{Raw: m2VerifySecret, ID: m2VerifyTokenID, UserID: m2UserD, Kind: "email_verification"},
			{Raw: m2ResetSecret, ID: m2ResetTokenID, UserID: m2UserA, Kind: "password_reset"},
		},
	}

	raw := m2OpenRaw(t, f.path, false)
	defer raw.Close()
	ctx := context.Background()

	// An M1 binary's migrate() created this bookkeeping table before applying
	// the chain; recreate it verbatim so the recording below matches the state
	// a real M1 database would be found in.
	if _, err := raw.ExecContext(ctx, `CREATE TABLE IF NOT EXISTS schema_migrations (
		version TEXT PRIMARY KEY,
		applied_at INTEGER NOT NULL
	)`); err != nil {
		t.Fatalf("create schema_migrations: %v", err)
	}

	// Apply the unchanged M1 migrations exactly as an M1 binary would have.
	files := m2MigrationFiles(t)
	if len(files) < 2 || !strings.HasPrefix(files[0], "0001_") || !strings.HasPrefix(files[1], "0002_") {
		t.Fatalf("expected the frozen M1 migrations 0001/0002 first, found %v", files)
	}
	for _, name := range files[:2] {
		body, err := os.ReadFile(filepath.Join("migrations", name))
		if err != nil {
			t.Fatalf("read %s: %v", name, err)
		}
		if _, err := raw.ExecContext(ctx, string(body)); err != nil {
			t.Fatalf("apply unchanged %s: %v", name, err)
		}
		if _, err := raw.ExecContext(ctx,
			`INSERT INTO schema_migrations(version, applied_at) VALUES(?, ?)`,
			name, f.now-dayMs); err != nil {
			t.Fatalf("record %s: %v", name, err)
		}
	}

	// Argon2id hashes with light test parameters; the PHC string carries the
	// parameters, so auth.PasswordHasher.Verify parses them exactly as in
	// production.
	hasher := auth.NewPasswordHasher(8192, 1, 1, 1)
	hashes := make(map[string]string, len(f.passwords))
	for userID, password := range f.passwords {
		h, err := hasher.Hash(password)
		if err != nil {
			t.Fatalf("hash seed password for %s: %v", userID, err)
		}
		hashes[userID] = h
	}

	exec := func(query string, args ...any) {
		t.Helper()
		if _, err := raw.ExecContext(ctx, query, args...); err != nil {
			t.Fatalf("seed: %v (query: %.80s)", err, query)
		}
	}

	// Users: one rich profile, one minimal, one with locale preferences, one
	// unverified guest to prove NULL preservation.
	exec(`
		INSERT INTO users (id, email, name, display_name, description, avatar_url,
			email_verified, password_hash, password_credential_established_at,
			preferred_language, display_language, preferred_timezone,
			auto_translation_enabled, preferred_translation_mode, preferred_time_format,
			referral_source, signup_role, signup_survey_completed_at,
			profile_setup_completed_at, created_at, updated_at)
		VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?)`,
		m2UserA, "a@legacy.test", "legacy_owner_a", "Legacy Owner A",
		"Seeded during the M1 era", m2AvatarUserA, hashes[m2UserA], f.now-9000,
		"en", "en", "UTC", "auto", "24h", "search", "member",
		f.now-8000, f.now-7000, f.now-6000, f.now)
	exec(`INSERT INTO users (id, email, name, email_verified, password_hash, created_at, updated_at)
		VALUES (?, ?, ?, 1, ?, ?, ?)`,
		m2UserB, "b@legacy.test", "legacy_owner_b", hashes[m2UserB], f.now-5000, f.now-4000)
	exec(`INSERT INTO users (id, email, name, display_name, email_verified, password_hash,
			preferred_language, preferred_timezone, preferred_time_format, created_at, updated_at)
		VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?)`,
		m2UserC, "c@legacy.test", "legacy_member_c", "Legacy Member C", hashes[m2UserC],
		"zh", "Asia/Shanghai", "12h", f.now-3000, f.now-2000)
	exec(`INSERT INTO users (id, email, name, email_verified, password_hash, created_at, updated_at)
		VALUES (?, ?, ?, 0, ?, ?, ?)`,
		m2UserD, "d@legacy.test", "legacy_guest_d", hashes[m2UserD], f.now-1500, f.now-1000)

	// Session families: one live, one revoked.
	exec(`INSERT INTO session_families (id, user_id, revoked_at, revoked_reason, created_at) VALUES
			(?, ?, NULL, NULL, ?),
			(?, ?, ?, 'logout', ?)`,
		m2FamilyA, m2UserA, f.now-5000,
		m2FamilyB, m2UserB, f.now-2000, f.now-5000)
	exec(`INSERT INTO sessions (id, user_id, family_id, token_hash, expires_at, created_at) VALUES
			(?, ?, ?, ?, ?, ?),
			(?, ?, ?, ?, ?, ?)`,
		m2SessionA, m2UserA, m2FamilyA, auth.HashToken(m2RefreshA1), f.now+sessionTTL, f.now-5000,
		m2SessionB, m2UserB, m2FamilyB, auth.HashToken(m2RefreshB1), f.now+sessionTTL, f.now-4000)

	// Hash lineage of the already-rotated A-family token.
	exec(`INSERT INTO session_token_predecessors
			(token_hash, session_id, user_id, family_id, expires_at, created_at)
		VALUES (?, ?, ?, ?, ?, ?)`,
		auth.HashToken(m2RefreshA0), m2SessionO, m2UserA, m2FamilyA, f.now+30*dayMs, f.now-4500)

	// Durable rotation receipt holding an AES-256-GCM sealed successor token.
	ct, iv, tag := m2SealReceipt(t, m2RefreshA1)
	exec(`INSERT INTO session_refresh_rotation_receipts
			(id, predecessor_token_hash, predecessor_session_id, user_id, family_id,
			 successor_session_id, attempt_id, installation_id,
			 successor_token_ciphertext, successor_token_iv, successor_token_auth_tag,
			 expires_at, created_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		m2ReceiptID, auth.HashToken(m2RefreshA0), m2SessionO, m2UserA, m2FamilyA,
		m2SessionA, "attempt-0001", "installation-0001", ct, iv, tag,
		f.now+tokenTTL, f.now-4400)

	// One-shot email tokens plus their outliving request ledger rows.
	exec(`INSERT INTO account_tokens (id, user_id, kind, token_hash, expires_at, created_at) VALUES
			(?, ?, 'email_verification', ?, ?, ?),
			(?, ?, 'password_reset', ?, ?, ?)`,
		m2VerifyTokenID, m2UserD, auth.HashToken(m2VerifySecret), f.now+tokenTTL, f.now-900,
		m2ResetTokenID, m2UserA, auth.HashToken(m2ResetSecret), f.now+tokenTTL, f.now-800)
	exec(`INSERT INTO account_email_requests (id, user_id, kind, created_at) VALUES
			(?, ?, 'email_verification', ?),
			(?, ?, 'password_reset', ?),
			(?, ?, 'email_verification', ?),
			(?, ?, 'password_reset', ?)`,
		"er-verify-1", m2UserD, f.now-900,
		"er-reset-1", m2UserA, f.now-800,
		"er-verify-0", m2UserD, f.now-3600000,
		"er-reset-0", m2UserA, f.now-7200000)

	exec(`INSERT INTO legal_acceptances
			(id, user_id, terms_version, privacy_version, terms_url, privacy_url,
			 source, ip_hash, user_agent_hash, locale, accepted_at)
		VALUES (?, ?, ?, ?, ?, ?, 'signup', ?, ?, 'en', ?)`,
		m2AcceptanceID, m2UserA, "2025-06-01", "2025-06-01",
		"https://legacy.test/terms", "https://legacy.test/privacy",
		"ip-hash-1", "ua-hash-1", f.now-5900)

	// Workspaces (one soft-deleted) and memberships covering every M1 role.
	exec(`INSERT INTO workspaces (id, name, slug, owner_id, avatar_url, onboarding_agent_id,
			hide_humans_from_members, plan, plan_downgraded_at, created_at, deleted_at) VALUES
			(?, 'Legacy Alpha', 'legacy-alpha', ?, ?, NULL, 0, 'free', NULL, ?, NULL),
			(?, 'Legacy Beta', 'legacy-beta', ?, NULL, NULL, 1, 'pro', ?, ?, NULL),
			(?, 'Legacy Gone', 'legacy-gone', ?, NULL, NULL, 0, 'founder', NULL, ?, ?)`,
		m2Workspace1, m2UserA, m2AvatarWS1, f.now-5500,
		m2Workspace2, m2UserB, f.now-1000, f.now-5000,
		m2Workspace3, m2UserB, f.now-5200, f.now-1200)
	exec(`INSERT INTO workspace_memberships (workspace_id, user_id, role, server_push_muted, joined_at) VALUES
			(?, ?, 'owner', 0, ?),
			(?, ?, 'admin', 0, ?),
			(?, ?, 'member', 0, ?),
			(?, ?, 'guest', 1, ?),
			(?, ?, 'owner', 0, ?),
			(?, ?, 'member', 1, ?),
			(?, ?, 'owner', 0, ?)`,
		m2Workspace1, m2UserA, f.now-5400,
		m2Workspace1, m2UserB, f.now-5300,
		m2Workspace1, m2UserC, f.now-5200,
		m2Workspace1, m2UserD, f.now-5100,
		m2Workspace2, m2UserB, f.now-4900,
		m2Workspace2, m2UserA, f.now-4800,
		m2Workspace3, m2UserB, f.now-5050)

	// Seed sanity: the fixture the assertions rely on really is in the file.
	for table, want := range map[string]int{
		"users": 4, "workspaces": 3, "workspace_memberships": 7,
		"sessions": 2, "account_tokens": 2, "session_families": 2,
	} {
		var got int
		if err := raw.QueryRowContext(ctx, `SELECT COUNT(*) FROM `+table).Scan(&got); err != nil || got != want {
			t.Fatalf("seed sanity: %s count = %d (err %v); want %d", table, got, err, want)
		}
	}

	f.m1Cols = m2TableColumns(t, raw)
	f.m1Dump = m2DumpM1Tables(t, raw, f.m1Cols)
	return f
}

// m2SealReceipt seals plaintext with a fresh AES-256-GCM key, mirroring how
// the auth package stores rotation receipts (base64 raw-URL parts).
func m2SealReceipt(t *testing.T, plaintext string) (ciphertext, iv, authTag string) {
	t.Helper()
	key := make([]byte, 32)
	if _, err := io.ReadFull(rand.Reader, key); err != nil {
		t.Fatalf("receipt key: %v", err)
	}
	block, err := aes.NewCipher(key)
	if err != nil {
		t.Fatalf("receipt cipher: %v", err)
	}
	aead, err := cipher.NewGCM(block)
	if err != nil {
		t.Fatalf("receipt gcm: %v", err)
	}
	nonce := make([]byte, aead.NonceSize())
	if _, err := io.ReadFull(rand.Reader, nonce); err != nil {
		t.Fatalf("receipt nonce: %v", err)
	}
	sealed := aead.Seal(nil, nonce, []byte(plaintext), nil)
	return base64.RawURLEncoding.EncodeToString(sealed[:len(sealed)-aead.Overhead()]),
		base64.RawURLEncoding.EncodeToString(nonce),
		base64.RawURLEncoding.EncodeToString(sealed[len(sealed)-aead.Overhead():])
}

type m2Querier interface {
	QueryContext(ctx context.Context, query string, args ...any) (*sql.Rows, error)
}

// m2TableColumns captures the column names of every M1 table. Post-upgrade
// dumps re-query exactly these columns, so a renamed or dropped M1 column
// fails loudly instead of silently comparing a subset.
func m2TableColumns(t *testing.T, q m2Querier) map[string][]string {
	t.Helper()
	out := make(map[string][]string, len(m2M1TableOrder))
	for table := range m2M1TableOrder {
		rows, err := q.QueryContext(context.Background(), "PRAGMA table_info("+table+")")
		if err != nil {
			t.Fatalf("read schema of %s: %v", table, err)
		}
		var cols []string
		for rows.Next() {
			var cid int
			var name, typ string
			var notNull, pk int
			var dflt sql.NullString
			if err := rows.Scan(&cid, &name, &typ, &notNull, &dflt, &pk); err != nil {
				rows.Close()
				t.Fatalf("scan table_info(%s): %v", table, err)
			}
			cols = append(cols, name)
		}
		if err := rows.Err(); err != nil {
			rows.Close()
			t.Fatalf("iterate table_info(%s): %v", table, err)
		}
		rows.Close()
		if len(cols) == 0 {
			t.Fatalf("M1 table %s is missing from the database", table)
		}
		out[table] = cols
	}
	return out
}

// m2DumpM1Tables renders every M1 table through its captured column list in
// a deterministic order, so two dumps are comparable byte for byte.
func m2DumpM1Tables(t *testing.T, q m2Querier, cols map[string][]string) map[string]string {
	t.Helper()
	tables := make([]string, 0, len(m2M1TableOrder))
	for table := range m2M1TableOrder {
		tables = append(tables, table)
	}
	sort.Strings(tables)
	out := make(map[string]string, len(tables))
	ctx := context.Background()
	for _, table := range tables {
		query := fmt.Sprintf("SELECT %s FROM %s ORDER BY %s",
			strings.Join(cols[table], ", "), table, m2M1TableOrder[table])
		rows, err := q.QueryContext(ctx, query)
		if err != nil {
			t.Fatalf("dump %s: %v", table, err)
		}
		var sb strings.Builder
		vals := make([]any, len(cols[table]))
		dest := make([]any, len(vals))
		for i := range vals {
			dest[i] = &vals[i]
		}
		for rows.Next() {
			if err := rows.Scan(dest...); err != nil {
				rows.Close()
				t.Fatalf("scan %s: %v", table, err)
			}
			for i, col := range cols[table] {
				fmt.Fprintf(&sb, "%s=%v\t", col, vals[i])
			}
			sb.WriteByte('\n')
		}
		if err := rows.Err(); err != nil {
			rows.Close()
			t.Fatalf("iterate %s: %v", table, err)
		}
		rows.Close()
		out[table] = sb.String()
	}
	return out
}

// m2RequireSameDump compares pre/post-upgrade dumps of the M1 tables.
func m2RequireSameDump(t *testing.T, label string, before, after map[string]string) {
	t.Helper()
	tables := make([]string, 0, len(before))
	for table := range before {
		tables = append(tables, table)
	}
	sort.Strings(tables)
	for _, table := range tables {
		if before[table] != after[table] {
			t.Errorf("%s: M1 rows of %s changed across the upgrade\n--- before ---\n%s\n--- after ---\n%s",
				label, table, m2Excerpt(before[table]), m2Excerpt(after[table]))
		}
	}
}

func m2Excerpt(s string) string {
	const limit = 1600
	if len(s) <= limit {
		return s
	}
	return s[:limit] + "...(truncated)"
}

// m2SchemaVersions returns the sorted recorded migration versions.
func m2SchemaVersions(t *testing.T, q m2Querier) []string {
	t.Helper()
	rows, err := q.QueryContext(context.Background(), `SELECT version FROM schema_migrations`)
	if err != nil {
		t.Fatalf("read schema_migrations: %v", err)
	}
	defer rows.Close()
	var out []string
	for rows.Next() {
		var v string
		if err := rows.Scan(&v); err != nil {
			t.Fatalf("scan schema_migrations: %v", err)
		}
		out = append(out, v)
	}
	if err := rows.Err(); err != nil {
		t.Fatalf("iterate schema_migrations: %v", err)
	}
	sort.Strings(out)
	return out
}

// m2RequireSchemaVersions asserts every embedded migration is recorded
// exactly once and nothing else is.
func m2RequireSchemaVersions(t *testing.T, q m2Querier, wantFiles []string) {
	t.Helper()
	want := slices.Clone(wantFiles)
	sort.Strings(want)
	got := m2SchemaVersions(t, q)
	if !slices.Equal(got, want) {
		t.Fatalf("schema_migrations = %v; want each embedded migration exactly once: %v", got, want)
	}
}

// m2RequireIntegrity asserts an empty foreign_key_check and a passing
// integrity_check, the migration acceptance bar from the phase-2 design.
func m2RequireIntegrity(t *testing.T, q m2Querier) {
	t.Helper()
	ctx := context.Background()
	rows, err := q.QueryContext(ctx, `PRAGMA foreign_key_check`)
	if err != nil {
		t.Fatalf("foreign_key_check: %v", err)
	}
	var violations []string
	for rows.Next() {
		// The pragma reports table, rowid, parent table and constraint id
		// (same shape the migration runner's checkForeignKeys consumes).
		var table string
		var rowid sql.NullInt64
		var parent sql.NullString
		var fkid int64
		if err := rows.Scan(&table, &rowid, &parent, &fkid); err != nil {
			rows.Close()
			t.Fatalf("scan foreign_key_check: %v", err)
		}
		violations = append(violations,
			fmt.Sprintf("%s row=%d parent=%v constraint=%d", table, rowid.Int64, parent.String, fkid))
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		t.Fatalf("iterate foreign_key_check: %v", err)
	}
	rows.Close()
	if len(violations) > 0 {
		t.Fatalf("PRAGMA foreign_key_check must be empty; violations: %s", strings.Join(violations, "; "))
	}
	irows, err := q.QueryContext(ctx, `PRAGMA integrity_check`)
	if err != nil {
		t.Fatalf("integrity_check: %v", err)
	}
	defer irows.Close()
	var status string
	for irows.Next() {
		if err := irows.Scan(&status); err != nil {
			t.Fatalf("scan integrity_check: %v", err)
		}
	}
	if err := irows.Err(); err != nil {
		t.Fatalf("iterate integrity_check: %v", err)
	}
	if status != "ok" {
		t.Fatalf("PRAGMA integrity_check = %q; want ok", status)
	}
}

// TestM2UpgradePreservesM1Data upgrades a fully seeded M1 database in place
// through store.Open and verifies every M1 fact survives: the complete dump
// of all M1 columns is byte-identical, passwords still verify, refresh and
// one-shot tokens still resolve, the M1 server-list query still returns the
// same roles, and referential integrity is clean.
func TestM2UpgradePreservesM1Data(t *testing.T) {
	f := m2BuildLegacyM1(t)

	upgraded, err := store.Open(f.path)
	if err != nil {
		t.Fatalf("db.Open must upgrade the M1 database in place: %v", err)
	}
	defer upgraded.Close()

	m2RequireSchemaVersions(t, upgraded, m2MigrationFiles(t))
	m2RequireSameDump(t, "in-place upgrade", f.m1Dump, m2DumpM1Tables(t, upgraded, f.m1Cols))

	// Password hashes remain verifiable against the original secrets.
	hasher := auth.NewPasswordHasher(8192, 1, 1, 1)
	for userID, password := range f.passwords {
		var stored string
		if err := upgraded.QueryRow(`SELECT password_hash FROM users WHERE id = ?`, userID).Scan(&stored); err != nil {
			t.Errorf("user %s lost across upgrade: %v", userID, err)
			continue
		}
		if !hasher.Verify(password, stored) {
			t.Errorf("stored password hash for user %s no longer verifies against the M1 secret", userID)
		}
	}

	// Refresh tokens still resolve to the same sessions (the exact lookup the
	// auth package performs on every refresh).
	for label, seed := range f.refresh {
		var sid, uid, fam string
		var expires int64
		err := upgraded.QueryRow(
			`SELECT id, user_id, family_id, expires_at FROM sessions WHERE token_hash = ?`,
			auth.HashToken(seed.Raw)).Scan(&sid, &uid, &fam, &expires)
		if err != nil {
			t.Errorf("refresh token %s no longer resolves after upgrade: %v", label, err)
			continue
		}
		if sid != seed.SessionID || uid != seed.UserID || fam != seed.FamilyID {
			t.Errorf("refresh token %s resolves to %s/%s/%s; want %s/%s/%s",
				label, sid, uid, fam, seed.SessionID, seed.UserID, seed.FamilyID)
		}
	}

	// One-shot verification/reset tokens still resolve by hash and kind.
	for _, seed := range f.oneshots {
		var id string
		err := upgraded.QueryRow(
			`SELECT id FROM account_tokens WHERE token_hash = ? AND kind = ?`,
			auth.HashToken(seed.Raw), seed.Kind).Scan(&id)
		if err != nil {
			t.Errorf("one-shot %s token %s no longer resolves: %v", seed.Kind, seed.ID, err)
			continue
		}
		if id != seed.ID {
			t.Errorf("%s token resolves to id %s; want %s", seed.Kind, id, seed.ID)
		}
	}

	// The M1 membership list query (GET /api/servers) still returns the same
	// roles in the same order for a member of two workspaces.
	rows, err := upgraded.Query(`
		SELECT m.role FROM workspace_memberships m
		JOIN workspaces w ON w.id = m.workspace_id
		WHERE m.user_id = ? AND w.deleted_at IS NULL
		ORDER BY m.joined_at ASC, w.id ASC`, m2UserA)
	if err != nil {
		t.Fatalf("M1 server-list query: %v", err)
	}
	var roles []string
	for rows.Next() {
		var role string
		if err := rows.Scan(&role); err != nil {
			rows.Close()
			t.Fatalf("scan M1 server-list row: %v", err)
		}
		roles = append(roles, role)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		t.Fatalf("iterate M1 server-list rows: %v", err)
	}
	rows.Close()
	if !slices.Equal(roles, []string{"owner", "member"}) {
		t.Fatalf("M1 server list for user A = %v; want [owner member] (existing roles untouched)", roles)
	}

	m2RequireIntegrity(t, upgraded)
}

// TestM2UpgradeNewMembershipDefaultsToMember verifies the corrected default
// membership role from design item D05: once the M2 migration has landed,
// inserting a membership without an explicit role must yield member (M1
// defaulted to owner), while explicit roles — including a co-owner — stay
// expressible and existing M1 roles are untouched.
func TestM2UpgradeNewMembershipDefaultsToMember(t *testing.T) {
	if !m2PendingMigrations(t) {
		t.Skip("no M2 migrations (>=0003) on disk yet; M1 default role is still 'owner' — rerun once migrations 0003+ land")
	}
	f := m2BuildLegacyM1(t)

	upgraded, err := store.Open(f.path)
	if err != nil {
		t.Fatalf("db.Open must upgrade the M1 database in place: %v", err)
	}
	defer upgraded.Close()

	defer func() {
		_, _ = upgraded.Exec(`DELETE FROM workspace_memberships WHERE workspace_id = ? AND user_id IN (?, ?)`,
			m2Workspace2, m2UserC, m2UserD)
	}()

	if _, err := upgraded.Exec(
		`INSERT INTO workspace_memberships (workspace_id, user_id, joined_at) VALUES (?, ?, ?)`,
		m2Workspace2, m2UserC, f.now+60000); err != nil {
		t.Fatalf("insert membership without an explicit role: %v", err)
	}
	var role string
	if err := upgraded.QueryRow(
		`SELECT role FROM workspace_memberships WHERE workspace_id = ? AND user_id = ?`,
		m2Workspace2, m2UserC).Scan(&role); err != nil {
		t.Fatalf("read back default role: %v", err)
	}
	if role != "member" {
		t.Fatalf("new memberships must default to role=member after the M2 migration corrected D05; got %q", role)
	}

	// Explicit roles, including a second owner, remain expressible (the
	// multi-owner model is deliberately retained; design R14).
	if _, err := upgraded.Exec(
		`INSERT INTO workspace_memberships (workspace_id, user_id, role, joined_at) VALUES (?, ?, 'owner', ?)`,
		m2Workspace2, m2UserD, f.now+61000); err != nil {
		t.Fatalf("insert explicit owner (co-owner) membership: %v", err)
	}
	if err := upgraded.QueryRow(
		`SELECT role FROM workspace_memberships WHERE workspace_id = ? AND user_id = ?`,
		m2Workspace2, m2UserD).Scan(&role); err != nil || role != "owner" {
		t.Fatalf("explicit owner role must round-trip; got role=%q err=%v", role, err)
	}

	// Existing M1 owner rows are not downgraded by the default change.
	if err := upgraded.QueryRow(
		`SELECT role FROM workspace_memberships WHERE workspace_id = ? AND user_id = ?`,
		m2Workspace1, m2UserA).Scan(&role); err != nil || role != "owner" {
		t.Fatalf("legacy owner membership must stay owner; got role=%q err=%v", role, err)
	}
}

// TestM2UpgradeFailureRollsBackAndRetryUpgrades injects a failure into the
// migration recording step through an isolated SQLite trigger (the migration
// body and its version INSERT share one transaction), asserts db.Open fails
// closed with the M1 data byte-identical and the failed migration unrecorded,
// then clears the fault and verifies a retry upgrades cleanly.
func TestM2UpgradeFailureRollsBackAndRetryUpgrades(t *testing.T) {
	if !m2PendingMigrations(t) {
		t.Skip("no M2 migrations (>=0003) on disk yet; nothing to inject a failure into — rerun once migrations 0003+ land")
	}
	f := m2BuildLegacyM1(t)

	raw := m2OpenRaw(t, f.path, false)
	if _, err := raw.Exec(`
		CREATE TRIGGER m2_test_block_m2_migrations
		BEFORE INSERT ON schema_migrations
		FOR EACH ROW
		WHEN NEW.version >= '0003'
		BEGIN
			SELECT RAISE(ABORT, 'm2 test: injected migration failure');
		END`); err != nil {
		t.Fatalf("install failure-injection trigger: %v", err)
	}
	raw.Close()

	if _, err := store.Open(f.path); err == nil {
		t.Fatal("db.Open must fail when a migration fails, not report a half-upgraded database as ready")
	}

	// The failed upgrade left the M1 state exactly as it was.
	raw = m2OpenRaw(t, f.path, false)
	files := m2MigrationFiles(t)
	if got := m2SchemaVersions(t, raw); !slices.Equal(got, files[:2]) {
		t.Fatalf("a failed migration must not be recorded; schema_migrations = %v; want %v", got, files[:2])
	}
	m2RequireSameDump(t, "rolled-back upgrade", f.m1Dump, m2DumpM1Tables(t, raw, f.m1Cols))
	m2RequireIntegrity(t, raw)
	if _, err := raw.Exec(`DROP TRIGGER m2_test_block_m2_migrations`); err != nil {
		t.Fatalf("drop failure-injection trigger: %v", err)
	}
	raw.Close()

	// Retrying the upgrade after the fault clears completes cleanly.
	upgraded, err := store.Open(f.path)
	if err != nil {
		t.Fatalf("retry upgrade after clearing the fault: %v", err)
	}
	defer upgraded.Close()
	m2RequireSchemaVersions(t, upgraded, files)
	m2RequireSameDump(t, "retry upgrade", f.m1Dump, m2DumpM1Tables(t, upgraded, f.m1Cols))
	m2RequireIntegrity(t, upgraded)
}

// TestM2WriteLockWaitIsContextCancellable holds the single WAL write slot
// from a second connection and verifies STRICT context-cancellation of the
// pooled write path (native 50ms busy waits bridged by the Go-side
// context-aware retry in the busy connector):
//
//   - a context that is already cancelled rejects a pooled write begin
//     immediately, without entering the wait;
//   - a context whose deadline expires MID-WAIT must interrupt the begin
//     within 1 second (300ms deadline + bounded slack) with the context
//     error — never the pre-fix behavior of sleeping through the whole
//     native busy_timeout budget;
//   - the interrupted begin applied nothing;
//   - after the lock is released the same pooled handle writes again.
func TestM2WriteLockWaitIsContextCancellable(t *testing.T) {
	f := m2BuildLegacyM1(t)

	upgraded, err := store.Open(f.path)
	if err != nil {
		t.Fatalf("open the upgraded database: %v", err)
	}
	defer upgraded.Close()

	holder := m2OpenRaw(t, f.path, true) // _txlock=immediate, like the app pool
	defer holder.Close()
	lockTx, err := holder.BeginTx(context.Background(), nil)
	if err != nil {
		t.Fatalf("acquire write lock: %v", err)
	}
	// BEGIN IMMEDIATE reserves the write slot; the probe write makes the
	// held lock explicit and is rolled back with the transaction.
	if _, err := lockTx.Exec(
		`INSERT INTO account_email_requests (id, user_id, kind, created_at) VALUES ('m2-lock-probe', ?, 'email_verification', ?)`,
		m2UserA, f.now); err != nil {
		t.Fatalf("probe write inside the lock: %v", err)
	}

	// Already-cancelled contexts must never enter the lock wait.
	preCtx, preCancel := context.WithCancel(context.Background())
	preCancel()
	start := time.Now()
	if _, err := upgraded.BeginTx(preCtx, nil); err == nil {
		t.Fatal("a write begin with an already-cancelled context must fail immediately")
	} else if elapsed := time.Since(start); elapsed > time.Second {
		t.Fatalf("pre-cancelled context entered a lock wait (%v); it must be rejected up front", elapsed)
	}

	// Mid-wait cancellation is the acceptance bar: a 300ms deadline must
	// interrupt the begin quickly, not after the 10s contention budget.
	waitCtx, waitCancel := context.WithTimeout(context.Background(), 300*time.Millisecond)
	defer waitCancel()
	start = time.Now()
	if _, err := upgraded.BeginTx(waitCtx, nil); err == nil {
		t.Fatal("beginning a write transaction must not succeed while another connection holds the write lock")
	} else {
		elapsed := time.Since(start)
		if elapsed >= time.Second {
			t.Fatalf("mid-wait context cancellation was not honored: begin blocked %v with a 300ms deadline (pre-fix behavior slept through the busy budget)", elapsed)
		}
		if !errors.Is(err, context.DeadlineExceeded) {
			t.Fatalf("mid-wait cancelled begin must surface the context error, got %v", err)
		}
		t.Logf("mid-wait cancelled begin returned after %v (err=%v)", elapsed, err)
	}

	// Releasing the lock restores writability on the same pooled handle:
	// begin, one write, commit.
	if err := lockTx.Rollback(); err != nil {
		t.Fatalf("release write lock: %v", err)
	}
	tx, err := upgraded.BeginTx(context.Background(), nil)
	if err != nil {
		t.Fatalf("begin write after lock release: %v", err)
	}
	if _, err := tx.Exec(
		`INSERT INTO account_email_requests (id, user_id, kind, created_at) VALUES ('m2-write-probe', ?, 'email_verification', ?)`,
		m2UserA, f.now); err != nil {
		t.Fatalf("probe write after lock release: %v", err)
	}
	if err := tx.Commit(); err != nil {
		t.Fatalf("commit probe write: %v", err)
	}
	if _, err := upgraded.Exec(
		`DELETE FROM account_email_requests WHERE id IN ('m2-lock-probe', 'm2-write-probe')`); err != nil {
		t.Fatalf("clean probe rows: %v", err)
	}
}

// TestM2ExecContextLockWaitCancelsAndNeverDuplicatesWrite pins the single
// autocommit statement path of the busy connector: a direct ExecContext
// write whose context expires mid-wait fails fast with the context error,
// is applied ZERO times (nothing partially committed under cancellation),
// and once the lock is released the very same statement succeeds and lands
// exactly once — the connector's internal retries must never duplicate a
// write.
func TestM2ExecContextLockWaitCancelsAndNeverDuplicatesWrite(t *testing.T) {
	f := m2BuildLegacyM1(t)

	upgraded, err := store.Open(f.path)
	if err != nil {
		t.Fatalf("open the upgraded database: %v", err)
	}
	defer upgraded.Close()

	holder := m2OpenRaw(t, f.path, true)
	defer holder.Close()
	lockTx, err := holder.BeginTx(context.Background(), nil)
	if err != nil {
		t.Fatalf("acquire write lock: %v", err)
	}

	const insert = `INSERT INTO account_email_requests (id, user_id, kind, created_at) VALUES ('m2-exec-probe', ?, 'email_verification', ?)`
	count := func() int {
		t.Helper()
		var n int
		// WAL readers proceed while another connection holds the write lock.
		if err := upgraded.QueryRow(
			`SELECT COUNT(*) FROM account_email_requests WHERE id = 'm2-exec-probe'`).Scan(&n); err != nil {
			t.Fatalf("count probe rows: %v", err)
		}
		return n
	}

	// Direct ExecContext, deadline expires mid-wait: fast, ctx-typed failure.
	ctx, cancel := context.WithTimeout(context.Background(), 300*time.Millisecond)
	defer cancel()
	start := time.Now()
	if _, err := upgraded.ExecContext(ctx, insert, m2UserA, f.now); err == nil {
		t.Fatal("an autocommit write must not succeed while another connection holds the write lock")
	} else {
		elapsed := time.Since(start)
		if elapsed >= time.Second {
			t.Fatalf("mid-wait context cancellation was not honored: ExecContext blocked %v with a 300ms deadline", elapsed)
		}
		if !errors.Is(err, context.DeadlineExceeded) {
			t.Fatalf("mid-wait cancelled ExecContext must surface the context error, got %v", err)
		}
		t.Logf("mid-wait cancelled ExecContext returned after %v (err=%v)", elapsed, err)
	}

	// The cancelled statement was applied zero times, not partially.
	if n := count(); n != 0 {
		t.Fatalf("cancelled ExecContext applied the write %d times; want 0", n)
	}

	// Eventual lock release: the same statement succeeds and lands exactly
	// once — cancelled attempts leave no duplicate-behind-duplicate behind.
	if err := lockTx.Rollback(); err != nil {
		t.Fatalf("release write lock: %v", err)
	}
	if _, err := upgraded.ExecContext(context.Background(), insert, m2UserA, f.now); err != nil {
		t.Fatalf("retry the same write after lock release: %v", err)
	}
	if n := count(); n != 1 {
		t.Fatalf("write landed %d times after success + earlier cancelled attempt; want exactly 1 (no duplicate from connector retries)", n)
	}
	if _, err := upgraded.Exec(`DELETE FROM account_email_requests WHERE id = 'm2-exec-probe'`); err != nil {
		t.Fatalf("clean probe rows: %v", err)
	}
}

// TestM2BusyRetriesBridgeTransientLockExactlyOnce covers the constructive
// side of the connector: a write that STARTS while the lock is held by
// another connection, with a live context outliving the contention, must
// bridge the transient BUSY window through its retry loop, apply EXACTLY
// once, and succeed well inside its context budget — both for a single
// autocommit ExecContext and for the BeginTx acquisition path.
func TestM2BusyRetriesBridgeTransientLockExactlyOnce(t *testing.T) {
	f := m2BuildLegacyM1(t)

	upgraded, err := store.Open(f.path)
	if err != nil {
		t.Fatalf("open the upgraded database: %v", err)
	}
	defer upgraded.Close()

	holder := m2OpenRaw(t, f.path, true)
	defer holder.Close()
	lockTx, err := holder.BeginTx(context.Background(), nil)
	if err != nil {
		t.Fatalf("acquire write lock: %v", err)
	}
	if _, err := lockTx.Exec(
		`INSERT INTO account_email_requests (id, user_id, kind, created_at) VALUES ('m2-hold-probe', ?, 'email_verification', ?)`,
		m2UserA, f.now); err != nil {
		t.Fatalf("probe write inside the lock: %v", err)
	}

	count := func(id string) int {
		t.Helper()
		var n int
		if err := upgraded.QueryRow(
			`SELECT COUNT(*) FROM account_email_requests WHERE id = ?`, id).Scan(&n); err != nil {
			t.Fatalf("count probe rows: %v", err)
		}
		return n
	}

	// Autocommit statement bridges a ~400ms transient lock.
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	done := make(chan error, 1)
	start := time.Now()
	go func() {
		_, err := upgraded.ExecContext(ctx,
			`INSERT INTO account_email_requests (id, user_id, kind, created_at) VALUES ('m2-bridge-exec', ?, 'email_verification', ?)`,
			m2UserA, f.now)
		done <- err
	}()
	time.Sleep(400 * time.Millisecond)
	if err := lockTx.Rollback(); err != nil {
		t.Fatalf("release write lock: %v", err)
	}
	if err := <-done; err != nil {
		t.Fatalf("autocommit write must bridge a transient lock via retries: %v", err)
	}
	if elapsed := time.Since(start); elapsed < 300*time.Millisecond {
		t.Fatalf("bridged write returned after %v; it must actually have waited for the lock", elapsed)
	}
	if n := count("m2-bridge-exec"); n != 1 {
		t.Fatalf("bridged autocommit write landed %d times; want exactly 1 (retry loop must not replay a successful attempt)", n)
	}

	// BeginTx acquisition bridges the same transient contention.
	lockTx, err = holder.BeginTx(context.Background(), nil)
	if err != nil {
		t.Fatalf("re-acquire write lock: %v", err)
	}
	txReady := make(chan error, 1)
	go func() {
		tx, err := upgraded.BeginTx(ctx, nil)
		if err != nil {
			txReady <- err
			return
		}
		if _, err := tx.Exec(
			`INSERT INTO account_email_requests (id, user_id, kind, created_at) VALUES ('m2-bridge-tx', ?, 'email_verification', ?)`,
			m2UserA, f.now); err != nil {
			_ = tx.Rollback()
			txReady <- err
			return
		}
		txReady <- tx.Commit()
	}()
	time.Sleep(400 * time.Millisecond)
	if err := lockTx.Rollback(); err != nil {
		t.Fatalf("release write lock: %v", err)
	}
	if err := <-txReady; err != nil {
		t.Fatalf("tx write must bridge a transient lock via begin retries: %v", err)
	}
	if n := count("m2-bridge-tx"); n != 1 {
		t.Fatalf("bridged tx write landed %d times; want exactly 1", n)
	}

	if _, err := upgraded.Exec(
		`DELETE FROM account_email_requests WHERE id IN ('m2-hold-probe', 'm2-bridge-exec', 'm2-bridge-tx')`); err != nil {
		t.Fatalf("clean probe rows: %v", err)
	}
}

// TestM2OpenUnderHeldWriteLockLeavesNoPartialState runs db.Open while
// another connection holds the write lock. Blocked writers may fail cleanly
// (busy) or — when nothing remains to migrate and the open path can finish
// on WAL reads alone — succeed, but never half-apply migrations; a retry
// after the lock is released must complete the full chain with M1 data intact.
func TestM2OpenUnderHeldWriteLockLeavesNoPartialState(t *testing.T) {
	if testing.Short() {
		t.Skip("exercises the full busy_timeout window (~10s) on purpose")
	}
	f := m2BuildLegacyM1(t)

	holder := m2OpenRaw(t, f.path, true)
	lockTx, err := holder.BeginTx(context.Background(), nil)
	if err != nil {
		holder.Close()
		t.Fatalf("acquire write lock: %v", err)
	}
	if _, err := lockTx.Exec(
		`INSERT INTO account_email_requests (id, user_id, kind, created_at) VALUES ('m2-open-probe', ?, 'email_verification', ?)`,
		m2UserA, f.now); err != nil {
		t.Fatalf("probe write inside the lock: %v", err)
	}

	start := time.Now()
	upgraded, err := store.Open(f.path)
	elapsed := time.Since(start)
	if err != nil {
		// Clean failure is acceptable; exceeding Open's own 30s bound is not.
		if elapsed > 35*time.Second {
			t.Fatalf("db.Open ignored its own bound while blocked on the write lock (took %v)", elapsed)
		}
	} else {
		upgraded.Close()
	}
	m2RequireIntegrity(t, holder)

	if err := lockTx.Rollback(); err != nil {
		t.Fatalf("release write lock: %v", err)
	}
	holder.Close()

	final, err := store.Open(f.path)
	if err != nil {
		t.Fatalf("open after the lock is released: %v", err)
	}
	defer final.Close()
	m2RequireSchemaVersions(t, final, m2MigrationFiles(t))
	m2RequireSameDump(t, "open under held write lock", f.m1Dump, m2DumpM1Tables(t, final, f.m1Cols))
	m2RequireIntegrity(t, final)
}
