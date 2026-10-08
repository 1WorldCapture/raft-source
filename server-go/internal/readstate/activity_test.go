package readstate

import (
	"context"
	"path/filepath"
	"testing"
	"time"

	"raft.local/server-go/internal/auth"
	"raft.local/server-go/internal/channel"
	platformdb "raft.local/server-go/internal/platform/db"
)

func scopeIdentity(ws, user, filter string) ActivityScopeIdentity {
	return ActivityScopeIdentity{ServerID: ws, PrincipalID: user, Filter: filter, WindowID: ActivityWindowID}
}

// TestActivitySnapshotShape: the snapshot body carries canonical decimal
// strings, the sorted window, and activityVersion == watermark.
func TestActivitySnapshotShape(t *testing.T) {
	fx := newFixture(t)
	fx.seedThreadParents()
	seq1 := fx.insertMessage(fxGeneral, fxBob, "one")
	seq2 := fx.insertMessage(fxSecret, fxBob, "two", fxAlice)
	fx.follow(fxAlice, fxThread, false)
	fx.insertMessage(fxThread, fxBob, "reply")

	snap, err := fx.store.ActivitySnapshot(fx.ctx(), fx.claims[fxAlice], fxWS, SnapshotQuery{RequestID: "req-1", Filter: ActivityFilterAll})
	if err != nil {
		t.Fatal(err)
	}
	if snap.Type != "snapshot" || snap.RequestID != "req-1" {
		t.Fatalf("header = %+v", snap)
	}
	if snap.Scope != scopeIdentity(fxWS, fxAlice, ActivityFilterAll) {
		t.Fatalf("scope = %+v", snap.Scope)
	}
	if snap.Epoch != "1" || snap.Watermark == "" || snap.ActivityVersion != snap.Watermark {
		t.Fatalf("epoch/watermark/version = %s/%s/%s", snap.Epoch, snap.Watermark, snap.ActivityVersion)
	}
	if len(snap.Window.Rows) != 3 {
		t.Fatalf("rows = %d: %+v", len(snap.Window.Rows), snap.Window.Rows)
	}
	if snap.Window.TotalCount != 3 || !snap.Window.Complete || snap.Window.HasMore || snap.Window.TotalUnreadCount != 3 {
		t.Fatalf("window meta = %+v", snap.Window)
	}
	// Descending activity order; decimal-string seqs; thread row shape.
	first := snap.Window.Rows[0]
	if first["type"] != "thread" {
		t.Fatalf("first row = %+v", first)
	}
	if first["latestActivitySeq"] != "5" {
		t.Fatalf("thread latestActivitySeq = %v", first["latestActivitySeq"])
	}
	for _, row := range snap.Window.Rows {
		for _, key := range []string{"rowVersion", "latestActivitySeq", "maxReadSeq", "readStateVersion"} {
			if v, ok := row[key].(string); !ok || !canonicalUint64RE.MatchString(v) {
				t.Fatalf("row %v = %#v, want canonical decimal string", key, row[key])
			}
		}
	}
	// The channel row for #general keeps the shared seq space exact.
	for _, row := range snap.Window.Rows {
		if row["rowId"] == fxGeneral && row["latestActivitySeq"] != itoa(seq1) {
			t.Fatalf("general seq = %v, want %d", row["latestActivitySeq"], seq1)
		}
		if row["rowId"] == fxSecret && row["latestActivitySeq"] != itoa(seq2) {
			t.Fatalf("secret seq = %v (mention seq %d)", row["latestActivitySeq"], seq2)
		}
	}
}

