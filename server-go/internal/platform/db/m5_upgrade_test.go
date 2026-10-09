// M4→M5 database upgrade review suite.
//
// Ownership note: this file belongs to the M5 MIGRATION ACCEPTANCE reviewer
// (m5-execution-lock.md worker F); the frozen migrations 0001–0013 and every
// M5 migration (0014+) belong to the delivery worker and are never edited
// here. The suite builds a REAL M4 database by applying the unchanged
// 0001–0013 SQL verbatim to a temporary SQLite file (schema_migrations
// records exactly those versions — the state the frozen M4 binary 336b5c8
// leaves behind), seeds representative M4 rows through the shapes the real
// M4 writers produce (auth/session lineage with a sealed rotation receipt,
// workspace/channels/thread/DM, messages with random_id idempotency digests,
// human mentions, reactions + version counters, publications, readstate and
// activity windows, machine/computer/agent identity with a real argon2
// credential hash), then upgrades in place through store.Open and asserts:
//
//   - the frozen 0001–0013 chain stays an untouched prefix of the directory;
//   - every M4 row and column survives byte-identically; passwords verify,
//     refresh tokens resolve, the seq/idempotency facts are unchanged;
//   - schema changes are strictly additive: nothing dropped/redefined, no
//     backfill outside the documented whitelists, new tables start empty;
//   - unconfirmed M5 delivery intents (pending agent_deliveries + a managed
//     in-flight occurrence + an external claim lease, seeded exactly as the
//     delivery Store writes them per docs/m5-delivery-worker-contract.md §1)
//     survive close/reopen unchanged — restart recovery of pending
//     deliveries at the persistence layer, which is the guarantee phase-5
//     §12 requires regardless of HTTP surface availability;
//   - a failed 0014 rolls back to the byte-identical M4 state and a retry
//     upgrades cleanly; repeated opens record every migration exactly once.
//
// The M5 table column set is pinned against the frozen contract; a divergent
// installed schema fails with the exact diff instead of being skipped.
// Stages that structurally require an 0014+ skip with an explicit message
// until the migration lands and tighten automatically afterwards.
package db_test

