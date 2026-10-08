// M2→M3 database upgrade review suite.
//
// Ownership note: this file belongs to the M3 DATABASE UPGRADE reviewer; the
// frozen M1/M2 migrations 0001–0005 and every M3 migration (0006+) belong to
// the implementation workers and are never edited here. The suite builds a
// REAL M2 database by applying the unchanged 0001–0005 SQL verbatim to a
// temporary SQLite file (schema_migrations records exactly those five
// versions, the state an M2 binary's migrate() leaves behind), seeds every M2
// table with the data M2 could hold — accounts with verifiable password
// hashes, live and revoked session families, rotated refresh lineage with a
// sealed rotation receipt, one-shot email tokens, workspaces with an owner
// AND a co-owner plus admin/member/guest roles, per-member setup state,
// preferences, switcher order, system channels in both opener-policy shapes,
// the M2-era machines/computers/agents directories — and upgrades in place
// through store.Open, asserting:
//
//   - every row and column of every M2 table is byte-identical after the
//     upgrade (deterministic full-table dumps);
//   - passwords still verify and refresh/one-shot tokens still resolve;
//   - schema changes are strictly additive: no dropped/redefined columns,
//     foreign keys or indexes; values a migration writes into pre-existing
//     rows or into brand-new tables must be registered in the documented
//     change whitelists below with a contract-doc reference;
//   - the upgrade invents nothing: legacy machines/computers gain no
//     credentials, setup statuses are untouched, system channels and
//     rosters are untouched;
//   - a failed migration rolls back to the byte-identical M2 state and a
//     retry upgrades cleanly; repeated and concurrent upgrades record every
//     migration exactly once; an Open racing a held write lock leaves no
//     partially-applied state;
//   - M2's corrected default membership role and the key uniqueness and
//     foreign-key constraints survive the upgrade.
//
// Assertions that need the M3 migrations (>=0006) skip with an explicit
// message until those files land, so this file passes against the M2-only
// tree and tightens automatically afterwards.
package db_test

import (
	"context"
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"database/sql"
	"encoding/base64"
	"fmt"
	"io"
	"net/url"
	"os"
	"path/filepath"
	"slices"
	"sort"
	"strings"
	"sync"
	"testing"
	"time"

	"raft.local/server-go/internal/auth"
	store "raft.local/server-go/internal/platform/db"
)

// ---------------------------------------------------------------------------
// Documented-change whitelists.
//
// The upgrade review bar is "every old column and row preserved; only
// intentional migration changes allowed and documented". Purely additive
// schema changes (new nullable columns, new defaults, new tables, new
// indexes/foreign keys) pass without registration. The two maps below are the
// ONLY escape hatches, each entry naming the contract document that justifies
// the change. Anything else that rewrites M2 state fails
// TestM3UpgradeChangesAreAdditiveAndDocumented with the exact diff.
// ---------------------------------------------------------------------------

// m3DocumentedMigrationBackfills registers (table -> column -> justification)
// where a migration may write a NON-default value into a new column of
// PRE-EXISTING M2 rows. Old rows must otherwise read NULL (nullable column)
// or exactly the declared default.
var m3DocumentedMigrationBackfills = map[string]map[string]string{
	// 0008_agent_identity.sql backfills the lifecycle "since" stamp for
	// pre-existing agent rows from the row's own creation clock (the
	// migration's own comment documents the rationale: a lifecycle transition
	// always has a since stamp; the honest equivalent for legacy rows is
	// created_at, derived from existing row data — no new fact invented).
	// Reviewer note: register the same rationale in docs/m3-agent-contract.md
	// once that contract is published.
	"agents": {"status_changed_at": "0008_agent_identity.sql §1: UPDATE agents SET status_changed_at = created_at"},
}

// m3DocumentedMigrationInserts registers (new table -> justification) for
// rows a migration itself inserts into a BRAND-NEW table while upgrading
// (backfills). New tables must otherwise come out of the migration empty.
var m3DocumentedMigrationInserts = map[string]string{
	// Example shape once needed:
	// "channel_agents": "docs/m3-channel-contract.md §… auto-joins …",
}

// Fixed M2-era identifiers so dumps and assertions stay deterministic.
const (
	m3OwnerUser   = "11e00000-0000-4000-8000-000000000001" // ws1 owner
	m3CoOwnerUser = "11e00000-0000-4000-8000-000000000002" // ws1 co-owner (second owner), ws3 owner
	m3MemberUser  = "11e00000-0000-4000-8000-000000000003" // ws1 member, ws2 owner
	m3GuestUser   = "11e00000-0000-4000-8000-000000000004" // ws1 guest, unverified
	m3AdminUser   = "11e00000-0000-4000-8000-000000000005" // admin in ws1 and ws2

	m3Workspace1 = "22e00000-0000-4000-8000-000000000001" // active, opener-v2 shape channels
	m3Workspace2 = "22e00000-0000-4000-8000-000000000002" // active, default shape channels
	m3Workspace3 = "22e00000-0000-4000-8000-000000000003" // soft-deleted, must survive

	m3FamilyOwner   = "33e00000-0000-4000-8000-000000000001" // live
	m3FamilyCoOwner = "33e00000-0000-4000-8000-000000000002" // revoked (logout)
	m3FamilyMember  = "33e00000-0000-4000-8000-000000000003" // live

	m3SessionOwner   = "44e00000-0000-4000-8000-000000000001" // live owner refresh session
	m3SessionRotated = "44e00000-0000-4000-8000-000000000002" // rotated away; predecessor lineage only
	m3SessionCoOwner = "44e00000-0000-4000-8000-000000000003" // session inside the revoked family
	m3SessionMember  = "44e00000-0000-4000-8000-000000000004" // live member session

	m3ChannelAll1 = "55e00000-0000-4000-8000-000000000001" // ws1 #all, type private (opener v2)
	m3ChannelAnn1 = "55e00000-0000-4000-8000-000000000002" // ws1 #announcement
	m3ChannelOnb1 = "55e00000-0000-4000-8000-000000000003" // ws1 onboarding-owner private channel
	m3ChannelAll2 = "55e00000-0000-4000-8000-000000000004" // ws2 #all, type channel (default)
	m3ChannelAnn2 = "55e00000-0000-4000-8000-000000000005" // ws2 #announcement
	m3ChannelAll3 = "55e00000-0000-4000-8000-000000000006" // ws3 #all
	m3ChannelAnn3 = "55e00000-0000-4000-8000-000000000007" // ws3 #announcement

	m3Machine1 = "66e00000-0000-4000-8000-000000000001" // rich facts, settled online
	m3Machine2 = "66e00000-0000-4000-8000-000000000002" // settled offline
	m3Machine3 = "66e00000-0000-4000-8000-000000000003" // runtimes NULL (unknown)

	m3Computer1 = "77e00000-0000-4000-8000-000000000001" // active
	m3Computer2 = "77e00000-0000-4000-8000-000000000002" // revoked
	m3Computer3 = "77e00000-0000-4000-8000-000000000003" // active

	m3Agent1 = "88e00000-0000-4000-8000-000000000001" // ws1 official Cindy, machine-bound
	m3Agent2 = "88e00000-0000-4000-8000-000000000002" // ws1 generic helper
	m3Agent3 = "88e00000-0000-4000-8000-000000000003" // ws2 official Cindy
	m3Agent4 = "88e00000-0000-4000-8000-000000000004" // ws1 soft-deleted

	m3VerifyTokenID = "99e00000-0000-4000-8000-000000000001"
	m3ResetTokenID  = "99e00000-0000-4000-8000-000000000002"
	m3ReceiptID     = "99e00000-0000-4000-8000-000000000003"
	m3AcceptanceID  = "99e00000-0000-4000-8000-000000000004"
	m3AuditID1      = "99e00000-0000-4000-8000-000000000005"
	m3AuditID2      = "99e00000-0000-4000-8000-000000000006"
)

// Opaque secrets in the legacy 64-hex shape. Only SHA-256 hashes are
// persisted; the raw values exist so tests can prove the stored hashes still
// resolve after the upgrade.
const (
	m3RefreshOwner1   = "11000000000000000000000000000000000000000000000000000000000000aa"
	m3RefreshOwner0   = "110000000000000000000000000000000000000000000000000000000000000a"
	m3RefreshCoOwner1 = "22000000000000000000000000000000000000000000000000000000000000bb"
	m3RefreshMember1  = "33000000000000000000000000000000000000000000000000000000000000cc"
	m3VerifySecret    = "44000000000000000000000000000000000000000000000000000000000000dd"
	m3ResetSecret     = "55000000000000000000000000000000000000000000000000000000000000ee"
)

const (
	m3AvatarOwner = "/api/avatars/users/5e000000000000000000000000000001.png"
	m3AvatarWS1   = "/api/avatars/workspaces/5e000000000000000000000000000002.png"
	m3AvatarAdmin = "/api/avatars/users/5e000000000000000000000000000003.png"
)