// TestActivityNotModifiedAndDifference: equal watermark answers notModified;
// a change answers a difference whose rows dedup to the last change per row.
func TestActivityNotModifiedAndDifference(t *testing.T) {
	fx := newFixture(t)
	fx.insertMessage(fxGeneral, fxBob, "one")
	snap, err := fx.store.ActivitySnapshot(fx.ctx(), fx.claims[fxAlice], fxWS, SnapshotQuery{RequestID: "r", Filter: ActivityFilterAll})
	if err != nil {
		t.Fatal(err)
	}

	// No change in between: notModified with the same watermark.
	diff, err := fx.store.ActivityDifference(fx.ctx(), fx.claims[fxAlice], fxWS, DifferenceQuery{
		RequestID: "r", Filter: ActivityFilterAll, Epoch: snap.Epoch, AfterWatermark: snap.Watermark})
	if err != nil {
		t.Fatal(err)
	}
	if diff.Status != 200 || diff.NotModified == nil {
		t.Fatalf("expected notModified, got %+v", diff)
	}

	// One change: difference with fromSeq = after+1 and the new row.
	seq2 := fx.insertMessage(fxGeneral, fxBob, "two")
	diff, err = fx.store.ActivityDifference(fx.ctx(), fx.claims[fxAlice], fxWS, DifferenceQuery{
		RequestID: "r", Filter: ActivityFilterAll, Epoch: snap.Epoch, AfterWatermark: snap.Watermark})
	if err != nil {
		t.Fatal(err)
	}
	if diff.Status != 200 || diff.Difference == nil {
		t.Fatalf("expected difference, got %+v", diff)
	}
	d := diff.Difference
	// The first snapshot consumed 2 changes (row upsert + scope metadata),
	// the second burst adds a row change plus the metadata change: the
	// difference covers (after, current] exactly.
	if d.FromSeq != "3" || d.ToSeq != "4" {
		t.Fatalf("fromSeq/toSeq = %s/%s, want 3/4", d.FromSeq, d.ToSeq)
	}
	if len(d.Rows) != 1 || d.Rows[0]["rowId"] != fxGeneral || d.Rows[0]["latestActivitySeq"] != itoa(seq2) {
		t.Fatalf("difference rows = %+v", d.Rows)
	}
	if d.NextFromSeq != nil {
		t.Fatalf("nextFromSeq = %v, want null", *d.NextFromSeq)
	}
}

// TestActivitySnapshotRequired: epoch mismatch, watermark ahead of the scope
// and retention gaps answer 409 with the repair body — never a fabricated
// empty difference.
func TestActivitySnapshotRequired(t *testing.T) {
	fx := newFixture(t)
	fx.insertMessage(fxGeneral, fxBob, "one")
	snap, err := fx.store.ActivitySnapshot(fx.ctx(), fx.claims[fxAlice], fxWS, SnapshotQuery{RequestID: "r", Filter: ActivityFilterAll})
	if err != nil {
		t.Fatal(err)
	}
	// Wrong epoch.
	diff, err := fx.store.ActivityDifference(fx.ctx(), fx.claims[fxAlice], fxWS, DifferenceQuery{
		RequestID: "r", Filter: ActivityFilterAll, Epoch: "999", AfterWatermark: snap.Watermark})
	if err != nil {
		t.Fatal(err)
	}
	if diff.Status != 409 || diff.SnapshotRequired == nil || diff.SnapshotRequired.Epoch != "1" {
		t.Fatalf("wrong epoch = %+v", diff)
	}
	// Watermark ahead of the scope.
	diff, err = fx.store.ActivityDifference(fx.ctx(), fx.claims[fxAlice], fxWS, DifferenceQuery{
		RequestID: "r", Filter: ActivityFilterAll, Epoch: snap.Epoch, AfterWatermark: nextUint64(snap.Watermark)})
	if err != nil {
		t.Fatal(err)
	}
	if diff.Status != 409 {
		t.Fatalf("ahead watermark = %+v", diff)
	}
	// Retention gap: delete the oldest change and ask for it.
	fx.insertMessage(fxGeneral, fxBob, "two")
	if _, err := fx.store.ActivitySnapshot(fx.ctx(), fx.claims[fxAlice], fxWS, SnapshotQuery{RequestID: "r", Filter: ActivityFilterAll}); err != nil {
		t.Fatal(err)
	}
	if _, err := fx.db.Exec(`DELETE FROM activity_changes WHERE seq = 1`); err != nil {
		t.Fatal(err)
	}
	diff, err = fx.store.ActivityDifference(fx.ctx(), fx.claims[fxAlice], fxWS, DifferenceQuery{
		RequestID: "r", Filter: ActivityFilterAll, Epoch: "1", AfterWatermark: "0"})
	if err != nil {
		t.Fatal(err)
	}
	if diff.Status != 409 || diff.SnapshotRequired == nil {
		t.Fatalf("retention gap = %+v", diff)
	}
	// Wire values above the signed-64 storage domain cannot match any stored
	// epoch/watermark: repair signal, not an overflow.
	diff, err = fx.store.ActivityDifference(fx.ctx(), fx.claims[fxAlice], fxWS, DifferenceQuery{
		RequestID: "r", Filter: ActivityFilterAll,
		Epoch:          "9223372036854775808", // 2^63
		AfterWatermark: "0"})
	if err != nil {
		t.Fatal(err)
	}
	if diff.Status != 409 {
		t.Fatalf("2^63 epoch = %+v", diff)
	}
}