import (
	"context"
	"database/sql"
	"fmt"
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

// Fixed M4-era identifiers so dumps and assertions stay deterministic.
const (
	m5OwnerUser  = "11e50000-0000-4000-8000-000000000001"
	m5MemberUser = "22e50000-0000-4000-8000-000000000002" // > owner: DM user_low/user_high order

	m5Workspace1 = "33e50000-0000-4000-8000-000000000001"

	m5FamilyOwner   = "44e50000-0000-4000-8000-000000000001"
	m5SessionOwner  = "44e50000-0000-4000-8000-000000000002"
	m5SessionOld    = "44e50000-0000-4000-8000-000000000003"
	m5ReceiptID     = "44e50000-0000-4000-8000-000000000004"
	m5AcceptanceID  = "44e50000-0000-4000-8000-000000000005"
	m5AuditID1      = "44e50000-0000-4000-8000-000000000006"
	m5PublicationID = 1 // AUTOINCREMENT: first two rows are 1 and 2

	m5ChannelAll      = "55e50000-0000-4000-8000-000000000001"
	m5ChannelAnnounce = "55e50000-0000-4000-8000-000000000002"
	m5ChannelGeneral  = "55e50000-0000-4000-8000-000000000003"
	m5ChannelPrivate  = "55e50000-0000-4000-8000-000000000004"
	m5ChannelDM       = "55e50000-0000-4000-8000-000000000005"
	m5ChannelThread   = "55e50000-0000-4000-8000-000000000006"

	m5Machine1  = "66e50000-0000-4000-8000-000000000001"
	m5Computer1 = "77e50000-0000-4000-8000-000000000001"
	m5CredID    = "77e50000-0000-4000-8000-000000000002"

	m5Agent1 = "88e50000-0000-4000-8000-000000000001"

	m5MessageOriginal = "99e50000-0000-4000-8000-000000000001"
	m5MessageThread   = "99e50000-0000-4000-8000-000000000002"
	m5MessageDM       = "99e50000-0000-4000-8000-000000000003"

	// M5 delivery rows seeded as the delivery Store would write them.
	m5Delivery1   = "aae50000-0000-4000-8000-000000000001" // pending, managed
	m5Delivery2   = "aae50000-0000-4000-8000-000000000002" // leased, external claim
	m5Occurrence1 = "bbe50000-0000-4000-8000-000000000001"
	m5Occurrence2 = "bbe50000-0000-4000-8000-000000000002"
	m5ClaimID     = "cce50000-0000-4000-8000-000000000001"
)

// Opaque legacy-shape secrets; only hashes persist.
const (
	m5RefreshOwner1 = "1100000000000000000000000000000000000000000000000000000000000aa"
	m5RefreshOwner0 = "1100000000000000000000000000000000000000000000000000000000000a0"
	m5AgentAPIKey   = "sk_agent_m5_seed_5f0000000000000000000000000000000000000000aa"
)

// m5FrozenM4Migrations is the exact, ordered migration set the frozen M4
// binary (336b5c8) applies. The fixture fails loudly if these change shape.
var m5FrozenM4Migrations = []string{
	"0001_init.sql",
	"0002_account_email_requests.sql",
	"0003_workspace_foundation.sql",
	"0004_workspace_setup.sql",
	"0005_workspace_preferences.sql",
	"0006_channel_core.sql",
	"0007_computer_admission.sql",
	"0008_agent_identity.sql",
	"0009_workspace_invitations.sql",
	"0010_messaging_foundation.sql",
	"0011_readstate_activity.sql",
	"0012_authority_epochs.sql",
	"0013_activity_mute_epochs.sql",
}

// m5M4TableOrder fixes the deterministic dump order for every M4 table the
// upgrade must preserve. It doubles as the snapshot list.
var m5M4TableOrder = map[string]string{
	"users":                                "id",
	"session_families":                     "id",
	"sessions":                             "id",
	"session_token_predecessors":           "token_hash",
	"session_refresh_rotation_receipts":    "id",
	"account_tokens":                       "id",
	"account_email_requests":               "id",
	"legal_acceptances":                    "id",
	"workspaces":                           "id",
	"workspace_memberships":                "workspace_id, user_id",
	"workspace_membership_agreement_audit": "id",
	"channels":                             "id",
	"channel_humans":                       "channel_id, user_id",
	"channel_agents":                       "channel_id, agent_id",
	"channel_membership_role_events":       "id",
	"account_workspace_order":              "user_id",
	"workspace_member_setup":               "workspace_id, user_id",
	"machines":                             "id",
	"computers":                            "id",
	"device_authorizations":                "id",
	"agents":                               "id",
	"agent_members":                        "workspace_id, agent_id",
	"agent_credentials":                    "id",
	"agent_bootstrap_tokens":               "id",
	"machine_pending_agent_purges":         "machine_id, agent_id",
	"workspace_member_preferences":         "workspace_id, user_id",
	"messages":                             "seq",
	"message_mentions":                     "message_id, user_id",
	"message_reactions":                    "message_id, user_id, emoji",
	"message_reaction_discussion_versions": "message_id, emoji",
	"message_reaction_viewer_versions":     "message_id, user_id",
	"direct_messages":                      "workspace_id, user_low, user_high",
	"thread_follows":                       "workspace_id, user_id, thread_channel_id",
	"realtime_publications":                "id",
	"user_channel_read_states":             "workspace_id, user_id, channel_id",
	"user_channel_done_states":             "workspace_id, user_id, channel_id",
	"user_mention_suppressions":            "workspace_id, user_id, target_kind, channel_id",
	"user_channel_mute_states":             "workspace_id, user_id, channel_id",
	"user_channel_display_prefs":           "workspace_id, user_id, channel_id",
	"user_channel_mute_epochs":             "workspace_id, user_id, channel_id, epoch_version",
	"activity_principal_authorities":       "workspace_id, principal_id",
	"activity_scopes":                      "workspace_id, principal_id, filter, window_id",
	"activity_row_authorities":             "workspace_id, principal_id, row_id",
	"activity_rows":                        "workspace_id, principal_id, filter, window_id, row_id",
	"activity_changes":                     "workspace_id, principal_id, filter, window_id, seq",
	"authority_clock":                      "id",
	"authority_epochs":                     "kind, scope_id",
}

// Documented-change whitelists, mirroring the M3 review bar. 0014 is declared
// purely additive (docs/m5-delivery-worker-contract.md §1: no row inserted,
// no 0001–0013 statement rewritten), so both maps start empty: any M5
// migration writing into pre-existing rows or new tables must be registered
// here with its contract reference or fails the additivity test.
var m5DocumentedMigrationBackfills = map[string]map[string]string{}
var m5DocumentedMigrationInserts = map[string]string{}

// m5ExpectedNewTables is the frozen contract's installed table set. A
// divergent 0014 fails with the exact diff so the contract — not this suite —
// gets reconciled.
var m5ExpectedNewTables = []string{
	"message_agent_mentions",
	"agent_deliveries",
	"agent_delivery_claims",
	"agent_delivery_attempts",
	"agent_launches",
	"agent_direct_messages",
}

// m5MigrationFiles returns the sorted migration file names on disk.
func m5MigrationFiles(t *testing.T) []string {
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

// m5PendingMigrations reports whether an M5 upgrade (>0013) is on disk.
func m5PendingMigrations(t *testing.T) bool {
	t.Helper()
	return slices.ContainsFunc(m5MigrationFiles(t), func(name string) bool {
		return name > "0013_activity_mute_epochs.sql"
	})
}

// m5SkipUntilM5Lands is the explicit, loud skip used by every stage that
// structurally requires an 0014+ migration. It never silently passes.
func m5SkipUntilM5Lands(t *testing.T) {
	t.Helper()
	if !m5PendingMigrations(t) {
		t.Skip("no migration newer than 0013 on disk yet; the M4→M5 upgrade stages activate automatically once the delivery worker lands 0014+ (m5-execution-lock.md worker F)")
	}
}

// m5TableColumns captures every M4 table's columns; post-upgrade dumps query
// exactly these, so a dropped/renamed M4 column fails instead of comparing a
// subset.
func m5TableColumns(t *testing.T, q m3Querier) map[string][]string {
	t.Helper()
	out := make(map[string][]string, len(m5M4TableOrder))
	for table := range m5M4TableOrder {
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
			t.Fatalf("M4 table %s is missing from the database", table)
		}
		out[table] = cols
	}
	return out
}

// m5DumpTables renders every M4 table deterministically (m3DumpTables is
// pinned to the M2 table set, so this is the M4 equivalent).
func m5DumpTables(t *testing.T, q m3Querier, cols map[string][]string) map[string]string {
	t.Helper()
	tables := make([]string, 0, len(m5M4TableOrder))
	for table := range m5M4TableOrder {
		tables = append(tables, table)
	}
	sort.Strings(tables)
	out := make(map[string]string, len(tables))
	ctx := context.Background()
	for _, table := range tables {
		query := fmt.Sprintf("SELECT %s FROM %s ORDER BY %s",
			strings.Join(cols[table], ", "), table, m5M4TableOrder[table])
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

func m5RequireSameDump(t *testing.T, label string, before, after map[string]string) {
	t.Helper()
	tables := make([]string, 0, len(before))
	for table := range before {
		tables = append(tables, table)
	}
	sort.Strings(tables)
	for _, table := range tables {
		if before[table] != after[table] {
			t.Errorf("%s: M4 rows of %s changed across the upgrade\n--- before ---\n%s\n--- after ---\n%s",
				label, table, m3Excerpt(before[table]), m3Excerpt(after[table]))
		}
	}
}

// m5RequireColumns pins a new table's column set to the frozen contract.
func m5RequireColumns(t *testing.T, q m3Querier, table string, want []string) {
	t.Helper()
	rows, err := q.QueryContext(context.Background(), "PRAGMA table_info("+table+")")
	if err != nil {
		t.Fatalf("table_info(%s): %v", table, err)
	}
	var got []string
	for rows.Next() {
		var cid int
		var name, typ string
		var notNull, pk int
		var dflt sql.NullString
		if err := rows.Scan(&cid, &name, &typ, &notNull, &dflt, &pk); err != nil {
			rows.Close()
			t.Fatalf("scan table_info(%s): %v", table, err)
		}
		got = append(got, name)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		t.Fatalf("iterate table_info(%s): %v", table, err)
	}
	rows.Close()
	sortedWant := slices.Clone(want)
	sort.Strings(sortedWant)
	sortedGot := slices.Clone(got)
	sort.Strings(sortedGot)
	if len(got) == 0 {
		t.Fatalf("M5 table %s is missing from the upgraded schema (frozen contract set: %v)", table, m5ExpectedNewTables)
	}
	if !slices.Equal(sortedGot, sortedWant) {
		t.Fatalf("table %s columns diverge from the frozen contract docs/m5-delivery-worker-contract.md §1:\n  installed: %v\n  contract:  %v\nreconcile the contract (worker A owns the migration); do not weaken this pin",
			table, sortedGot, sortedWant)
	}
}

type m5Fixture struct {
	path string
	now  int64

	passwords map[string]string

	cols   map[string][]string
	dump   map[string]string
	schema map[string]m3TableSchema
}

// m5BuildLegacyM4 creates a real M4 database: the unchanged 0001–0013 SQL is
// applied verbatim with schema_migrations recording exactly those versions —
// the state the frozen M4 binary's migrate() leaves behind — and a
// representative M4 dataset is seeded with the shapes the real M4 writers
// produce. The 0012 authority triggers fire during seeding exactly as during
// real M4 operation.
func m5BuildLegacyM4(t *testing.T) *m5Fixture {
	t.Helper()

	const dayMs = int64(24 * time.Hour / time.Millisecond)
	f := &m5Fixture{
		path: filepath.Join(t.TempDir(), "raft-m4.sqlite"),
		now:  time.Now().Add(-24 * time.Hour).UnixMilli(),
		passwords: map[string]string{
			m5OwnerUser:  "m5-upgrade-password-owner",
			m5MemberUser: "m5-upgrade-password-member",
		},
	}

	raw := m3OpenRaw(t, f.path, false)
	defer raw.Close()
	ctx := context.Background()

	if _, err := raw.ExecContext(ctx, `CREATE TABLE IF NOT EXISTS schema_migrations (
		version TEXT PRIMARY KEY,
		applied_at INTEGER NOT NULL
	)`); err != nil {
		t.Fatalf("create schema_migrations: %v", err)
	}

	files := m5MigrationFiles(t)
	if !slices.Equal(files[:min(len(m5FrozenM4Migrations), len(files))], m5FrozenM4Migrations) {
		t.Fatalf("the frozen M4 migration prefix changed shape: first files = %v; want %v (0001-0013 are frozen)", files, m5FrozenM4Migrations)
	}
	for _, name := range m5FrozenM4Migrations {
		body, err := os.ReadFile(filepath.Join("migrations", name))
		if err != nil {
			t.Fatalf("read %s: %v", name, err)
		}
		if _, err := raw.ExecContext(ctx, string(body)); err != nil {
			t.Fatalf("apply unchanged %s: %v", name, err)
		}
		if _, err := raw.ExecContext(ctx,
			`INSERT INTO schema_migrations(version, applied_at) VALUES(?, ?)`,
			name, f.now-2*dayMs); err != nil {
			t.Fatalf("record %s: %v", name, err)
		}
	}

	hasher := auth.NewPasswordHasher(8192, 1, 1, 1)
	hashes := make(map[string]string, len(f.passwords))
	for userID, password := range f.passwords {
		h, err := hasher.Hash(password)
		if err != nil {
			t.Fatalf("hash seed password for %s: %v", userID, err)
		}
		hashes[userID] = h
	}
	agentKeyHash, err := hasher.Hash(m5AgentAPIKey)
	if err != nil {
		t.Fatalf("hash seed agent key: %v", err)
	}

	exec := func(query string, args ...any) {
		t.Helper()
		if _, err := raw.ExecContext(ctx, query, args...); err != nil {
			t.Fatalf("seed: %v (query: %.80s)", err, query)
		}
	}

	exec(`INSERT INTO users (id, email, name, display_name, email_verified, password_hash,
			preferred_language, preferred_timezone, created_at, updated_at)
		VALUES (?, ?, ?, ?, 1, ?, 'en', 'UTC', ?, ?)`,
		m5OwnerUser, "owner@m4legacy.test", "m5_owner", "M5 Upgrade Owner", hashes[m5OwnerUser], f.now-9000, f.now)
	exec(`INSERT INTO users (id, email, name, display_name, email_verified, password_hash,
			preferred_language, preferred_timezone, created_at, updated_at)
		VALUES (?, ?, ?, ?, 1, ?, 'zh', 'Asia/Shanghai', ?, ?)`,
		m5MemberUser, "member@m4legacy.test", "m5_member", "M5 Upgrade Member", hashes[m5MemberUser], f.now-8500, f.now)

	exec(`INSERT INTO session_families (id, user_id, revoked_at, revoked_reason, created_at)
		VALUES (?, ?, NULL, NULL, ?)`, m5FamilyOwner, m5OwnerUser, f.now-8000)
	exec(`INSERT INTO sessions (id, user_id, family_id, token_hash, expires_at, created_at) VALUES
		(?, ?, ?, ?, ?, ?),
		(?, ?, ?, ?, ?, ?)`,
		m5SessionOwner, m5OwnerUser, m5FamilyOwner, auth.HashToken(m5RefreshOwner1), f.now+90*dayMs, f.now-7000,
		m5SessionOld, m5OwnerUser, m5FamilyOwner, auth.HashToken(m5RefreshOwner0), f.now+30*dayMs, f.now-7500)
	exec(`INSERT INTO session_token_predecessors
			(token_hash, session_id, user_id, family_id, expires_at, created_at)
		VALUES (?, ?, ?, ?, ?, ?)`,
		auth.HashToken(m5RefreshOwner0), m5SessionOld, m5OwnerUser, m5FamilyOwner, f.now+30*dayMs, f.now-7000)
	ct, iv, tag := m3SealReceipt(t, m5RefreshOwner1)
	exec(`INSERT INTO session_refresh_rotation_receipts
			(id, predecessor_token_hash, predecessor_session_id, user_id, family_id,
			 successor_session_id, attempt_id, installation_id,
			 successor_token_ciphertext, successor_token_iv, successor_token_auth_tag,
			 expires_at, created_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		m5ReceiptID, auth.HashToken(m5RefreshOwner0), m5SessionOld, m5OwnerUser, m5FamilyOwner,
		m5SessionOwner, "attempt-m5-0001", "installation-m5-0001", ct, iv, tag,
		f.now+7*dayMs, f.now-6900)
	exec(`INSERT INTO legal_acceptances
			(id, user_id, terms_version, privacy_version, terms_url, privacy_url,
			 source, ip_hash, user_agent_hash, locale, accepted_at)
		VALUES (?, ?, '2026-05-12', '2026-05-12', 'https://m4legacy.test/terms', 'https://m4legacy.test/privacy',
			'signup', 'ip-hash-m5-1', 'ua-hash-m5-1', 'en', ?)`,
		m5AcceptanceID, m5OwnerUser, f.now-7900)

	exec(`INSERT INTO workspaces (id, name, slug, owner_id, plan, created_at, updated_at)
		VALUES (?, 'M5 Legacy Space', 'm5-legacy-space', ?, 'free', ?, ?)`,
		m5Workspace1, m5OwnerUser, f.now-8000, f.now-1000)
	exec(`INSERT INTO workspace_memberships (workspace_id, user_id, role, joined_at) VALUES
		(?, ?, 'owner', ?),
		(?, ?, 'member', ?)`,
		m5Workspace1, m5OwnerUser, f.now-8000,
		m5Workspace1, m5MemberUser, f.now-7800)
	exec(`INSERT INTO workspace_membership_agreement_audit
			(id, workspace_id, subject_type, subject_id, agreement_id, agreement_version,
			 actor_user_id, source, created_at)
		VALUES (?, ?, 'user', ?, NULL, NULL, ?, 'admin-add', ?)`,
		m5AuditID1, m5Workspace1, m5MemberUser, m5OwnerUser, f.now-7800)
	exec(`INSERT INTO workspace_member_setup (workspace_id, user_id, status, completion_reason, contract_version, handoff_acknowledged_at) VALUES
		(?, ?, 'complete', 'normal', 'onboarding-setup-v2', ?),
		(?, ?, 'not_started', NULL, 'onboarding-setup-v2', NULL)`,
		m5Workspace1, m5OwnerUser, f.now-5000,
		m5Workspace1, m5MemberUser)
	exec(`INSERT INTO workspace_member_preferences (workspace_id, user_id,
			dismissed_add_computer_step_at, sidebar_channel_order, sidebar_channel_sort_mode)
		VALUES (?, ?, ?, ?, 'az')`,
		m5Workspace1, m5OwnerUser, f.now-4000,
		fmt.Sprintf(`["%s","%s"]`, m5ChannelGeneral, m5ChannelAnnounce))
	exec(`INSERT INTO workspace_member_preferences (workspace_id, user_id) VALUES (?, ?)`, m5Workspace1, m5MemberUser)
	exec(`INSERT INTO account_workspace_order (user_id, server_order, version, updated_at)
		VALUES (?, ?, 1, ?)`, m5OwnerUser, fmt.Sprintf(`["%s"]`, m5Workspace1), f.now-900)

	exec(`INSERT INTO channels (id, workspace_id, name, description, type, system_kind, created_at) VALUES
		(?, ?, 'all', 'General channel for all members', 'channel', 'all', ?),
		(?, ?, 'announcement', 'Agent progress announcements', 'channel', 'announcement', ?),
		(?, ?, 'm5-general', 'Upgrade acceptance channel', 'channel', NULL, ?),
		(?, ?, 'm5-private', NULL, 'private', NULL, ?),
		(?, ?, ?, NULL, 'dm', NULL, ?),
		(?, ?, 'thread-m5-original', NULL, 'thread', NULL, ?)`,
		m5ChannelAll, m5Workspace1, f.now-8000,
		m5ChannelAnnounce, m5Workspace1, f.now-8000,
		m5ChannelGeneral, m5Workspace1, f.now-7900,
		m5ChannelPrivate, m5Workspace1, f.now-7900,
		m5ChannelDM, m5Workspace1, fmt.Sprintf("dm-%s-%s", m5OwnerUser, m5MemberUser), f.now-7700,
		m5ChannelThread, m5Workspace1, f.now-7000)
	exec(`UPDATE channels SET parent_message_id = ? WHERE id = ?`, m5MessageOriginal, m5ChannelThread)
	exec(`INSERT INTO channel_humans (channel_id, user_id, role, joined_at) VALUES
		(?, ?, 'member', ?),
		(?, ?, 'member', ?)`,
		m5ChannelGeneral, m5OwnerUser, f.now-7900,
		m5ChannelGeneral, m5MemberUser, f.now-7800)

	exec(`INSERT INTO machines (id, workspace_id, user_id, name, api_key_prefix, runtimes,
			hostname, os, daemon_version, last_heartbeat, last_status, status_changed_at, created_at)
		VALUES (?, ?, ?, 'M5 MacBook', 'sk_machine_m5legacy', '["claude","codex"]',
			'mbp.m5legacy.test', 'darwin 25.5.0', '1.3.0', ?, 'online', ?, ?)`,
		m5Machine1, m5Workspace1, m5OwnerUser, f.now-60000, f.now-60000, f.now-7700)
	exec(`INSERT INTO computers (id, workspace_id, name, attached_by_user_id, machine_id, created_at, last_used_at)
		VALUES (?, ?, 'Cindy MacBook M5', ?, ?, ?, ?)`,
		m5Computer1, m5Workspace1, m5OwnerUser, m5Machine1, f.now-7600, f.now-2000)

	exec(`INSERT INTO agents (id, workspace_id, name, display_name, description, status, runtime,
			machine_id, creator_type, creator_id, created_at, updated_at)
		VALUES (?, ?, 'm5-relay', 'M5 Relay', 'upgrade acceptance agent', 'active', 'claude',
			?, 'user', ?, ?, ?)`,
		m5Agent1, m5Workspace1, m5Machine1, m5OwnerUser, f.now-7500, f.now-3000)
	exec(`INSERT INTO agent_members (workspace_id, agent_id, role, joined_at, updated_at)
		VALUES (?, ?, 'admin', ?, ?)`, m5Workspace1, m5Agent1, f.now-7500, f.now-3000)
	exec(`INSERT INTO agent_credentials (id, agent_id, api_key_hash, api_key_prefix, name, scopes, created_by_user_id, created_at)
		VALUES (?, ?, ?, ?, 'M5 seed credential', '["agent:read"]', ?, ?)`,
		m5CredID, m5Agent1, agentKeyHash, "sk_agent_m5_", m5OwnerUser, f.now-7400)

	exec(`INSERT INTO messages (id, workspace_id, channel_id, sender_type, sender_id, content,
			message_type, random_id, request_digest, thread_id, created_at)
		VALUES (?, ?, ?, 'user', ?, 'message written by the real M4 binary shape', 'chat', 'm5-original', 'digest-m5-original', NULL, ?),
		       (?, ?, ?, 'user', ?, 'thread reply in the M4 shape', 'chat', 'm5-thread', 'digest-m5-thread', ?, ?),
		       (?, ?, ?, 'user', ?, 'DM in the M4 shape', 'chat', 'm5-dm', 'digest-m5-dm', NULL, ?)`,
		m5MessageOriginal, m5Workspace1, m5ChannelGeneral, m5OwnerUser, f.now-6900,
		m5MessageThread, m5Workspace1, m5ChannelThread, m5MemberUser, m5ChannelThread, f.now-6800,
		m5MessageDM, m5Workspace1, m5ChannelDM, m5OwnerUser, f.now-6700)
	exec(`INSERT INTO message_mentions (message_id, user_id, workspace_id)
		VALUES (?, ?, ?)`, m5MessageOriginal, m5MemberUser, m5Workspace1)
	exec(`INSERT INTO message_reactions (message_id, user_id, emoji, created_at) VALUES
		(?, ?, '👍', ?),
		(?, ?, '👍', ?)`,
		m5MessageOriginal, m5OwnerUser, f.now-6600,
		m5MessageOriginal, m5MemberUser, f.now-6500)
	exec(`INSERT INTO message_reaction_discussion_versions (message_id, emoji, version, updated_at)
		VALUES (?, '👍', 2, ?)`, m5MessageOriginal, f.now-6500)
	exec(`INSERT INTO message_reaction_viewer_versions (message_id, user_id, version, updated_at) VALUES
		(?, ?, 1, ?),
		(?, ?, 1, ?)`,
		m5MessageOriginal, m5OwnerUser, f.now-6600,
		m5MessageOriginal, m5MemberUser, f.now-6500)
	exec(`INSERT INTO direct_messages (workspace_id, user_low, user_high, channel_id)
		VALUES (?, ?, ?, ?)`, m5Workspace1, m5OwnerUser, m5MemberUser, m5ChannelDM)
	exec(`INSERT INTO thread_follows (workspace_id, user_id, thread_channel_id, parent_message_id, followed_at)
		VALUES (?, ?, ?, ?, ?)`, m5Workspace1, m5MemberUser, m5ChannelThread, m5MessageOriginal, f.now-6700)
	exec(`INSERT INTO realtime_publications (workspace_id, object_type, object_id, event_type, revision,
			subject_user_id, scope_id, created_at, published_at, attempts, next_attempt_at)
		VALUES (?, 'message', ?, 'message.created', 1, '', ?, ?, NULL, 0, 0),
		       (?, 'read_state', ?, 'read_state.updated', 1, ?, ?, ?, ?, 1, ?)`,
		m5Workspace1, m5MessageOriginal, m5ChannelGeneral, f.now-6900,
		m5Workspace1, m5ChannelGeneral, m5MemberUser, m5ChannelGeneral, f.now-6400, f.now-6300, f.now-6200)

	exec(`INSERT INTO user_channel_read_states (workspace_id, user_id, channel_id, last_read_seq, read_state_version, updated_at)
		VALUES (?, ?, ?, 1, 1, ?)`, m5Workspace1, m5MemberUser, m5ChannelGeneral, f.now-6000)
	exec(`INSERT INTO user_channel_done_states (workspace_id, user_id, channel_id, done_through_activity_seq, done_at, active_override, revision, updated_at)
		VALUES (?, ?, ?, 0, NULL, 0, 1, ?)`, m5Workspace1, m5MemberUser, m5ChannelGeneral, f.now-6000)
	exec(`INSERT INTO user_mention_suppressions (workspace_id, user_id, target_kind, channel_id, done_through_seq, done_at, updated_at)
		VALUES (?, ?, 'channel', ?, 1, ?, ?)`, m5Workspace1, m5MemberUser, m5ChannelGeneral, f.now-5900, f.now-5900)
	exec(`INSERT INTO user_channel_mute_states (workspace_id, user_id, channel_id, activity_muted, mute_from_seq, prefs_version, created_at, updated_at)
		VALUES (?, ?, ?, 1, 1, 1, ?, ?)`, m5Workspace1, m5MemberUser, m5ChannelGeneral, f.now-5800, f.now-5800)
	exec(`INSERT INTO user_channel_display_prefs (workspace_id, user_id, channel_id, collapse_long_messages, prefs_version, created_at, updated_at)
		VALUES (?, ?, ?, 0, 1, ?, ?)`, m5Workspace1, m5MemberUser, m5ChannelGeneral, f.now-5700, f.now-5700)
	exec(`INSERT INTO user_channel_mute_epochs (workspace_id, user_id, channel_id, epoch_version, mute_from_seq, suppressed_through_seq, muted_at, unmuted_at) VALUES
		(?, ?, ?, 0, 0, NULL, ?, NULL),
		(?, ?, ?, 1, 0, 0, ?, ?)`,
		m5Workspace1, m5MemberUser, m5ChannelAll, f.now-8000,
		m5Workspace1, m5MemberUser, m5ChannelAnnounce, f.now-8000, f.now-7900)

	exec(`INSERT INTO activity_principal_authorities (workspace_id, principal_id, row_version, updated_at)
		VALUES (?, ?, 1, ?)`, m5Workspace1, m5OwnerUser, f.now-6000)
	exec(`INSERT INTO activity_scopes (workspace_id, principal_id, filter, window_id, window_size, epoch, watermark, updated_at)
		VALUES (?, ?, 'all', 'main', 100, 1, 1, ?)`, m5Workspace1, m5OwnerUser, f.now-6000)
	exec(`INSERT INTO activity_row_authorities (workspace_id, principal_id, row_id, last_version, active, updated_at)
		VALUES (?, ?, ?, 1, 1, ?)`, m5Workspace1, m5OwnerUser, fmt.Sprintf("mention:%s", m5MessageOriginal), f.now-6000)
	exec(`INSERT INTO activity_rows (workspace_id, principal_id, filter, window_id, row_id, row_version, active, payload, updated_at)
		VALUES (?, ?, 'all', 'main', ?, 1, 1, ?, ?)`,
		m5Workspace1, m5OwnerUser, fmt.Sprintf("mention:%s", m5MessageOriginal), `{"kind":"mention"}`, f.now-6000)
	exec(`INSERT INTO activity_changes (workspace_id, principal_id, filter, window_id, seq, row_id, row_version, kind, payload, created_at)
		VALUES (?, ?, 'all', 'main', 1, ?, 1, 'upsert', ?, ?)`,
		m5Workspace1, m5OwnerUser, fmt.Sprintf("mention:%s", m5MessageOriginal), `{"kind":"mention"}`, f.now-6000)

	for table, want := range map[string]int{
		"users": 2, "session_families": 1, "sessions": 2,
		"session_token_predecessors": 1, "session_refresh_rotation_receipts": 1,
		"legal_acceptances": 1, "workspaces": 1, "workspace_memberships": 2,
		"workspace_membership_agreement_audit": 1, "channels": 6, "channel_humans": 2,
		"account_workspace_order": 1, "workspace_member_setup": 2, "machines": 1,
		"computers": 1, "agents": 1, "agent_members": 1, "agent_credentials": 1,
		"workspace_member_preferences": 2, "messages": 3, "message_mentions": 1,
		"message_reactions": 2, "message_reaction_discussion_versions": 1,
		"message_reaction_viewer_versions": 2, "direct_messages": 1, "thread_follows": 1,
		"realtime_publications": 2, "user_channel_read_states": 1,
		"user_channel_done_states": 1, "user_mention_suppressions": 1,
		"user_channel_mute_states": 1, "user_channel_display_prefs": 1,
		"user_channel_mute_epochs": 2, "activity_principal_authorities": 1,
		"activity_scopes": 1, "activity_row_authorities": 1, "activity_rows": 1,
		"activity_changes": 1, "authority_clock": 1,
	} {
		var got int
		if err := raw.QueryRowContext(ctx, `SELECT COUNT(*) FROM `+table).Scan(&got); err != nil || got != want {
			t.Fatalf("seed sanity: %s count = %d (err %v); want %d", table, got, err, want)
		}
	}

	f.cols = m5TableColumns(t, raw)
	f.dump = m5DumpTables(t, raw, f.cols)
	m5Tables := make([]string, 0, len(m5M4TableOrder))
	for name := range m5M4TableOrder {
		m5Tables = append(m5Tables, name)
	}
	sort.Strings(m5Tables)
	f.schema = m3CaptureSchema(t, raw, m5Tables)
	return f
}

// TestM5FrozenM4ChainIsAnUntouchedPrefix is ALWAYS active (no 0014 needed):
// the frozen 0001–0013 chain must remain exactly the sorted prefix of the
// migrations directory, and everything after it must sort strictly after the
// frozen tail. Renumbering or inserting into the middle of the frozen chain
// fails here even before any M5 migration exists.
func TestM5FrozenM4ChainIsAnUntouchedPrefix(t *testing.T) {
	files := m5MigrationFiles(t)
	if len(files) < len(m5FrozenM4Migrations) {
		t.Fatalf("migrations directory lost frozen files: %v", files)
	}
	if !slices.Equal(files[:len(m5FrozenM4Migrations)], m5FrozenM4Migrations) {
		t.Fatalf("frozen M4 chain is no longer the sorted prefix:\n  got  %v\n  want %v", files[:len(m5FrozenM4Migrations)], m5FrozenM4Migrations)
	}
	for _, name := range files[len(m5FrozenM4Migrations):] {
		if name <= m5FrozenM4Migrations[len(m5FrozenM4Migrations)-1] {
			t.Fatalf("migration %s sorts at or before the frozen tail but sits after it in the directory", name)
		}
	}
}

// TestM5UpgradePreservesEveryM4RowAndColumn upgrades a fully seeded M4
// database in place through store.Open and verifies every M4 fact survives.
func TestM5UpgradePreservesEveryM4RowAndColumn(t *testing.T) {
	m5SkipUntilM5Lands(t)
	f := m5BuildLegacyM4(t)

	upgraded, err := store.Open(f.path)
	if err != nil {
		t.Fatalf("db.Open must upgrade the M4 database in place: %v", err)
	}
	defer upgraded.Close()

	m3RequireSchemaVersions(t, upgraded, m5MigrationFiles(t))
	m5RequireSameDump(t, "in-place upgrade", f.dump, m5DumpTables(t, upgraded, f.cols))

	hasher := auth.NewPasswordHasher(8192, 1, 1, 1)
	for userID, password := range f.passwords {
		var stored string
		if err := upgraded.QueryRow(`SELECT password_hash FROM users WHERE id = ?`, userID).Scan(&stored); err != nil {
			t.Errorf("user %s lost across upgrade: %v", userID, err)
			continue
		}
		if !hasher.Verify(password, stored) {
			t.Errorf("stored password hash for user %s no longer verifies against the M4 secret", userID)
		}
	}

	var sid, uid, fam string
	if err := upgraded.QueryRow(
		`SELECT id, user_id, family_id FROM sessions WHERE token_hash = ?`,
		auth.HashToken(m5RefreshOwner1)).Scan(&sid, &uid, &fam); err != nil || sid != m5SessionOwner || uid != m5OwnerUser || fam != m5FamilyOwner {
		t.Errorf("the M4 refresh token no longer resolves after upgrade: got %s/%s/%s (err %v); want %s/%s/%s",
			sid, uid, fam, err, m5SessionOwner, m5OwnerUser, m5FamilyOwner)
	}

	// The seq/idempotency facts are untouched: same id per (sender, randomId)
	// and monotonic seq allocation continues from the migrated rows.
	var id string
	var seq int64
	if err := upgraded.QueryRow(
		`SELECT id FROM messages WHERE sender_type='user' AND sender_id = ? AND random_id = 'm5-original'`,
		m5OwnerUser).Scan(&id); err != nil || id != m5MessageOriginal {
		t.Errorf("idempotency lookup (sender, random_id) -> id changed: got %s (err %v); want %s", id, err, m5MessageOriginal)
	}
	if err := upgraded.QueryRow(`SELECT MAX(seq) FROM messages`).Scan(&seq); err != nil || seq != 3 {
		t.Fatalf("message seq allocation changed: MAX(seq)=%d (err %v); want 3", seq, err)
	}
	var frontier int64
	if err := upgraded.QueryRow(
		`SELECT last_read_seq FROM user_channel_read_states WHERE workspace_id = ? AND user_id = ? AND channel_id = ?`,
		m5Workspace1, m5MemberUser, m5ChannelGeneral).Scan(&frontier); err != nil || frontier != 1 {
		t.Errorf("read frontier changed across upgrade: got %d (err %v); want 1", frontier, err)
	}

	m3RequireIntegrity(t, upgraded)
}

// TestM5UpgradeChangesAreAdditiveAndDocumented diffs the schema across the
// upgrade: no M4 table/column/FK/index dropped or redefined, no values
// written into pre-existing rows outside the whitelists, and the new tables
// start empty (0014 is declared purely additive).
func TestM5UpgradeChangesAreAdditiveAndDocumented(t *testing.T) {
	m5SkipUntilM5Lands(t)
	f := m5BuildLegacyM4(t)

	upgraded, err := store.Open(f.path)
	if err != nil {
		t.Fatalf("db.Open must upgrade the M4 database in place: %v", err)
	}
	defer upgraded.Close()

	preTables := make([]string, 0, len(m5M4TableOrder))
	for name := range m5M4TableOrder {
		preTables = append(preTables, name)
	}
	sort.Strings(preTables)

	postTables := m3AllTables(t, upgraded)
	postSet := make(map[string]bool, len(postTables))
	for _, name := range postTables {
		postSet[name] = true
	}
	for _, name := range preTables {
		if !postSet[name] {
			t.Errorf("M4 table %s was dropped by the upgrade; M4 tables are frozen", name)
		}
	}
	preSet := make(map[string]bool, len(preTables))
	for _, name := range preTables {
		preSet[name] = true
	}
	for _, name := range postTables {
		if preSet[name] {
			continue
		}
		var count int
		if err := upgraded.QueryRow(`SELECT COUNT(*) FROM ` + name).Scan(&count); err != nil {
			t.Fatalf("count rows of new table %s: %v", name, err)
		}
		if count == 0 {
			continue
		}
		if reason, ok := m5DocumentedMigrationInserts[name]; ok {
			t.Logf("new table %s carries %d documented migration rows: %s", name, count, reason)
			continue
		}
		t.Errorf("the migration inserted %d rows into new table %s; register the backfill in m5DocumentedMigrationInserts with a contract-doc reference or make the migration create the table empty", count, name)
	}

	postSchema := m3CaptureSchema(t, upgraded, preTables)
	for _, table := range preTables {
		pre, post := f.schema[table], postSchema[table]
		for col, def := range pre.Columns {
			got, ok := post.Columns[col]
			if !ok {
				t.Errorf("%s.%s was dropped by the upgrade; M4 columns are frozen", table, col)
				continue
			}
			if !def.equals(got) {
				t.Errorf("%s.%s was redefined across the upgrade: got %+v; want %+v", table, col, got, def)
			}
		}
		preFKs := make(map[string]bool, len(pre.FKs))
		for _, fk := range pre.FKs {
			preFKs[fk] = true
		}
		postFKs := make(map[string]bool, len(post.FKs))
		for _, fk := range post.FKs {
			postFKs[fk] = true
		}
		for fk := range preFKs {
			if !postFKs[fk] {
				t.Errorf("%s lost the foreign key %s across the upgrade (a rebuild must recreate every M4 constraint)", table, fk)
			}
		}
		for name, def := range pre.Indexes {
			got, ok := post.Indexes[name]
			if !ok {
				t.Errorf("%s lost index %s (columns %v) across the upgrade", table, name, def.Columns)
				continue
			}
			if got.Unique != def.Unique || got.Origin != def.Origin || !slices.Equal(got.Columns, def.Columns) {
				t.Errorf("index %s on %s changed across the upgrade: got %+v; want %+v", name, table, got, def)
			}
		}
		for col, def := range post.Columns {
			if _, old := pre.Columns[col]; old {
				continue
			}
			if reason, ok := m5DocumentedMigrationBackfills[table][col]; ok {
				t.Logf("%s.%s carries a documented migration backfill: %s", table, col, reason)
				continue
			}
			if !def.Default.Valid {
				var offending int
				if err := upgraded.QueryRow(
					fmt.Sprintf("SELECT COUNT(*) FROM %s WHERE %s IS NOT NULL", table, col)).Scan(&offending); err != nil {
					t.Fatalf("audit new nullable column %s.%s: %v", table, col, err)
				}
				if offending > 0 {
					t.Errorf("migration wrote %d non-NULL values into new nullable column %s.%s of pre-existing rows; register the backfill in m5DocumentedMigrationBackfills", offending, table, col)
				}
				continue
			}
			var offending int
			if err := upgraded.QueryRow(
				fmt.Sprintf("SELECT COUNT(*) FROM %s WHERE %s IS NOT %s", table, col, def.Default.String)).Scan(&offending); err != nil {
				t.Fatalf("audit new column %s.%s against its default: %v", table, col, err)
			}
			if offending > 0 {
				t.Errorf("migration wrote %d non-default values into new column %s.%s of pre-existing rows", offending, table, col)
			}
		}
	}

	m3RequireIntegrity(t, upgraded)
}

// m5SeedPendingDeliveries writes unconfirmed delivery facts exactly as the
// delivery Store does (docs/m5-delivery-worker-contract.md §1): one managed
// pending intent with its in-flight occurrence, and one external claim lease
// with a leased intent + occurrence bound to it.
func m5SeedPendingDeliveries(t *testing.T, q *sql.DB) {
	t.Helper()
	ctx := context.Background()
	exec := func(query string, args ...any) {
		t.Helper()
		if _, err := q.ExecContext(ctx, query, args...); err != nil {
			t.Fatalf("seed delivery: %v (query: %.80s)", err, query)
		}
	}
	// Typed agent mention for the original message (message-domain table,
	// written here as the messaging worker's send transaction would).
	exec(`INSERT INTO message_agent_mentions (message_id, workspace_id, agent_id, handle_at_send, created_at)
		VALUES (?, ?, ?, '@m5-relay', ?)`, m5MessageOriginal, m5Workspace1, m5Agent1, m5Now+1000)

	// Managed pending intent + in-flight occurrence (full identity snapshot).
	exec(`INSERT INTO agent_deliveries (id, delivery_order, workspace_id, agent_id, source_kind, source_id,
			message_id, conversation_id, scheduling_state, retry_count, next_attempt_at, revision, created_at, updated_at)
		VALUES (?, 1, ?, ?, 'message', ?, ?, ?, 'pending', 0, ?, 1, ?, ?)`,
		m5Delivery1, m5Workspace1, m5Agent1, m5MessageOriginal, m5MessageOriginal, m5ChannelGeneral,
		m5Now+5000, m5Now+1000, m5Now+1000)
	exec(`INSERT INTO agent_delivery_attempts (occurrence_id, delivery_id, attempt_number, workspace_id, agent_id,
			message_id, machine_id_snapshot, launch_id_snapshot, session_id_snapshot, transport_kind,
			retry_count, dispatched_at, state, revision, created_at, updated_at)
		VALUES (?, ?, 1, ?, ?, ?, 'machine-m5-1', 'launch-m5-1', 'session-m5-1', 'managed_wire',
			0, ?, 'in_flight', 1, ?, ?)`,
		m5Occurrence1, m5Delivery1, m5Workspace1, m5Agent1, m5MessageOriginal, m5Now+2000, m5Now+2000, m5Now+2000)

	// External claim lease with a leased intent + claim-bound occurrence.
	exec(`INSERT INTO agent_delivery_claims (id, workspace_id, agent_id, claim_digest, event_count, lease_expires_at, created_at)
		VALUES (?, ?, ?, ?, 1, ?, ?)`,
		m5ClaimID, m5Workspace1, m5Agent1, strings.Repeat("ab", 32), m5Now+30000, m5Now+1000)
	exec(`INSERT INTO agent_deliveries (id, delivery_order, workspace_id, agent_id, source_kind, source_id,
			message_id, conversation_id, scheduling_state, retry_count, next_attempt_at,
			lease_expires_at, revision, created_at, updated_at)
		VALUES (?, 2, ?, ?, 'message', ?, ?, ?, 'leased', 1, ?, ?, 1, ?, ?)`,
		m5Delivery2, m5Workspace1, m5Agent1, m5MessageThread, m5MessageThread, m5ChannelThread,
		m5Now+8000, m5Now+30000, m5Now+1500, m5Now+1500)
	exec(`INSERT INTO agent_delivery_attempts (occurrence_id, delivery_id, attempt_number, workspace_id, agent_id,
			message_id, transport_kind, claim_id, retry_count, state, revision, created_at, updated_at)
		VALUES (?, ?, 1, ?, ?, ?, 'external_claim', ?, 1, 'in_flight', 1, ?, ?)`,
		m5Occurrence2, m5Delivery2, m5Workspace1, m5Agent1, m5MessageThread, m5ClaimID, m5Now+1500, m5Now+1500)
}

// m5Now pins the delivery-seed clock (after the fixture's M4-era timestamps).
const m5Now = int64(2000000000000)

var m5DeliveryTables = []string{
	"message_agent_mentions",
	"agent_deliveries",
	"agent_delivery_claims",
	"agent_delivery_attempts",
}

var m5DeliveryOrder = map[string]string{
	"message_agent_mentions":  "message_id, agent_id",
	"agent_deliveries":        "delivery_order",
	"agent_delivery_claims":   "id",
	"agent_delivery_attempts": "occurrence_id",
}

func m5DumpDeliveryTables(t *testing.T, q m3Querier) map[string]string {
	t.Helper()
	out := map[string]string{}
	for _, table := range m5DeliveryTables {
		rows, err := q.QueryContext(context.Background(),
			fmt.Sprintf("SELECT * FROM %s ORDER BY %s", table, m5DeliveryOrder[table]))
		if err != nil {
			t.Fatalf("dump %s: %v", table, err)
		}
		cols, err := rows.Columns()
		if err != nil {
			rows.Close()
			t.Fatalf("columns %s: %v", table, err)
		}
		var sb strings.Builder
		vals := make([]any, len(cols))
		dest := make([]any, len(vals))
		for i := range vals {
			dest[i] = &vals[i]
		}
		for rows.Next() {
			if err := rows.Scan(dest...); err != nil {
				rows.Close()
				t.Fatalf("scan %s: %v", table, err)
			}
			for i, col := range cols {
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

// TestM5UnconfirmedDeliveryIntentsSurviveReopen is the persistence-layer
// half of phase-5 §12's "verify unconfirmed delivery restart recovery": with
// the schema frozen but the HTTP surfaces still landing, it seeds pending
// intents exactly as the delivery Store writes them, closes the database,
// reopens through store.Open (a server restart) and requires every fact
// byte-identical — state, retry budget, next attempt, identity snapshots and
// the still-unacknowledged receipts. It also proves post-restart writes
// continue (delivery_order advances) and the unique constraints still hold.
func TestM5UnconfirmedDeliveryIntentsSurviveReopen(t *testing.T) {
	m5SkipUntilM5Lands(t)
	f := m5BuildLegacyM4(t)

	upgraded, err := store.Open(f.path)
	if err != nil {
		t.Fatalf("upgrade: %v", err)
	}

	// The installed M5 schema must match the frozen contract tables; a
	// divergence fails with the exact diff (reconcile the contract, never
	// silently accept a different shape).
	m5RequireColumns(t, upgraded, "agent_deliveries", []string{
		"id", "delivery_order", "workspace_id", "agent_id", "source_kind", "source_id",
		"message_id", "conversation_id", "scheduling_state", "retry_count", "next_attempt_at",
		"lease_expires_at", "last_error_code", "acknowledged_at", "revision", "created_at", "updated_at",
	})
	m5RequireColumns(t, upgraded, "agent_delivery_attempts", []string{
		"occurrence_id", "delivery_id", "attempt_number", "workspace_id", "agent_id", "message_id",
		"machine_id_snapshot", "launch_id_snapshot", "session_id_snapshot", "transport_kind",
		"claim_id", "lease_expires_at", "retry_count", "dispatched_at", "received_at", "pending_at",
		"drained_reported_at", "acked_at", "state", "terminal_code", "revision", "created_at", "updated_at",
	})
	m5RequireColumns(t, upgraded, "agent_delivery_claims", []string{
		"id", "workspace_id", "agent_id", "claim_digest", "event_count", "removed_count",
		"lease_expires_at", "acked_at", "created_at",
	})
	m5RequireColumns(t, upgraded, "message_agent_mentions", []string{
		"message_id", "workspace_id", "agent_id", "handle_at_send", "created_at",
	})

	m5SeedPendingDeliveries(t, upgraded)
	before := m5DumpDeliveryTables(t, upgraded)
	if err := upgraded.Close(); err != nil {
		t.Fatalf("close after seeding: %v", err)
	}

	// Server restart: reopen through the same Open path the server uses.
	reopened, err := store.Open(f.path)
	if err != nil {
		t.Fatalf("reopen after restart: %v", err)
	}
	defer reopened.Close()

	after := m5DumpDeliveryTables(t, reopened)
	for _, table := range m5DeliveryTables {
		if before[table] != after[table] {
			t.Errorf("unconfirmed delivery facts in %s did not survive the restart\n--- before ---\n%s\n--- after ---\n%s",
				table, m3Excerpt(before[table]), m3Excerpt(after[table]))
		}
	}

	// The two intents are still exactly as seeded: pending stays pending with
	// its retry budget and next attempt; the occurrence is still in flight
	// and unacknowledged. A restart must not fabricate receipts.
	var state1, state2 string
	var retry1, next1 int64
	var ack1 sql.NullInt64
	if err := reopened.QueryRow(`SELECT scheduling_state, retry_count, next_attempt_at, acknowledged_at
			FROM agent_deliveries WHERE id = ?`, m5Delivery1).Scan(&state1, &retry1, &next1, &ack1); err != nil {
		t.Fatalf("pending intent lost after restart: %v", err)
	}
	if state1 != "pending" || retry1 != 0 || next1 != m5Now+5000 || ack1.Valid {
		t.Errorf("pending intent changed across restart: state=%q retry=%d next=%d ack=%v; want pending/0/%d/NULL",
			state1, retry1, next1, ack1, m5Now+5000)
	}
	if err := reopened.QueryRow(`SELECT scheduling_state FROM agent_deliveries WHERE id = ?`, m5Delivery2).Scan(&state2); err != nil || state2 != "leased" {
		t.Errorf("leased intent changed across restart: state=%q (err %v); want leased", state2, err)
	}
	var attemptState string
	var attemptAck sql.NullInt64
	if err := reopened.QueryRow(`SELECT state, acked_at FROM agent_delivery_attempts WHERE occurrence_id = ?`, m5Occurrence1).Scan(&attemptState, &attemptAck); err != nil || attemptState != "in_flight" || attemptAck.Valid {
		t.Errorf("occurrence changed across restart: state=%q ack=%v (err %v); want in_flight/NULL", attemptState, attemptAck, err)
	}

	// Post-restart writes still work and the durable ordering advances.
	if _, err := reopened.Exec(`INSERT INTO agent_deliveries (id, delivery_order, workspace_id, agent_id, source_kind, source_id,
			message_id, conversation_id, scheduling_state, retry_count, next_attempt_at, revision, created_at, updated_at)
		VALUES ('aae50000-0000-4000-8000-000000000003', 3, ?, ?, 'message', ?, ?, ?, 'pending', 0, ?, 1, ?, ?)`,
		m5Workspace1, m5Agent1, m5MessageDM, m5MessageDM, m5ChannelDM, m5Now+9000, m5Now+4000, m5Now+4000); err != nil {
		t.Fatalf("post-restart delivery write: %v", err)
	}
	// The unique constraints installed by 0014 still bite after restart.
	if _, err := reopened.Exec(`INSERT INTO agent_deliveries (id, delivery_order, workspace_id, agent_id, source_kind, source_id,
			message_id, conversation_id, scheduling_state, revision, created_at, updated_at)
		VALUES ('aae50000-0000-4000-8000-000000000004', 1, ?, ?, 'message', ?, ?, ?, 'pending', 1, ?, ?)`,
		m5Workspace1, m5Agent1, m5MessageDM, m5MessageDM, m5ChannelDM, m5Now+4000, m5Now+4000); err == nil {
		t.Fatal("duplicate delivery_order must still be rejected after restart")
	}
	m3RequireIntegrity(t, reopened)
}

// TestM5UpgradeFailureRollsBackAndRetryUpgrades injects a failure into the
// migration recording step, asserts db.Open fails closed with the M4 data
// byte-identical and the failed migration unrecorded, then clears the fault
// and verifies a retry upgrades cleanly.
func TestM5UpgradeFailureRollsBackAndRetryUpgrades(t *testing.T) {
	m5SkipUntilM5Lands(t)
	f := m5BuildLegacyM4(t)

	raw := m3OpenRaw(t, f.path, false)
	if _, err := raw.Exec(`
		CREATE TRIGGER m5_test_block_m5_migrations
		BEFORE INSERT ON schema_migrations
		FOR EACH ROW
		WHEN NEW.version >= '0014'
		BEGIN
			SELECT RAISE(ABORT, 'm5 test: injected migration failure');
		END`); err != nil {
		t.Fatalf("install failure-injection trigger: %v", err)
	}
	raw.Close()

	if _, err := store.Open(f.path); err == nil {
		t.Fatal("db.Open must fail when a migration fails, not report a half-upgraded database as ready")
	}

	raw = m3OpenRaw(t, f.path, false)
	if got := m3SchemaVersions(t, raw); !slices.Equal(got, m5FrozenM4Migrations) {
		t.Fatalf("a failed migration must not be recorded; schema_migrations = %v; want %v", got, m5FrozenM4Migrations)
	}
	m5RequireSameDump(t, "rolled-back upgrade", f.dump, m5DumpTables(t, raw, f.cols))
	m3RequireIntegrity(t, raw)
	if _, err := raw.Exec(`DROP TRIGGER m5_test_block_m5_migrations`); err != nil {
		t.Fatalf("drop failure-injection trigger: %v", err)
	}
	raw.Close()

	upgraded, err := store.Open(f.path)
	if err != nil {
		t.Fatalf("retry upgrade after clearing the fault: %v", err)
	}
	defer upgraded.Close()
	m3RequireSchemaVersions(t, upgraded, m5MigrationFiles(t))
	m5RequireSameDump(t, "retry upgrade", f.dump, m5DumpTables(t, upgraded, f.cols))
	m3RequireIntegrity(t, upgraded)
}

// TestM5RepeatedOpenIsIdempotent upgrades once, then opens again: the second
// Open must record nothing new and change nothing (including any delivery
// rows written between the two opens).
func TestM5RepeatedOpenIsIdempotent(t *testing.T) {
	m5SkipUntilM5Lands(t)
	f := m5BuildLegacyM4(t)

	first, err := store.Open(f.path)
	if err != nil {
		t.Fatalf("first open: %v", err)
	}
	m5SeedPendingDeliveries(t, first)
	versions1 := m3SchemaVersions(t, first)
	dump1 := m5DumpTables(t, first, f.cols)
	deliveries1 := m5DumpDeliveryTables(t, first)
	first.Close()

	second, err := store.Open(f.path)
	if err != nil {
		t.Fatalf("second open: %v", err)
	}
	defer second.Close()
	m3RequireSchemaVersions(t, second, m5MigrationFiles(t))
	if got := m3SchemaVersions(t, second); !slices.Equal(got, versions1) {
		t.Fatalf("repeated upgrade re-recorded migrations: %v; want %v", got, versions1)
	}
	m5RequireSameDump(t, "repeated open", dump1, m5DumpTables(t, second, f.cols))
	for table, before := range deliveries1 {
		if after := m5DumpDeliveryTables(t, second)[table]; before != after {
			t.Errorf("repeated open changed delivery table %s\n--- before ---\n%s\n--- after ---\n%s", table, m3Excerpt(before), m3Excerpt(after))
		}
	}
	m3RequireIntegrity(t, second)
}