// m3M2TableOrder fixes the deterministic dump order for every M2 table the
// upgrade must preserve. It doubles as the list of tables snapshotted before
// and after the upgrade.
var m3M2TableOrder = map[string]string{
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
	"account_workspace_order":              "user_id",
	"workspace_member_setup":               "workspace_id, user_id",
	"machines":                             "id",
	"computers":                            "id",
	"agents":                               "id",
	"agent_members":                        "workspace_id, agent_id",
	"workspace_member_preferences":         "workspace_id, user_id",
}

// m3FrozenM2Migrations is the exact, ordered migration set an M2 binary could
// have applied. The fixture fails loudly if the frozen files change shape.
var m3FrozenM2Migrations = []string{
	"0001_init.sql",
	"0002_account_email_requests.sql",
	"0003_workspace_foundation.sql",
	"0004_workspace_setup.sql",
	"0005_workspace_preferences.sql",
}

// m3MigrationFiles returns the migration file names on disk, sorted. Tests
// run with the package directory as working directory, like the M2 suite.
func m3MigrationFiles(t *testing.T) []string {
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

// m3PendingMigrations reports whether an actual M2->M3 upgrade would run,
// i.e. whether any migration newer than the frozen M2 five is on disk.
func m3PendingMigrations(t *testing.T) bool {
	t.Helper()
	for _, name := range m3MigrationFiles(t) {
		if strings.Compare(name, "0006_") >= 0 {
			return true
		}
	}
	return false
}

// m3OpenRaw opens a direct SQLite handle outside store.Open so tests can
// build the M2 database and inject faults with the same pragmas the app uses.
func m3OpenRaw(t *testing.T, path string, immediate bool) *sql.DB {
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

type m3Querier interface {
	QueryContext(ctx context.Context, query string, args ...any) (*sql.Rows, error)
}

type m3RefreshSeed struct {
	Raw       string
	SessionID string
	UserID    string
	FamilyID  string
}

type m3OneShotSeed struct {
	Raw    string
	ID     string
	UserID string
	Kind   string
}

// m3TableSchema is the semantic fingerprint of one table: column definitions,
// foreign keys and indexes. The upgrade may only ADD to it.
type m3TableSchema struct {
	Columns map[string]m3ColumnDef
	FKs     []string // "parent|from->to|on_update|on_delete", ordered
	Indexes map[string]m3IndexDef
}

type m3ColumnDef struct {
	Type    string
	NotNull bool
	Default sql.NullString
	PK      bool
}

func (d m3ColumnDef) equals(o m3ColumnDef) bool {
	if d.Type != o.Type || d.NotNull != o.NotNull || d.PK != o.PK {
		return false
	}
	switch {
	case !d.Default.Valid && !o.Default.Valid:
		return true
	case d.Default.Valid && o.Default.Valid:
		return d.Default.String == o.Default.String
	default:
		return false
	}
}

type m3IndexDef struct {
	Unique  bool
	Origin  string
	Columns []string
}

// m3CaptureSchema fingerprints the given tables. Names come from trusted
// callers, never user input, so embedding them in PRAGMA statements is safe.
func m3CaptureSchema(t *testing.T, q m3Querier, tables []string) map[string]m3TableSchema {
	t.Helper()
	ctx := context.Background()
	out := make(map[string]m3TableSchema, len(tables))
	for _, table := range tables {
		ts := m3TableSchema{
			Columns: map[string]m3ColumnDef{},
			Indexes: map[string]m3IndexDef{},
		}
		rows, err := q.QueryContext(ctx, "PRAGMA table_info("+table+")")
		if err != nil {
			t.Fatalf("table_info(%s): %v", table, err)
		}
		for rows.Next() {
			var cid int
			var name, typ string
			var notNull, pk int
			var dflt sql.NullString
			if err := rows.Scan(&cid, &name, &typ, &notNull, &dflt, &pk); err != nil {
				rows.Close()
				t.Fatalf("scan table_info(%s): %v", table, err)
			}
			ts.Columns[name] = m3ColumnDef{Type: typ, NotNull: notNull == 1, Default: dflt, PK: pk == 1}
		}
		if err := rows.Err(); err != nil {
			rows.Close()
			t.Fatalf("iterate table_info(%s): %v", table, err)
		}
		rows.Close()
		if len(ts.Columns) == 0 {
			t.Fatalf("table %s disappeared from the schema", table)
		}

		rows, err = q.QueryContext(ctx, "PRAGMA foreign_key_list("+table+")")
		if err != nil {
			t.Fatalf("foreign_key_list(%s): %v", table, err)
		}
		for rows.Next() {
			var id, seq int
			var parent, from, to, onUpdate, onDelete, match string
			if err := rows.Scan(&id, &seq, &parent, &from, &to, &onUpdate, &onDelete, &match); err != nil {
				rows.Close()
				t.Fatalf("scan foreign_key_list(%s): %v", table, err)
			}
			ts.FKs = append(ts.FKs, fmt.Sprintf("%s|%s->%s|%s|%s", parent, from, to, onUpdate, onDelete))
		}
		if err := rows.Err(); err != nil {
			rows.Close()
			t.Fatalf("iterate foreign_key_list(%s): %v", table, err)
		}
		rows.Close()
		sort.Strings(ts.FKs)

		rows, err = q.QueryContext(ctx, "PRAGMA index_list("+table+")")
		if err != nil {
			t.Fatalf("index_list(%s): %v", table, err)
		}
		var indexNames []string
		uniqueByName := map[string]bool{}
		originByName := map[string]string{}
		for rows.Next() {
			var seq int
			var name string
			var unique int
			var origin string
			var partial int
			if err := rows.Scan(&seq, &name, &unique, &origin, &partial); err != nil {
				rows.Close()
				t.Fatalf("scan index_list(%s): %v", table, err)
			}
			indexNames = append(indexNames, name)
			uniqueByName[name] = unique == 1
			originByName[name] = origin
		}
		if err := rows.Err(); err != nil {
			rows.Close()
			t.Fatalf("iterate index_list(%s): %v", table, err)
		}
		rows.Close()
		sort.Strings(indexNames)
		for _, name := range indexNames {
			irows, err := q.QueryContext(ctx, "PRAGMA index_info("+name+")")
			if err != nil {
				t.Fatalf("index_info(%s): %v", name, err)
			}
			var cols []string
			for irows.Next() {
				var seqno int
				var cid sql.NullString
				var colName sql.NullString
				if err := irows.Scan(&seqno, &cid, &colName); err != nil {
					irows.Close()
					t.Fatalf("scan index_info(%s): %v", name, err)
				}
				if !colName.Valid {
					irows.Close()
					t.Fatalf("index %s uses an expression column; extend the fingerprint first", name)
				}
				cols = append(cols, colName.String)
			}
			if err := irows.Err(); err != nil {
				irows.Close()
				t.Fatalf("iterate index_info(%s): %v", name, err)
			}
			irows.Close()
			ts.Indexes[name] = m3IndexDef{Unique: uniqueByName[name], Origin: originByName[name], Columns: cols}
		}
		out[table] = ts
	}
	return out
}

// m3AllTables lists user tables (sqlite internals and schema_migrations
// excluded).
func m3AllTables(t *testing.T, q m3Querier) []string {
	t.Helper()
	rows, err := q.QueryContext(context.Background(),
		`SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name != 'schema_migrations' ORDER BY name`)
	if err != nil {
		t.Fatalf("list tables: %v", err)
	}
	defer rows.Close()
	var out []string
	for rows.Next() {
		var name string
		if err := rows.Scan(&name); err != nil {
			t.Fatalf("scan table name: %v", err)
		}
		out = append(out, name)
	}
	if err := rows.Err(); err != nil {
		t.Fatalf("iterate tables: %v", err)
	}
	return out
}

// m3TableColumns captures the column names of every M2 table. Post-upgrade
// dumps re-query exactly these columns, so a renamed or dropped M2 column
// fails loudly instead of silently comparing a subset.
func m3TableColumns(t *testing.T, q m3Querier) map[string][]string {
	t.Helper()
	out := make(map[string][]string, len(m3M2TableOrder))
	for table := range m3M2TableOrder {
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
			t.Fatalf("M2 table %s is missing from the database", table)
		}
		out[table] = cols
	}
	return out
}

// m3DumpTables renders every M2 table through its captured column list in a
// deterministic order, so two dumps are comparable byte for byte.
func m3DumpTables(t *testing.T, q m3Querier, cols map[string][]string) map[string]string {
	t.Helper()
	tables := make([]string, 0, len(m3M2TableOrder))
	for table := range m3M2TableOrder {
		tables = append(tables, table)
	}
	sort.Strings(tables)
	out := make(map[string]string, len(tables))
	ctx := context.Background()
	for _, table := range tables {
		query := fmt.Sprintf("SELECT %s FROM %s ORDER BY %s",
			strings.Join(cols[table], ", "), table, m3M2TableOrder[table])
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

func m3Excerpt(s string) string {
	const limit = 1600
	if len(s) <= limit {
		return s
	}
	return s[:limit] + "...(truncated)"
}

// m3RequireSameDump compares pre/post-upgrade dumps of the M2 tables.
func m3RequireSameDump(t *testing.T, label string, before, after map[string]string) {
	t.Helper()
	tables := make([]string, 0, len(before))
	for table := range before {
		tables = append(tables, table)
	}
	sort.Strings(tables)
	for _, table := range tables {
		if before[table] != after[table] {
			t.Errorf("%s: M2 rows of %s changed across the upgrade\n--- before ---\n%s\n--- after ---\n%s",
				label, table, m3Excerpt(before[table]), m3Excerpt(after[table]))
		}
	}
}

// m3SchemaVersions returns the sorted recorded migration versions.
func m3SchemaVersions(t *testing.T, q m3Querier) []string {
	t.Helper()
	rows, err := q.QueryContext(context.Background(), `SELECT version FROM schema_migrations ORDER BY version`)
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
	return out
}

// m3RequireSchemaVersions asserts every embedded migration is recorded
// exactly once and nothing else is.
func m3RequireSchemaVersions(t *testing.T, q m3Querier, wantFiles []string) {
	t.Helper()
	want := slices.Clone(wantFiles)
	sort.Strings(want)
	got := m3SchemaVersions(t, q)
	if !slices.Equal(got, want) {
		t.Fatalf("schema_migrations = %v; want each embedded migration exactly once: %v", got, want)
	}
}

// m3RequireIntegrity asserts an empty foreign_key_check and a passing
// integrity_check.
func m3RequireIntegrity(t *testing.T, q m3Querier) {
	t.Helper()
	ctx := context.Background()
	rows, err := q.QueryContext(ctx, `PRAGMA foreign_key_check`)
	if err != nil {
		t.Fatalf("foreign_key_check: %v", err)
	}
	var violations []string
	for rows.Next() {
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

// m3SealReceipt seals plaintext with a fresh AES-256-GCM key, mirroring how
// the auth package stores rotation receipts (base64 raw-URL parts).
func m3SealReceipt(t *testing.T, plaintext string) (ciphertext, iv, authTag string) {
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

type m3Fixture struct {
	path string
	now  int64

	passwords map[string]string        // user id -> raw password
	refresh   map[string]m3RefreshSeed // label -> live refresh token seed
	oneshots  []m3OneShotSeed          // verification/reset token seeds
	setupWant map[[2]string]string     // (workspace, user) -> seeded setup status

	m2Cols   map[string][]string      // M2 column names per table, pre-upgrade
	m2Dump   map[string]string        // deterministic dump of every M2 table
	m2Schema map[string]m3TableSchema // semantic schema fingerprint, pre-upgrade
	m2SQL    map[string]string        // sqlite_master CREATE text, pre-upgrade (informational)
}

// m3BuildLegacyM2 creates a real M2 database in a temp dir: the unchanged
// 0001–0005 SQL is applied verbatim, schema_migrations records exactly those
// five versions, and a representative M2 dataset is seeded with the same
// shapes the real M2 writers produce (workspace/service.go for channels,
// memberships, setup and preferences; auth for sessions/tokens/receipts).
func m3BuildLegacyM2(t *testing.T) *m3Fixture {
	t.Helper()

	const (
		dayMs      = int64(24 * time.Hour / time.Millisecond)
		sessionTTL = 90 * dayMs
		tokenTTL   = 7 * dayMs
	)
	f := &m3Fixture{
		path: filepath.Join(t.TempDir(), "raft-m2.sqlite"),
		now:  time.Now().Add(-24 * time.Hour).UnixMilli(),
		passwords: map[string]string{
			m3OwnerUser:   "m3-upgrade-password-owner",
			m3CoOwnerUser: "m3-upgrade-password-coowner",
			m3MemberUser:  "m3-upgrade-password-member",
			m3GuestUser:   "m3-upgrade-password-guest",
			m3AdminUser:   "m3-upgrade-password-admin",
		},
		refresh: map[string]m3RefreshSeed{
			"owner-live":   {Raw: m3RefreshOwner1, SessionID: m3SessionOwner, UserID: m3OwnerUser, FamilyID: m3FamilyOwner},
			"coowner-live": {Raw: m3RefreshCoOwner1, SessionID: m3SessionCoOwner, UserID: m3CoOwnerUser, FamilyID: m3FamilyCoOwner},
			"member-live":  {Raw: m3RefreshMember1, SessionID: m3SessionMember, UserID: m3MemberUser, FamilyID: m3FamilyMember},
		},
		oneshots: []m3OneShotSeed{
			{Raw: m3VerifySecret, ID: m3VerifyTokenID, UserID: m3GuestUser, Kind: "email_verification"},
			{Raw: m3ResetSecret, ID: m3ResetTokenID, UserID: m3OwnerUser, Kind: "password_reset"},
		},
		setupWant: map[[2]string]string{
			{m3Workspace1, m3OwnerUser}:   "complete",
			{m3Workspace1, m3CoOwnerUser}: "in_progress",
			{m3Workspace1, m3MemberUser}:  "not_started",
			{m3Workspace1, m3GuestUser}:   "deferred", // legacy status, must still read non-blocking
			{m3Workspace1, m3AdminUser}:   "not_started",
			{m3Workspace2, m3MemberUser}:  "complete",
			{m3Workspace2, m3AdminUser}:   "not_started",
			{m3Workspace3, m3CoOwnerUser}: "not_started",
		},
	}

	raw := m3OpenRaw(t, f.path, false)
	defer raw.Close()
	ctx := context.Background()

	// An M2 binary's migrate() created this bookkeeping table before applying
	// the chain; recreate it verbatim so the recording below matches the state
	// a real M2 database would be found in.
	if _, err := raw.ExecContext(ctx, `CREATE TABLE IF NOT EXISTS schema_migrations (
		version TEXT PRIMARY KEY,
		applied_at INTEGER NOT NULL
	)`); err != nil {
		t.Fatalf("create schema_migrations: %v", err)
	}

	// Apply exactly the frozen M2 five, verbatim, in order.
	files := m3MigrationFiles(t)
	if !slices.Equal(files[:min(5, len(files))], m3FrozenM2Migrations) {
		t.Fatalf("the frozen M1/M2 migrations changed shape: first files = %v; want %v (0001-0005 are frozen per the coordination doc)", files, m3FrozenM2Migrations)
	}
	for _, name := range m3FrozenM2Migrations {
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

	// Users: rich owner (with 0004 first-onboarding facts), zh co-owner,
	// minimal member, unverified guest, admin with avatar.
	exec(`
		INSERT INTO users (id, email, name, display_name, description, avatar_url,
			email_verified, password_hash, password_credential_established_at,
			preferred_language, display_language, preferred_timezone,
			first_observed_timezone, first_observed_timezone_at,
			last_observed_timezone, last_observed_timezone_at,
			auto_translation_enabled, preferred_translation_mode, preferred_translation_display,
			preferred_time_format, preferred_message_body_font_size,
			referral_source, signup_role, signup_survey_completed_at,
			profile_setup_completed_at, profile_setup_suggested_handle,
			first_onboarding_completed_at, first_onboarding_completed_session_family_id,
			created_at, updated_at)
		VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		m3OwnerUser, "owner@m2legacy.test", "m2_owner", "M2 Owner", "Seeded during the M2 era",
		m3AvatarOwner, hashes[m3OwnerUser], f.now-9000,
		"en", "en", "UTC", "UTC", f.now-8900, "Europe/Berlin", f.now-1500,
		"auto", "bilingual", "24h", "md", "search", "member", f.now-8000,
		f.now-7000, "m2_owner", f.now-3000, m3FamilyOwner, f.now-6000, f.now)
	exec(`INSERT INTO users (id, email, name, display_name, email_verified, password_hash,
			preferred_language, preferred_timezone, preferred_time_format, created_at, updated_at)
		VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?)`,
		m3CoOwnerUser, "coowner@m2legacy.test", "m2_coowner", "M2 Co-Owner", hashes[m3CoOwnerUser],
		"zh", "Asia/Shanghai", "12h", f.now-5800, f.now-4000)
	exec(`INSERT INTO users (id, email, name, email_verified, password_hash, created_at, updated_at)
		VALUES (?, ?, ?, 1, ?, ?, ?)`,
		m3MemberUser, "member@m2legacy.test", "m2_member", hashes[m3MemberUser], f.now-5700, f.now-5000)
	exec(`INSERT INTO users (id, email, name, email_verified, password_hash, created_at, updated_at)
		VALUES (?, ?, ?, 0, ?, ?, ?)`,
		m3GuestUser, "guest@m2legacy.test", "m2_guest", hashes[m3GuestUser], f.now-1600, f.now-1000)
	exec(`INSERT INTO users (id, email, name, avatar_url, email_verified, password_hash,
			referral_source, signup_role, created_at, updated_at)
		VALUES (?, ?, ?, ?, 1, ?, 'community', 'admin', ?, ?)`,
		m3AdminUser, "admin@m2legacy.test", "m2_admin", m3AvatarAdmin, hashes[m3AdminUser], f.now-4900, f.now-4000)

	// Session families: two live, one revoked.
	exec(`INSERT INTO session_families (id, user_id, revoked_at, revoked_reason, created_at) VALUES
			(?, ?, NULL, NULL, ?),
			(?, ?, ?, 'logout', ?),
			(?, ?, NULL, NULL, ?)`,
		m3FamilyOwner, m3OwnerUser, f.now-6000,
		m3FamilyCoOwner, m3CoOwnerUser, f.now-2000, f.now-5800,
		m3FamilyMember, m3MemberUser, f.now-5600)
	exec(`INSERT INTO sessions (id, user_id, family_id, token_hash, expires_at, created_at) VALUES
			(?, ?, ?, ?, ?, ?),
			(?, ?, ?, ?, ?, ?),
			(?, ?, ?, ?, ?, ?),
			(?, ?, ?, ?, ?, ?)`,
		m3SessionOwner, m3OwnerUser, m3FamilyOwner, auth.HashToken(m3RefreshOwner1), f.now+sessionTTL, f.now-5000,
		m3SessionRotated, m3OwnerUser, m3FamilyOwner, auth.HashToken(m3RefreshOwner0), f.now+30*dayMs, f.now-6000,
		m3SessionCoOwner, m3CoOwnerUser, m3FamilyCoOwner, auth.HashToken(m3RefreshCoOwner1), f.now+sessionTTL, f.now-4000,
		m3SessionMember, m3MemberUser, m3FamilyMember, auth.HashToken(m3RefreshMember1), f.now+sessionTTL, f.now-3500)

	// Hash lineage of the already-rotated owner token.
	exec(`INSERT INTO session_token_predecessors
			(token_hash, session_id, user_id, family_id, expires_at, created_at)
		VALUES (?, ?, ?, ?, ?, ?)`,
		auth.HashToken(m3RefreshOwner0), m3SessionRotated, m3OwnerUser, m3FamilyOwner, f.now+30*dayMs, f.now-5500)

	// Durable rotation receipt holding an AES-256-GCM sealed successor token.
	ct, iv, tag := m3SealReceipt(t, m3RefreshOwner1)
	exec(`INSERT INTO session_refresh_rotation_receipts
			(id, predecessor_token_hash, predecessor_session_id, user_id, family_id,
			 successor_session_id, attempt_id, installation_id,
			 successor_token_ciphertext, successor_token_iv, successor_token_auth_tag,
			 expires_at, created_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		m3ReceiptID, auth.HashToken(m3RefreshOwner0), m3SessionRotated, m3OwnerUser, m3FamilyOwner,
		m3SessionOwner, "attempt-m3-0001", "installation-m3-0001", ct, iv, tag,
		f.now+tokenTTL, f.now-5400)

	// One-shot email tokens plus their outliving request ledger rows.
	exec(`INSERT INTO account_tokens (id, user_id, kind, token_hash, expires_at, created_at) VALUES
			(?, ?, 'email_verification', ?, ?, ?),
			(?, ?, 'password_reset', ?, ?, ?)`,
		m3VerifyTokenID, m3GuestUser, auth.HashToken(m3VerifySecret), f.now+tokenTTL, f.now-900,
		m3ResetTokenID, m3OwnerUser, auth.HashToken(m3ResetSecret), f.now+tokenTTL, f.now-800)
	exec(`INSERT INTO account_email_requests (id, user_id, kind, created_at) VALUES
			(?, ?, 'email_verification', ?),
			(?, ?, 'password_reset', ?),
			(?, ?, 'email_verification', ?),
			(?, ?, 'password_reset', ?)`,
		"er-m3-verify-1", m3GuestUser, f.now-900,
		"er-m3-reset-1", m3OwnerUser, f.now-800,
		"er-m3-verify-0", m3GuestUser, f.now-3600000,
		"er-m3-reset-0", m3OwnerUser, f.now-7200000)

	exec(`INSERT INTO legal_acceptances
			(id, user_id, terms_version, privacy_version, terms_url, privacy_url,
			 source, ip_hash, user_agent_hash, locale, accepted_at)
		VALUES (?, ?, ?, ?, ?, ?, 'signup', ?, ?, 'en', ?)`,
		m3AcceptanceID, m3OwnerUser, "2025-06-01", "2025-06-01",
		"https://m2legacy.test/terms", "https://m2legacy.test/privacy",
		"ip-hash-m3-1", "ua-hash-m3-1", f.now-5900)

	// Workspaces (one soft-deleted) with the 0003-era columns M2 writers set.
	exec(`INSERT INTO workspaces (id, name, slug, owner_id, avatar_url, onboarding_agent_id,
			hide_humans_from_members, plan, created_at, deleted_at,
			kind, agent_all_channel_greeting_enabled, publicly_visible, translation_enabled,
			progress_announcements_enabled, updated_at)
		VALUES
			(?, 'M2 Legacy Alpha', 'm2-legacy-alpha', ?, ?, ?, 0, 'free', ?, NULL, 'normal', 1, 0, 0, 0, ?),
			(?, 'M2 Legacy Beta', 'm2-legacy-beta', ?, NULL, NULL, 0, 'pro', ?, NULL, 'normal', 1, 0, 1, 0, ?),
			(?, 'M2 Legacy Gone', 'm2-legacy-gone', ?, NULL, NULL, 1, 'founder', ?, ?, 'normal', 0, 0, 0, 0, ?)`,
		m3Workspace1, m3OwnerUser, m3AvatarWS1, m3Agent1, f.now-5500, f.now-1000,
		m3Workspace2, m3MemberUser, f.now-5000, f.now-900,
		m3Workspace3, m3CoOwnerUser, f.now-5200, f.now-1200, f.now-1200)

	// Memberships: owner AND co-owner in ws1, every role covered.
	exec(`INSERT INTO workspace_memberships (workspace_id, user_id, role, server_push_muted, joined_at) VALUES
			(?, ?, 'owner', 0, ?),
			(?, ?, 'owner', 0, ?),
			(?, ?, 'member', 0, ?),
			(?, ?, 'guest', 1, ?),
			(?, ?, 'admin', 0, ?),
			(?, ?, 'owner', 0, ?),
			(?, ?, 'admin', 0, ?),
			(?, ?, 'owner', 0, ?)`,
		m3Workspace1, m3OwnerUser, f.now-5500,
		m3Workspace1, m3CoOwnerUser, f.now-5450,
		m3Workspace1, m3MemberUser, f.now-5400,
		m3Workspace1, m3GuestUser, f.now-5350,
		m3Workspace1, m3AdminUser, f.now-5300,
		m3Workspace2, m3MemberUser, f.now-5000,
		m3Workspace2, m3AdminUser, f.now-4900,
		m3Workspace3, m3CoOwnerUser, f.now-5050)

	// Creation-time agreement audit rows, exactly the shape the M2 writer
	// produces (source='admin-add', no fabricated acceptance).
	exec(`INSERT INTO workspace_membership_agreement_audit
			(id, workspace_id, subject_type, subject_id, agreement_id, agreement_version,
			 actor_user_id, source, ip_address, user_agent, created_at)
		VALUES
			(?, ?, 'user', ?, NULL, NULL, ?, 'admin-add', NULL, NULL, ?),
			(?, ?, 'user', ?, NULL, NULL, ?, 'admin-add', NULL, NULL, ?)`,
		m3AuditID1, m3Workspace1, m3OwnerUser, m3OwnerUser, f.now-5500,
		m3AuditID2, m3Workspace2, m3MemberUser, m3MemberUser, f.now-5000)

	// Channels: ws1 in the opener-v2 shape (private #all + owner channel with
	// a channel_humans roster row), ws2/ws3 in the default shape — both are
	// producible by an M2 binary via RAFT_GO_POLICY_ONBOARDING_OPENER_V2.
	exec(`INSERT INTO channels (id, workspace_id, name, description, type, system_kind, created_at) VALUES
			(?, ?, 'all', 'General channel for all members', 'private', 'all', ?),
			(?, ?, 'announcement', 'Agent progress announcements', 'channel', 'announcement', ?),
			(?, ?, 'onboarding-owner', 'Your private onboarding space', 'private', NULL, ?),
			(?, ?, 'all', 'General channel for all members', 'channel', 'all', ?),
			(?, ?, 'announcement', 'Agent progress announcements', 'channel', 'announcement', ?),
			(?, ?, 'all', 'General channel for all members', 'channel', 'all', ?),
			(?, ?, 'announcement', 'Agent progress announcements', 'channel', 'announcement', ?)`,
		m3ChannelAll1, m3Workspace1, f.now-5500,
		m3ChannelAnn1, m3Workspace1, f.now-5500,
		m3ChannelOnb1, m3Workspace1, f.now-5500,
		m3ChannelAll2, m3Workspace2, f.now-5000,
		m3ChannelAnn2, m3Workspace2, f.now-5000,
		m3ChannelAll3, m3Workspace3, f.now-5200,
		m3ChannelAnn3, m3Workspace3, f.now-5200)
	exec(`INSERT INTO channel_humans (channel_id, user_id, role, authority_revision, joined_at)
		VALUES (?, ?, 'member', 1, ?)`, m3ChannelOnb1, m3OwnerUser, f.now-5500)

	// Account-level switcher order for the owner (real JSON array projection).
	exec(`INSERT INTO account_workspace_order (user_id, server_order, version, updated_at)
		VALUES (?, ?, 4, ?)`,
		m3OwnerUser, fmt.Sprintf(`["%s","%s"]`, m3Workspace2, m3Workspace1), f.now-800)

	// Per-member setup state: every legal status is represented; completion
	// facts are honest (written by the real transition path), never invented
	// by the migration.
	exec(`INSERT INTO workspace_member_setup (workspace_id, user_id, status, completion_reason,
			contract_version, handoff_acknowledged_at) VALUES
			(?, ?, 'complete', 'normal', 'onboarding-setup-v2', ?),
			(?, ?, 'in_progress', NULL, 'onboarding-setup-v2', NULL),
			(?, ?, 'not_started', NULL, 'onboarding-setup-v2', NULL),
			(?, ?, 'deferred', NULL, 'onboarding-setup-v2', NULL),
			(?, ?, 'not_started', NULL, 'onboarding-setup-v2', NULL),
			(?, ?, 'complete', 'normal', 'onboarding-setup-v2', NULL),
			(?, ?, 'not_started', NULL, 'onboarding-setup-v2', NULL),
			(?, ?, 'not_started', NULL, 'onboarding-setup-v2', NULL)`,
		m3Workspace1, m3OwnerUser, f.now-2500,
		m3Workspace1, m3CoOwnerUser,
		m3Workspace1, m3MemberUser,
		m3Workspace1, m3GuestUser,
		m3Workspace1, m3AdminUser,
		m3Workspace2, m3MemberUser,
		m3Workspace2, m3AdminUser,
		m3Workspace3, m3CoOwnerUser)

	// M2-era machine catalog: a rich settled-online row with the 0004-era
	// prefix-only credential shape, a settled-offline row, and an
	// unknown/never-reported row.
	exec(`INSERT INTO machines (id, workspace_id, user_id, name, description, api_key_prefix,
			runtimes, hostname, os, daemon_version, computer_version, computer_version_reported_at,
			last_heartbeat, last_status, status_changed_at, created_at) VALUES
			(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'online', ?, ?),
			(?, ?, ?, ?, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, 'offline', ?, ?),
			(?, ?, ?, ?, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, ?)`,
		m3Machine1, m3Workspace1, m3OwnerUser, "M2 MacBook", "primary dev box", "sk_machine_m2legacy",
		`["claude","codex"]`, "mbp.m2legacy.test", "darwin 25.5.0", "1.2.3",
		"1.0.0", f.now-3600000, f.now-60000, f.now-60000, f.now-5400,
		m3Machine2, m3Workspace1, m3OwnerUser, "M2 Old Runner", f.now-86400000, f.now-5300,
		m3Machine3, m3Workspace2, m3MemberUser, "M2 Unknown Box", f.now-5200)

	// M2-era Computer catalog: active, revoked, and machine-linked shapes.
	exec(`INSERT INTO computers (id, workspace_id, name, attached_by_user_id, machine_id,
			created_at, last_used_at, revoked_at, revoked_by_user_id, revoked_reason) VALUES
			(?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL),
			(?, ?, ?, ?, ?, ?, NULL, ?, ?, ?),
			(?, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL)`,
		m3Computer1, m3Workspace1, "Cindy MacBook", m3OwnerUser, m3Machine1, f.now-5350, f.now-1000,
		m3Computer2, m3Workspace1, "Revoked Box", m3CoOwnerUser, m3Machine2, f.now-5250, f.now-3000, m3CoOwnerUser, "replaced",
		m3Computer3, m3Workspace2, "Member Computer", m3MemberUser, m3Machine3, f.now-5150)

	// M2-era agent directory: official Cindy per workspace, a generic helper,
	// and a soft-deleted row whose name the partial unique index frees.
	exec(`INSERT INTO agents (id, workspace_id, name, display_name, description, avatar_url,
			status, runtime, machine_id, creator_type, creator_id, deleted_at, created_at, updated_at) VALUES
			(?, ?, 'Cindy', 'Cindy', 'Onboarding Assistant', 'pixel:mug', 'active', 'claude', ?, 'user', ?, NULL, ?, ?),
			(?, ?, 'helper_bot', NULL, NULL, NULL, 'inactive', 'codex', NULL, NULL, NULL, NULL, ?, ?),
			(?, ?, 'Cindy', NULL, NULL, NULL, 'active', 'claude', ?, 'user', ?, NULL, ?, ?),
			(?, ?, 'old_bot', NULL, NULL, NULL, 'stopped', 'claude', NULL, NULL, NULL, ?, ?, ?)`,
		m3Agent1, m3Workspace1, m3Machine1, m3OwnerUser, f.now-5450, f.now-2000,
		m3Agent2, m3Workspace1, f.now-5000, f.now-4000,
		m3Agent3, m3Workspace2, m3Machine3, m3MemberUser, f.now-4950, f.now-2500,
		m3Agent4, m3Workspace1, f.now-2000, f.now-2000, f.now-1900)

	// Agent workspace roles: only 'admin' satisfies the official onboarding
	// identity check.
	exec(`INSERT INTO agent_members (workspace_id, agent_id, role, joined_at, updated_at) VALUES
			(?, ?, 'admin', ?, ?),
			(?, ?, 'member', ?, ?),
			(?, ?, 'admin', ?, ?)`,
		m3Workspace1, m3Agent1, f.now-5450, f.now-2000,
		m3Workspace1, m3Agent2, f.now-5000, f.now-4000,
		m3Workspace2, m3Agent3, f.now-4950, f.now-2500)

	// Per-member preferences: one rich row with real onboarding/sidebar
	// values, one wizard-complete row, one dismissal-only row, rest defaults.
	exec(`INSERT INTO workspace_member_preferences (workspace_id, user_id,
			dismissed_add_computer_step_at, onboarding_wizard_current_step,
			sidebar_channel_order, sidebar_channel_sort_mode,
			pinned_version, sidebar_sections_version, hidden_dm_ids) VALUES
			(?, ?, ?, 'create-agent', ?, 'az', 5, 2, '[]'),
			(?, ?, NULL, 'complete', NULL, 'manual', 0, 0, NULL),
			(?, ?, ?, NULL, NULL, 'manual', 0, 0, NULL)`,
		m3Workspace1, m3OwnerUser, f.now-2000,
		fmt.Sprintf(`["%s","%s"]`, m3ChannelAll1, m3ChannelAnn1),
		m3Workspace1, m3CoOwnerUser,
		m3Workspace1, m3MemberUser, f.now-900)
	for _, mu := range [][2]string{
		{m3Workspace1, m3GuestUser},
		{m3Workspace1, m3AdminUser},
		{m3Workspace2, m3MemberUser},
		{m3Workspace2, m3AdminUser},
		{m3Workspace3, m3CoOwnerUser},
	} {
		exec(`INSERT INTO workspace_member_preferences (workspace_id, user_id) VALUES (?, ?)`, mu[0], mu[1])
	}

	// Seed sanity: the fixture the assertions rely on really is in the file.
	for table, want := range map[string]int{
		"users": 5, "session_families": 3, "sessions": 4,
		"session_token_predecessors": 1, "session_refresh_rotation_receipts": 1,
		"account_tokens": 2, "account_email_requests": 4, "legal_acceptances": 1,
		"workspaces": 3, "workspace_memberships": 8, "workspace_membership_agreement_audit": 2,
		"channels": 7, "channel_humans": 1, "account_workspace_order": 1,
		"workspace_member_setup": 8, "machines": 3, "computers": 3, "agents": 4,
		"agent_members": 3, "workspace_member_preferences": 8,
	} {
		var got int
		if err := raw.QueryRowContext(ctx, `SELECT COUNT(*) FROM `+table).Scan(&got); err != nil || got != want {
			t.Fatalf("seed sanity: %s count = %d (err %v); want %d", table, got, err, want)
		}
	}

	f.m2Cols = m3TableColumns(t, raw)
	f.m2Dump = m3DumpTables(t, raw, f.m2Cols)
	f.m2Schema = m3CaptureSchema(t, raw, m3SortedTableNames())
	f.m2SQL = m3TableSQL(t, raw)
	return f
}

// m3SortedTableNames returns the M2 business tables in a stable order.
func m3SortedTableNames() []string {
	names := make([]string, 0, len(m3M2TableOrder))
	for name := range m3M2TableOrder {
		names = append(names, name)
	}
	sort.Strings(names)
	return names
}

// m3TableSQL captures the CREATE text of the M2 tables for informational
// diff logging (semantic verdicts come from m3CaptureSchema).
func m3TableSQL(t *testing.T, q m3Querier) map[string]string {
	t.Helper()
	out := map[string]string{}
	for _, name := range m3SortedTableNames() {
		rows, err := q.QueryContext(context.Background(),
			`SELECT sql FROM sqlite_master WHERE type='table' AND name = ?`, name)
		if err != nil {
			t.Fatalf("read CREATE text of %s: %v", name, err)
		}
		var text sql.NullString
		for rows.Next() {
			if err := rows.Scan(&text); err != nil {
				rows.Close()
				t.Fatalf("scan CREATE text of %s: %v", name, err)
			}
		}
		if err := rows.Err(); err != nil {
			rows.Close()
			t.Fatalf("iterate CREATE text of %s: %v", name, err)
		}
		rows.Close()
		out[name] = text.String
	}
	return out
}

// TestM3UpgradePreservesEveryM2RowAndColumn upgrades a fully seeded M2
// database in place through store.Open and verifies every M2 fact survives:
// the complete dump of all M2 columns is byte-identical, every embedded
// migration is recorded exactly once, passwords still verify, refresh and
// one-shot tokens still resolve, and referential integrity is clean.
func TestM3UpgradePreservesEveryM2RowAndColumn(t *testing.T) {
	f := m3BuildLegacyM2(t)

	upgraded, err := store.Open(f.path)
	if err != nil {
		t.Fatalf("db.Open must upgrade the M2 database in place: %v", err)
	}
	defer upgraded.Close()

	m3RequireSchemaVersions(t, upgraded, m3MigrationFiles(t))
	m3RequireSameDump(t, "in-place upgrade", f.m2Dump, m3DumpTables(t, upgraded, f.m2Cols))

	// Password hashes remain verifiable against the original secrets.
	hasher := auth.NewPasswordHasher(8192, 1, 1, 1)
	for userID, password := range f.passwords {
		var stored string
		if err := upgraded.QueryRow(`SELECT password_hash FROM users WHERE id = ?`, userID).Scan(&stored); err != nil {
			t.Errorf("user %s lost across upgrade: %v", userID, err)
			continue
		}
		if !hasher.Verify(password, stored) {
			t.Errorf("stored password hash for user %s no longer verifies against the M2 secret", userID)
		}
	}

	// Refresh tokens still resolve to the same sessions (the exact lookup the
	// auth package performs on every refresh).
	for label, seed := range f.refresh {
		var sid, uid, fam string
		err := upgraded.QueryRow(
			`SELECT id, user_id, family_id FROM sessions WHERE token_hash = ?`,
			auth.HashToken(seed.Raw)).Scan(&sid, &uid, &fam)
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

	// The M2 server-list query (GET /api/servers) still returns the same
	// roles in joined_at order for the owner of two workspaces.
	rows, err := upgraded.Query(`
		SELECT m.role FROM workspace_memberships m
		JOIN workspaces w ON w.id = m.workspace_id
		WHERE m.user_id = ? AND w.deleted_at IS NULL
		ORDER BY m.joined_at ASC, w.id ASC`, m3MemberUser)
	if err != nil {
		t.Fatalf("M2 server-list query: %v", err)
	}
	var roles []string
	for rows.Next() {
		var role string
		if err := rows.Scan(&role); err != nil {
			rows.Close()
			t.Fatalf("scan M2 server-list row: %v", err)
		}
		roles = append(roles, role)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		t.Fatalf("iterate M2 server-list rows: %v", err)
	}
	rows.Close()
	if !slices.Equal(roles, []string{"member", "owner"}) {
		t.Fatalf("M2 server list for the member = %v; want [member owner] (ws1 member + ws2 owner untouched)", roles)
	}

	m3RequireIntegrity(t, upgraded)
}

// TestM3UpgradeChangesAreAdditiveAndDocumented diffs the schema across the
// upgrade. Everything must be strictly additive:
//
//   - no M2 table is dropped;
//   - no M2 column is dropped or redefined (type, NOT NULL, default, PK);
//   - every M2 foreign key and index survives with the same shape;
//   - a migration writing values into a new column of PRE-EXISTING rows is
//     only accepted when every row reads NULL or exactly the declared
//     default, unless registered in m3DocumentedMigrationBackfills;
//   - rows a migration inserts into a BRAND-NEW table must be registered in
//     m3DocumentedMigrationInserts.
func TestM3UpgradeChangesAreAdditiveAndDocumented(t *testing.T) {
	f := m3BuildLegacyM2(t)

	upgraded, err := store.Open(f.path)
	if err != nil {
		t.Fatalf("db.Open must upgrade the M2 database in place: %v", err)
	}
	defer upgraded.Close()

	preTables := m3SortedTableNames()
	postTables := m3AllTables(t, upgraded)
	postSet := make(map[string]bool, len(postTables))
	for _, name := range postTables {
		postSet[name] = true
	}
	for _, name := range preTables {
		if !postSet[name] {
			t.Errorf("M2 table %s was dropped by the upgrade; M2 tables are frozen", name)
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
		if reason, ok := m3DocumentedMigrationInserts[name]; ok {
			t.Logf("new table %s carries %d documented migration rows: %s", name, count, reason)
			continue
		}
		t.Errorf("the migration inserted %d rows into new table %s; register the backfill in m3DocumentedMigrationInserts with a contract-doc reference or make the migration create the table empty", count, name)
	}

	postSchema := m3CaptureSchema(t, upgraded, preTables)
	for _, table := range preTables {
		pre, post := f.m2Schema[table], postSchema[table]

		for col, def := range pre.Columns {
			got, ok := post.Columns[col]
			if !ok {
				t.Errorf("%s.%s was dropped by the upgrade; M2 columns are frozen", table, col)
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
				t.Errorf("%s lost the foreign key %s across the upgrade (a table rebuild must recreate every M2 constraint)", table, fk)
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

		// New columns may exist, but every pre-existing row must read NULL or
		// exactly the declared default — anything else is a data rewrite that
		// needs a whitelisted contract reference.
		for col, def := range post.Columns {
			if _, old := pre.Columns[col]; old {
				continue
			}
			if reason, ok := m3DocumentedMigrationBackfills[table][col]; ok {
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
					t.Errorf("migration wrote %d non-NULL values into new nullable column %s.%s of pre-existing rows; old rows must read NULL, or the backfill must be registered in m3DocumentedMigrationBackfills", offending, table, col)
				}
				continue
			}
			// The default text comes from trusted schema introspection and is
			// embedded as a literal so SQLite compares with the declared
			// type/affinity exactly.
			var offending int
			if err := upgraded.QueryRow(
				fmt.Sprintf("SELECT COUNT(*) FROM %s WHERE %s IS NOT %s", table, col, def.Default.String)).Scan(&offending); err != nil {
				t.Fatalf("audit new column %s.%s against its default: %v", table, col, err)
			}
			if offending > 0 {
				t.Errorf("migration wrote %d non-default values into new column %s.%s of pre-existing rows; old rows must read NULL or the declared default (%s), or the backfill must be registered in m3DocumentedMigrationBackfills", offending, table, col, def.Default.String)
			}
		}
	}

	// Informational: log CREATE-text changes for the report. Verdicts above
	// are semantic; a pure ALTER ADD COLUMN also rewrites this text.
	postSQL := m3TableSQL(t, upgraded)
	for table, before := range f.m2SQL {
		if after := postSQL[table]; before != after {
			t.Logf("%s: CREATE text changed across the upgrade (expected for added columns/rebuilds; semantic diff above is authoritative)", table)
		}
	}

	m3RequireIntegrity(t, upgraded)
}

// TestM3UpgradeInventsNoCredentialsStatusOrCompletion pins the honesty bar
// for facts the upgrade must not fabricate: legacy machines/computers gain no
// credentials in the new 0007 columns, setup state is not completed or
// regressed, system channels/rosters are untouched, and the unverified guest
// is not silently verified.
func TestM3UpgradeInventsNoCredentialsStatusOrCompletion(t *testing.T) {
	f := m3BuildLegacyM2(t)

	upgraded, err := store.Open(f.path)
	if err != nil {
		t.Fatalf("db.Open must upgrade the M2 database in place: %v", err)
	}
	defer upgraded.Close()

	// Credential columns planned by 0007 (docs/m3-computer-contract.md §1).
	// Old machines/computers had no verifiable secret, so they must upgrade
	// to NULL credentials — never an invented key. The columns are probed
	// conditionally so this stays green before 0007 lands.
	for _, probe := range []struct{ table, column string }{
		{"machines", "api_key_hash"},
		{"machines", "api_key_fingerprint"},
		{"machines", "legacy_key_migrated_at"},
		{"computers", "api_key_hash"},
		{"computers", "api_key_prefix"},
	} {
		if !m3HasColumn(t, upgraded, probe.table, probe.column) {
			continue
		}
		var offending int
		if err := upgraded.QueryRow(fmt.Sprintf(
			"SELECT COUNT(*) FROM %s WHERE %s IS NOT NULL", probe.table, probe.column)).Scan(&offending); err != nil {
			t.Fatalf("probe %s.%s: %v", probe.table, probe.column, err)
		}
		if offending > 0 {
			t.Errorf("upgrade invented credentials: %d legacy rows in %s carry a non-NULL %s (old rows must read NULL)", offending, probe.table, probe.column)
		}
	}

	// Per-member setup state is exactly what M2 wrote — no auto-completion,
	// no regression of completed members.
	for key, want := range f.setupWant {
		var got string
		err := upgraded.QueryRow(
			`SELECT status FROM workspace_member_setup WHERE workspace_id = ? AND user_id = ?`,
			key[0], key[1]).Scan(&got)
		if err != nil {
			t.Errorf("setup row %s/%s lost across upgrade: %v", key[0], key[1], err)
			continue
		}
		if got != want {
			t.Errorf("setup status of %s/%s changed from %q to %q across the upgrade; setup facts are only written by the real transition paths", key[0], key[1], want, got)
		}
	}
	var reason sql.NullString
	if err := upgraded.QueryRow(
		`SELECT completion_reason FROM workspace_member_setup WHERE workspace_id = ? AND user_id = ?`,
		m3Workspace1, m3OwnerUser).Scan(&reason); err != nil || !reason.Valid || reason.String != "normal" {
		t.Errorf("the M2 completion fact (owner, reason=normal) must survive verbatim; got %v (err %v)", reason.String, err)
	}

	// System channels and the human roster are untouched per workspace.
	for ws, want := range map[string]int{m3Workspace1: 3, m3Workspace2: 2, m3Workspace3: 2} {
		var got int
		if err := upgraded.QueryRow(
			`SELECT COUNT(*) FROM channels WHERE workspace_id = ?`, ws).Scan(&got); err != nil || got != want {
			t.Errorf("channel count of workspace %s = %d (err %v); want exactly the %d M2 channels (the upgrade must not create, delete or archive channels)", ws, got, err, want)
		}
	}
	var allSystem, annSystem int
	if err := upgraded.QueryRow(
		`SELECT COUNT(*) FROM channels WHERE workspace_id = ? AND system_kind = 'all' AND type = 'private' AND deleted_at IS NULL`,
		m3Workspace1).Scan(&allSystem); err != nil || allSystem != 1 {
		t.Errorf("ws1 #all system channel shape changed: count=%d err=%v", allSystem, err)
	}
	if err := upgraded.QueryRow(
		`SELECT COUNT(*) FROM channels WHERE workspace_id = ? AND system_kind = 'announcement' AND type = 'channel' AND deleted_at IS NULL`,
		m3Workspace2).Scan(&annSystem); err != nil || annSystem != 1 {
		t.Errorf("ws2 #announcement system channel shape changed: count=%d err=%v", annSystem, err)
	}
	var rosterRole string
	var rosterRev int
	if err := upgraded.QueryRow(
		`SELECT role, authority_revision FROM channel_humans WHERE channel_id = ? AND user_id = ?`,
		m3ChannelOnb1, m3OwnerUser).Scan(&rosterRole, &rosterRev); err != nil || rosterRole != "member" || rosterRev != 1 {
		t.Errorf("the M2 channel_humans roster row must survive verbatim; got role=%q rev=%d err=%v", rosterRole, rosterRev, err)
	}

	// The unverified guest is not silently verified; no users were added.
	var verified int
	if err := upgraded.QueryRow(
		`SELECT email_verified FROM users WHERE id = ?`, m3GuestUser).Scan(&verified); err != nil || verified != 0 {
		t.Errorf("the M2-unverified guest must stay unverified; got %d (err %v)", verified, err)
	}
	var userCount int
	if err := upgraded.QueryRow(`SELECT COUNT(*) FROM users`).Scan(&userCount); err != nil || userCount != len(f.passwords) {
		t.Errorf("user count = %d (err %v); want exactly the %d M2 users", userCount, err, len(f.passwords))
	}

	// Machine connection facts stay exactly as settled in M2 (online stays
	// online with its heartbeat, offline stays offline, unknown stays NULL).
	for _, probe := range []struct {
		machine string
		want    sql.NullString
	}{
		{m3Machine1, sql.NullString{String: "online", Valid: true}},
		{m3Machine2, sql.NullString{String: "offline", Valid: true}},
		{m3Machine3, sql.NullString{}},
	} {
		var got sql.NullString
		if err := upgraded.QueryRow(
			`SELECT last_status FROM machines WHERE id = ?`, probe.machine).Scan(&got); err != nil {
			t.Errorf("machine %s lost across upgrade: %v", probe.machine, err)
			continue
		}
		if got.Valid != probe.want.Valid || got.String != probe.want.String {
			t.Errorf("machine %s last_status changed from %+v to %+v across the upgrade; persisted status facts are frozen", probe.machine, probe.want, got)
		}
	}
}

// m3HasColumn reports whether the table currently has the column.
func m3HasColumn(t *testing.T, q m3Querier, table, column string) bool {
	t.Helper()
	rows, err := q.QueryContext(context.Background(), "PRAGMA table_info("+table+")")
	if err != nil {
		t.Fatalf("table_info(%s): %v", table, err)
	}
	defer rows.Close()
	for rows.Next() {
		var cid int
		var name, typ string
		var notNull, pk int
		var dflt sql.NullString
		if err := rows.Scan(&cid, &name, &typ, &notNull, &dflt, &pk); err != nil {
			t.Fatalf("scan table_info(%s): %v", table, err)
		}
		if name == column {
			return true
		}
	}
	if err := rows.Err(); err != nil {
		t.Fatalf("iterate table_info(%s): %v", table, err)
	}
	return false
}

// TestM3UpgradeFailureRollsBackAndRetryUpgrades injects a failure into the
// migration recording step through an isolated SQLite trigger (the migration
// body and its version INSERT share one transaction), asserts db.Open fails
// closed with the M2 data byte-identical and the failed migration unrecorded,
// then clears the fault and verifies a retry upgrades cleanly.
func TestM3UpgradeFailureRollsBackAndRetryUpgrades(t *testing.T) {
	if !m3PendingMigrations(t) {
		t.Skip("no M3 migrations (>=0006) on disk yet; nothing to inject a failure into — rerun once migrations 0006+ land")
	}
	f := m3BuildLegacyM2(t)

	raw := m3OpenRaw(t, f.path, false)
	if _, err := raw.Exec(`
		CREATE TRIGGER m3_test_block_m3_migrations
		BEFORE INSERT ON schema_migrations
		FOR EACH ROW
		WHEN NEW.version >= '0006'
		BEGIN
			SELECT RAISE(ABORT, 'm3 test: injected migration failure');
		END`); err != nil {
		t.Fatalf("install failure-injection trigger: %v", err)
	}
	raw.Close()

	if _, err := store.Open(f.path); err == nil {
		t.Fatal("db.Open must fail when a migration fails, not report a half-upgraded database as ready")
	}

	// The failed upgrade left the M2 state exactly as it was.
	raw = m3OpenRaw(t, f.path, false)
	if got := m3SchemaVersions(t, raw); !slices.Equal(got, m3FrozenM2Migrations) {
		t.Fatalf("a failed migration must not be recorded; schema_migrations = %v; want %v", got, m3FrozenM2Migrations)
	}
	m3RequireSameDump(t, "rolled-back upgrade", f.m2Dump, m3DumpTables(t, raw, f.m2Cols))
	m3RequireIntegrity(t, raw)
	if _, err := raw.Exec(`DROP TRIGGER m3_test_block_m3_migrations`); err != nil {
		t.Fatalf("drop failure-injection trigger: %v", err)
	}
	raw.Close()

	// Retrying the upgrade after the fault clears completes cleanly.
	upgraded, err := store.Open(f.path)
	if err != nil {
		t.Fatalf("retry upgrade after clearing the fault: %v", err)
	}
	defer upgraded.Close()
	m3RequireSchemaVersions(t, upgraded, m3MigrationFiles(t))
	m3RequireSameDump(t, "retry upgrade", f.m2Dump, m3DumpTables(t, upgraded, f.m2Cols))
	m3RequireIntegrity(t, upgraded)
}

// TestM3RepeatedOpenIsIdempotent upgrades once, then opens the same database
// again: the second Open must record nothing new and change nothing.
func TestM3RepeatedOpenIsIdempotent(t *testing.T) {
	f := m3BuildLegacyM2(t)

	first, err := store.Open(f.path)
	if err != nil {
		t.Fatalf("first open: %v", err)
	}
	versions1 := m3SchemaVersions(t, first)
	dump1 := m3DumpTables(t, first, f.m2Cols)
	first.Close()

	second, err := store.Open(f.path)
	if err != nil {
		t.Fatalf("second open: %v", err)
	}
	defer second.Close()
	m3RequireSchemaVersions(t, second, m3MigrationFiles(t))
	if got := m3SchemaVersions(t, second); !slices.Equal(got, versions1) {
		t.Fatalf("repeated upgrade re-recorded migrations: %v; want %v", got, versions1)
	}
	m3RequireSameDump(t, "repeated upgrade", dump1, m3DumpTables(t, second, f.m2Cols))
	m3RequireIntegrity(t, second)
}

// TestM3ConcurrentUpgradeFromM2 races several store.Open calls on the same
// M2 database. Every opener must succeed (or fail cleanly — never accepted
// with partial state), and the final database must hold every migration
// exactly once with the M2 data intact.
func TestM3ConcurrentUpgradeFromM2(t *testing.T) {
	f := m3BuildLegacyM2(t)

	const openers = 3
	var wg sync.WaitGroup
	errs := make(chan error, openers)
	start := make(chan struct{})
	for i := 0; i < openers; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			<-start
			db, err := store.Open(f.path)
			if err == nil {
				_ = db.Close()
			}
			errs <- err
		}()
	}
	close(start)
	wg.Wait()
	close(errs)
	for err := range errs {
		if err != nil {
			t.Errorf("concurrent upgrade: %v", err)
		}
	}

	final, err := store.Open(f.path)
	if err != nil {
		t.Fatalf("open after the concurrent upgrade: %v", err)
	}
	defer final.Close()
	m3RequireSchemaVersions(t, final, m3MigrationFiles(t))
	m3RequireSameDump(t, "concurrent upgrade", f.m2Dump, m3DumpTables(t, final, f.m2Cols))
	m3RequireIntegrity(t, final)
}

// TestM3OpenUnderHeldWriteLockLeavesNoPartialState runs db.Open while
// another connection holds the single WAL write slot, releases it
// mid-flight, and requires the upgrade to complete cleanly afterwards: no
// partially-applied migrations, M2 data intact. (Strict mid-wait context
// cancellation of the pooled write path is covered by the M2 suite; the
// connector is unchanged in M3.)
func TestM3OpenUnderHeldWriteLockLeavesNoPartialState(t *testing.T) {
	if testing.Short() {
		t.Skip("exercises a real lock wait (~1s) on purpose")
	}
	f := m3BuildLegacyM2(t)

	holder := m3OpenRaw(t, f.path, true)
	lockTx, err := holder.BeginTx(context.Background(), nil)
	if err != nil {
		holder.Close()
		t.Fatalf("acquire write lock: %v", err)
	}
	if _, err := lockTx.Exec(
		`INSERT INTO account_email_requests (id, user_id, kind, created_at) VALUES ('m3-open-probe', ?, 'email_verification', ?)`,
		m3OwnerUser, f.now); err != nil {
		t.Fatalf("probe write inside the lock: %v", err)
	}

	openDone := make(chan *struct {
		db  *sql.DB
		err error
	}, 1)
	go func() {
		db, err := store.Open(f.path)
		openDone <- &struct {
			db  *sql.DB
			err error
		}{db, err}
	}()

	time.Sleep(800 * time.Millisecond)
	if err := lockTx.Rollback(); err != nil {
		t.Fatalf("release write lock: %v", err)
	}
	holder.Close()

	result := <-openDone
	if result.err != nil {
		t.Fatalf("db.Open must complete once the write lock is released mid-flight: %v", result.err)
	}
	defer result.db.Close()
	m3RequireSchemaVersions(t, result.db, m3MigrationFiles(t))
	m3RequireSameDump(t, "open under held write lock", f.m2Dump, m3DumpTables(t, result.db, f.m2Cols))
	m3RequireIntegrity(t, result.db)
}

// TestM3UpgradeKeepsDefaultRoleAndKeyConstraints verifies the M2 behavioral
// contracts survive the upgrade: the corrected default membership role
// (member, design D05), explicit owner round-trips (the multi-owner model is
// retained), foreign keys stay enforced on pooled connections, and the
// system-channel / channel-name / agent-name uniqueness indexes still hold.
func TestM3UpgradeKeepsDefaultRoleAndKeyConstraints(t *testing.T) {
	f := m3BuildLegacyM2(t)

	upgraded, err := store.Open(f.path)
	if err != nil {
		t.Fatalf("db.Open must upgrade the M2 database in place: %v", err)
	}
	defer upgraded.Close()
	ctx := context.Background()

	defer func() {
		_, _ = upgraded.ExecContext(ctx,
			`DELETE FROM workspace_memberships WHERE workspace_id = ? AND user_id = ?`,
			m3Workspace2, m3GuestUser)
	}()

	// Default role is member; explicit roles, including a second owner,
	// remain expressible.
	if _, err := upgraded.ExecContext(ctx,
		`INSERT INTO workspace_memberships (workspace_id, user_id, joined_at) VALUES (?, ?, ?)`,
		m3Workspace2, m3GuestUser, f.now+60000); err != nil {
		t.Fatalf("insert membership without an explicit role: %v", err)
	}
	var role string
	if err := upgraded.QueryRowContext(ctx,
		`SELECT role FROM workspace_memberships WHERE workspace_id = ? AND user_id = ?`,
		m3Workspace2, m3GuestUser).Scan(&role); err != nil || role != "member" {
		t.Fatalf("new memberships must default to role=member after the upgrade; got %q (err %v)", role, err)
	}
	if _, err := upgraded.ExecContext(ctx,
		`UPDATE workspace_memberships SET role = 'owner' WHERE workspace_id = ? AND user_id = ?`,
		m3Workspace2, m3GuestUser); err != nil {
		t.Fatalf("explicit owner role must remain writable: %v", err)
	}

	// Foreign keys stay enforced on every pooled connection.
	if _, err := upgraded.ExecContext(ctx,
		`INSERT INTO workspace_memberships (workspace_id, user_id, joined_at) VALUES ('missing-ws', 'missing-user', 1)`); err == nil {
		t.Fatal("invalid membership must fail foreign-key enforcement after the upgrade")
	}
	if _, err := upgraded.ExecContext(ctx,
		`INSERT INTO machines (id, workspace_id, user_id, name, created_at) VALUES ('missing-machine', 'missing-ws', ?, 'x', 1)`,
		m3OwnerUser); err == nil {
		t.Fatal("machine insert with a bogus workspace must fail foreign-key enforcement after the upgrade")
	}

	// System-channel uniqueness: a second live #all in ws1 is rejected.
	if _, err := upgraded.ExecContext(ctx,
		`INSERT INTO channels (id, workspace_id, name, type, system_kind, created_at)
		 VALUES ('m3-probe-sys', ?, 'probe-sys', 'channel', 'all', ?)`,
		m3Workspace1, f.now); err == nil {
		t.Fatal("a second live system 'all' channel in one workspace must be rejected after the upgrade")
	}
	// Channel-name uniqueness across the participating types.
	if _, err := upgraded.ExecContext(ctx,
		`INSERT INTO channels (id, workspace_id, name, type, created_at)
		 VALUES ('m3-probe-name', ?, 'all', 'channel', ?)`,
		m3Workspace1, f.now); err == nil {
		t.Fatal("a duplicate live channel name in one workspace must be rejected after the upgrade")
	}
	// Agent-name uniqueness among live agents.
	if _, err := upgraded.ExecContext(ctx,
		`INSERT INTO agents (id, workspace_id, name, status, runtime, created_at, updated_at)
		 VALUES ('m3-probe-agent', ?, 'Cindy', 'inactive', 'claude', ?, ?)`,
		m3Workspace1, f.now, f.now); err == nil {
		t.Fatal("a duplicate live agent name in one workspace must be rejected after the upgrade")
	}
	// A revoked computer row keeps its identity; the guest stays unverified
	// is asserted in the honesty test.

	m3RequireIntegrity(t, upgraded)
}