func nextUint64(decimal string) string {
	value, ok := parseUint64String(decimal)
	if !ok {
		return "0"
	}
	return formatUint64(value + 1)
}

// TestActivityTombstones: rows leaving the window tombstone with done first,
// deleted second, outOfWindow last.
func TestActivityTombstones(t *testing.T) {
	fx := newFixture(t)
	fx.insertMessage(fxGeneral, fxBob, "one")
	fx.insertMessage(fxSecret, fxBob, "two")
	snap, err := fx.store.ActivitySnapshot(fx.ctx(), fx.claims[fxAlice], fxWS, SnapshotQuery{RequestID: "r", Filter: ActivityFilterAll})
	if err != nil {
		t.Fatal(err)
	}
	// Done removes the row from the window -> tombstone reason done.
	if _, err := fx.store.DoneChannel(fx.ctx(), fx.claims[fxAlice], fxWS, fxSecret, DoneInput{}); err != nil {
		t.Fatal(err)
	}
	diff, err := fx.store.ActivityDifference(fx.ctx(), fx.claims[fxAlice], fxWS, DifferenceQuery{
		RequestID: "r", Filter: ActivityFilterAll, Epoch: snap.Epoch, AfterWatermark: snap.Watermark})
	if err != nil {
		t.Fatal(err)
	}
	if diff.Status != 200 || diff.Difference == nil {
		t.Fatalf("done difference = %+v", diff)
	}
	found := false
	for _, stone := range diff.Difference.Tombstones {
		if stone["rowId"] == fxSecret {
			found = true
			if stone["reason"] != "done" {
				t.Fatalf("reason = %v, want done", stone["reason"])
			}
		}
	}
	if !found {
		t.Fatalf("done tombstone missing: %+v", diff.Difference.Tombstones)
	}
	// A deleted channel tombstones with reason deleted.
	if _, err := fx.db.Exec(`UPDATE channels SET deleted_at = ? WHERE id = ?`, fx.clock.Now().UnixMilli(), fxGeneral); err != nil {
		t.Fatal(err)
	}
	snap2, err := fx.store.ActivitySnapshot(fx.ctx(), fx.claims[fxAlice], fxWS, SnapshotQuery{RequestID: "r", Filter: ActivityFilterAll})
	if err != nil {
		t.Fatal(err)
	}
	reasons := map[string]string{}
	for _, stone := range snap2.Window.Tombstones {
		if reason, ok := stone["reason"].(string); ok {
			reasons[stone["rowId"].(string)] = reason
		}
	}
	if reasons[fxGeneral] != "deleted" {
		t.Fatalf("deleted reason map = %+v", reasons)
	}
	if reasons[fxSecret] != "done" {
		t.Fatalf("done reason map = %+v", reasons)
	}
}

// TestActivityRowVersionSharedAcrossFilters: the same row carries the same
// rowVersion in every filter window (the principal authority is shared).
func TestActivityRowVersionSharedAcrossFilters(t *testing.T) {
	fx := newFixture(t)
	fx.insertMessage(fxGeneral, fxBob, "one")
	allSnap, err := fx.store.ActivitySnapshot(fx.ctx(), fx.claims[fxAlice], fxWS, SnapshotQuery{RequestID: "r", Filter: ActivityFilterAll})
	if err != nil {
		t.Fatal(err)
	}
	unreadSnap, err := fx.store.ActivitySnapshot(fx.ctx(), fx.claims[fxAlice], fxWS, SnapshotQuery{RequestID: "r", Filter: ActivityFilterUnread})
	if err != nil {
		t.Fatal(err)
	}
	var allVersion, unreadVersion string
	for _, row := range allSnap.Window.Rows {
		if row["rowId"] == fxGeneral {
			allVersion = row["rowVersion"].(string)
		}
	}
	for _, row := range unreadSnap.Window.Rows {
		if row["rowId"] == fxGeneral {
			unreadVersion = row["rowVersion"].(string)
		}
	}
	if allVersion == "" || allVersion != unreadVersion {
		t.Fatalf("rowVersion drifted across filters: %s vs %s", allVersion, unreadVersion)
	}
}

