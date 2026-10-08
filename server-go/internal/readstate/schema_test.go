package readstate

import (
	"path/filepath"
	"testing"

	"raft.local/server-go/internal/channel"
	platformdb "raft.local/server-go/internal/platform/db"
)

// TestSchemaDraftAppliesToMigratedDB: the integrator-facing draft applies
// cleanly onto a database that already ran the frozen 0001-0010 chain, twice
// (idempotent), and passes the foreign-key check.
func TestSchemaDraftAppliesToMigratedDB(t *testing.T) {
	handle, err := platformdb.Open(filepath.Join(t.TempDir(), "schema.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer handle.Close()
	applySchemaDraft(t, handle)
	applySchemaDraft(t, handle)

	for _, table := range []string{
		"user_channel_read_states", "user_channel_done_states", "user_mention_suppressions",
		"user_channel_mute_states", "user_channel_display_prefs",
		"activity_principal_authorities", "activity_scopes", "activity_row_authorities",
		"activity_rows", "activity_changes",
	} {
		var one int
		if err := handle.QueryRow(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`, table).Scan(&one); err != nil {
			t.Fatalf("table %s missing after draft: %v", table, err)
		}
	}
	rows, err := handle.Query(`PRAGMA foreign_key_check`)
	if err != nil {
		t.Fatal(err)
	}
	if rows.Next() {
		rows.Close()
		t.Fatal("foreign key violation in the draft schema")
	}
	rows.Close()
}

// TestSchemaDraftMatchesStoreUsage: every table/column the store SQL touches
// exists with the expected shape (a cheap drift guard for the parent's copy
// into migrations/0011).
func TestSchemaDraftMatchesStoreUsage(t *testing.T) {
	fx := newFixture(t)
	columns := map[string]map[string]bool{}
	tables := []string{
		"user_channel_read_states", "user_channel_done_states", "user_mention_suppressions",
		"user_channel_mute_states", "user_channel_display_prefs",
		"activity_principal_authorities", "activity_scopes", "activity_row_authorities",
		"activity_rows", "activity_changes", "realtime_publications",
	}
	for _, table := range tables {
		columns[table] = map[string]bool{}
		rows, err := fx.db.Query(`PRAGMA table_info(` + table + `)`)
		if err != nil {
			t.Fatal(err)
		}
		for rows.Next() {
			var cid int
			var name, ctype string
			var notNull int
			var dfltValue any
			var pk int
			if err := rows.Scan(&cid, &name, &ctype, &notNull, &dfltValue, &pk); err != nil {
				rows.Close()
				t.Fatal(err)
			}
			columns[table][name] = true
		}
		rows.Close()
	}
	required := map[string][]string{
		"user_channel_read_states":       {"workspace_id", "user_id", "channel_id", "last_read_seq", "read_state_version", "updated_at"},
		"user_channel_done_states":       {"workspace_id", "user_id", "channel_id", "done_through_activity_seq", "done_at", "active_override", "revision", "updated_at"},
		"user_mention_suppressions":      {"workspace_id", "user_id", "target_kind", "channel_id", "done_through_seq", "done_at", "updated_at"},
		"user_channel_mute_states":       {"workspace_id", "user_id", "channel_id", "activity_muted", "mute_from_seq", "prefs_version", "created_at", "updated_at"},
		"user_channel_display_prefs":     {"workspace_id", "user_id", "channel_id", "collapse_long_messages", "prefs_version", "created_at", "updated_at"},
		"activity_principal_authorities": {"workspace_id", "principal_id", "row_version", "updated_at"},
		"activity_scopes":                {"workspace_id", "principal_id", "filter", "window_id", "window_size", "epoch", "watermark", "scope_digest", "metadata", "updated_at"},
		"activity_row_authorities":       {"workspace_id", "principal_id", "row_id", "last_version", "active", "payload_digest", "updated_at"},
		"activity_rows":                  {"workspace_id", "principal_id", "filter", "window_id", "row_id", "row_version", "active", "payload", "payload_digest", "tombstone_reason", "updated_at"},
		"activity_changes":               {"workspace_id", "principal_id", "filter", "window_id", "seq", "row_id", "row_version", "kind", "payload", "tombstone_reason", "created_at"},
	}
	for table, want := range required {
		for _, column := range want {
			if !columns[table][column] {
				t.Fatalf("%s.%s missing from the applied draft", table, column)
			}
		}
	}
}

// TestStoreWorksWithChannelStore: the default constructor wires the channel
// store and the shared handle without import cycles (compile+smoke).
func TestStoreWorksWithChannelStore(t *testing.T) {
	fx := newFixture(t)
	if fx.store == nil || fx.store.DB() == nil {
		t.Fatal("store not wired")
	}
	_ = channel.NewStore(fx.db)
}