// TestActivityCrossScopeWatermark: one principal's watermark is meaningless
// for another (separate scope cursor) and answers 409.
func TestActivityCrossScopeWatermark(t *testing.T) {
	fx := newFixture(t)
	fx.insertMessage(fxGeneral, fxBob, "one")
	aliceSnap, err := fx.store.ActivitySnapshot(fx.ctx(), fx.claims[fxAlice], fxWS, SnapshotQuery{RequestID: "r", Filter: ActivityFilterAll})
	if err != nil {
		t.Fatal(err)
	}
	bobSnap, err := fx.store.ActivitySnapshot(fx.ctx(), fx.claims[fxBob], fxWS, SnapshotQuery{RequestID: "r", Filter: ActivityFilterAll})
	if err != nil {
		t.Fatal(err)
	}
	if aliceSnap.Watermark == bobSnap.Watermark && aliceSnap.Epoch == bobSnap.Epoch {
		t.Fatalf("scope cursors look shared: %s/%s", aliceSnap.Watermark, bobSnap.Watermark)
	}
	diff, err := fx.store.ActivityDifference(fx.ctx(), fx.claims[fxBob], fxWS, DifferenceQuery{
		RequestID: "r", Filter: ActivityFilterAll, Epoch: aliceSnap.Epoch, AfterWatermark: aliceSnap.Watermark})
	if err != nil {
		t.Fatal(err)
	}
	if diff.Status == 200 && diff.Difference != nil && diff.Difference.ToSeq == aliceSnap.Watermark {
		t.Fatalf("bob consumed alice's watermark: %+v", diff)
	}
}

// TestActivityRetentionRollover: exceeding the 2048-change retention rolls
// the epoch (old differences answer 409 snapshotRequired), never a hole.
func TestActivityRetentionRollover(t *testing.T) {
	fx := newFixture(t)
	fx.insertMessage(fxGeneral, fxBob, "seed")
	snap, err := fx.store.ActivitySnapshot(fx.ctx(), fx.claims[fxAlice], fxWS, SnapshotQuery{RequestID: "r", Filter: ActivityFilterAll})
	if err != nil {
		t.Fatal(err)
	}
	// Force the journal to the retention edge, then push one more change.
	// The first snapshot wrote seq 1..2; fill 3..2047 and pin the watermark.
	if _, err := fx.db.Exec(`INSERT INTO activity_changes
		(workspace_id, principal_id, filter, window_id, seq, row_id, row_version, kind, payload, tombstone_reason, created_at)
		SELECT ?, ?, 'all', 'main', seq, NULL, NULL, 'scope', NULL, NULL, ?
		FROM (WITH RECURSIVE cnt(x) AS (SELECT 3 UNION ALL SELECT x+1 FROM cnt WHERE x < 2047) SELECT x AS seq FROM cnt)`,
		fxWS, fxAlice, fx.clock.Now().UnixMilli()); err != nil {
		t.Fatalf("fill journal: %v", err)
	}
	if _, err := fx.db.Exec(`UPDATE activity_scopes SET watermark = 2047
		WHERE workspace_id = ? AND principal_id = ? AND filter = 'all'`, fxWS, fxAlice); err != nil {
		t.Fatal(err)
	}
	fx.insertMessage(fxGeneral, fxBob, "push over")
	rolled, err := fx.store.ActivitySnapshot(fx.ctx(), fx.claims[fxAlice], fxWS, SnapshotQuery{RequestID: "r", Filter: ActivityFilterAll})
	if err != nil {
		t.Fatal(err)
	}
	if rolled.Epoch == snap.Epoch {
		t.Fatalf("epoch did not roll: %s", rolled.Epoch)
	}
	if rolled.Watermark == "0" || rolled.Watermark == "2047" {
		t.Fatalf("rolled watermark = %s, want the fresh post-rollover count", rolled.Watermark)
	}
	var retained int
	if err := fx.db.QueryRow(`SELECT COUNT(*) FROM activity_changes
		WHERE workspace_id = ? AND principal_id = ? AND filter = 'all'`, fxWS, fxAlice).Scan(&retained); err != nil {
		t.Fatal(err)
	}
	if retained > ActivityRetention {
		t.Fatalf("retained %d changes after rollover", retained)
	}
	// The old epoch now answers snapshotRequired.
	diff, err := fx.store.ActivityDifference(fx.ctx(), fx.claims[fxAlice], fxWS, DifferenceQuery{
		RequestID: "r", Filter: ActivityFilterAll, Epoch: snap.Epoch, AfterWatermark: snap.Watermark})
	if err != nil {
		t.Fatal(err)
	}
	if diff.Status != 409 || diff.SnapshotRequired == nil || diff.SnapshotRequired.Epoch != rolled.Epoch {
		t.Fatalf("old-epoch difference = %+v", diff)
	}
}

// TestActivityPersistenceAcrossRestart: epoch/watermark/rows survive a store
// rebuild on the same database.
func TestActivityPersistenceAcrossRestart(t *testing.T) {
	path := filepath.Join(t.TempDir(), "restart.db")
	handle, err := platformdb.Open(path)
	if err != nil {
		t.Fatal(err)
	}
	applySchemaDraft(t, handle)
	channels := channel.NewStore(handle)
	store := NewStore(handle, channels)
	fixed := fxNow()
	store.SetClock(func() time.Time { return fixed })
	if _, err := handle.Exec(`INSERT INTO users (id, email, name, password_hash, email_verified, profile_setup_completed_at, created_at, updated_at)
		VALUES (?, ?, ?, 'x', 1, 1, 0, 0)`, fxAlice, "alice@example.test", "alice"); err != nil {
		t.Fatal(err)
	}
	if _, err := handle.Exec(`INSERT INTO session_families (id, user_id, created_at) VALUES (?, ?, 0)`, fxAlice+"f", fxAlice); err != nil {
		t.Fatal(err)
	}
	if _, err := handle.Exec(`INSERT INTO workspaces (id, name, slug, owner_id, created_at) VALUES (?, 'w', 'w', ?, 0)`, fxWS, fxAlice); err != nil {
		t.Fatal(err)
	}
	if _, err := handle.Exec(`INSERT INTO workspace_memberships (workspace_id, user_id, role, joined_at) VALUES (?, ?, 'owner', 0)`, fxWS, fxAlice); err != nil {
		t.Fatal(err)
	}
	if _, err := handle.Exec(`INSERT INTO channels (id, workspace_id, name, type, created_at) VALUES (?, ?, 'general', 'channel', 0)`, fxGeneral, fxWS); err != nil {
		t.Fatal(err)
	}
	if _, err := handle.Exec(`INSERT INTO messages (id, workspace_id, channel_id, sender_type, sender_id, content, message_type, request_digest, created_at)
		VALUES ('m1', ?, ?, 'user', ?, 'hello', 'chat', 'd', 1)`, fxWS, fxGeneral, fxBob); err != nil {
		t.Fatal(err)
	}
	claims := testClaims(fxAlice, fxAlice+"f", fixed)
	before, err := store.ActivitySnapshot(context.Background(), claims, fxWS, SnapshotQuery{RequestID: "r", Filter: ActivityFilterAll})
	if err != nil {
		t.Fatal(err)
	}
	if err := handle.Close(); err != nil {
		t.Fatal(err)
	}

	handle2, err := platformdb.Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer handle2.Close()
	applySchemaDraft(t, handle2)
	store2 := NewStore(handle2, channel.NewStore(handle2))
	store2.SetClock(func() time.Time { return fixed })
	diff, err := store2.ActivityDifference(context.Background(), claims, fxWS, DifferenceQuery{
		RequestID: "r", Filter: ActivityFilterAll, Epoch: before.Epoch, AfterWatermark: before.Watermark})
	if err != nil {
		t.Fatal(err)
	}
	if diff.Status != 200 || diff.NotModified == nil {
		t.Fatalf("restart lost the scope cursor: %+v", diff)
	}
	if diff.NotModified.Watermark != before.Watermark || diff.NotModified.Epoch != before.Epoch {
		t.Fatalf("restart watermark/epoch = %s/%s, want %s/%s",
			diff.NotModified.Watermark, diff.NotModified.Epoch, before.Watermark, before.Epoch)
	}
}

func fxNow() time.Time { return time.Date(2026, 10, 8, 12, 0, 0, 0, time.UTC) }

func timeNow() time.Time { return fxNow() }

func testClaims(userID, familyID string, at time.Time) auth.AccessTokenClaims {
	return auth.AccessTokenClaims{
		Subject:   userID,
		Type:      "access",
		FamilyID:  familyID,
		IssuedAt:  at,
		ExpiresAt: at.Add(15 * time.Minute),
	}
}
