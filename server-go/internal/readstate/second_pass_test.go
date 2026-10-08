package readstate

import (
	"context"
	"database/sql"
	"encoding/json"
	"path/filepath"
	"testing"
	"time"

	"raft.local/server-go/internal/channel"
	platformdb "raft.local/server-go/internal/platform/db"
)

// seedSecondPassFixture seeds the minimal workspace rows the restart test
// needs on a raw handle (users/family/workspace/membership/channel).
func seedSecondPassFixture(t *testing.T, handle *sql.DB) {
	t.Helper()
	now := fxNow().UnixMilli()
	for _, u := range []struct{ id, name string }{{fxAlice, "alice"}, {fxBob, "bob"}} {
		if _, err := handle.Exec(`INSERT INTO users (id, email, name, display_name, password_hash,
			email_verified, profile_setup_completed_at, created_at, updated_at)
			VALUES (?, ?, ?, ?, 'x', 1, ?, ?, ?)`,
			u.id, u.name+"@sp.test", u.name, u.name, now, now, now); err != nil {
			t.Fatal(err)
		}
		if _, err := handle.Exec(`INSERT INTO session_families (id, user_id, created_at)
			VALUES (?, ?, ?)`, u.id+"f", u.id, now); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := handle.Exec(`INSERT INTO workspaces (id, name, slug, owner_id, created_at)
		VALUES (?, 'sp', 'sp', ?, ?)`, fxWS, fxAlice, now); err != nil {
		t.Fatal(err)
	}
	for _, m := range []struct{ user, role string }{{fxAlice, "owner"}, {fxBob, "member"}} {
		if _, err := handle.Exec(`INSERT INTO workspace_memberships (workspace_id, user_id, role, server_push_muted, joined_at)
			VALUES (?, ?, ?, 0, ?)`, fxWS, m.user, m.role, now); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := handle.Exec(`INSERT INTO channels (id, workspace_id, name, type, created_at)
		VALUES (?, ?, 'general', 'channel', ?)`, fxGeneral, fxWS, now); err != nil {
		t.Fatal(err)
	}
	if _, err := handle.Exec(`INSERT INTO channel_humans (channel_id, user_id, role, authority_revision, joined_at)
		VALUES (?, ?, 'member', 1, ?)`, fxGeneral, fxAlice, now); err != nil {
		t.Fatal(err)
	}
	if _, err := handle.Exec(`INSERT INTO channel_humans (channel_id, user_id, role, authority_revision, joined_at)
		VALUES (?, ?, 'member', 1, ?)`, fxGeneral, fxBob, now); err != nil {
		t.Fatal(err)
	}
}

func insertRawMessage(t *testing.T, handle *sql.DB, channelID, sender, content string) int64 {
	t.Helper()
	return insertRawMessageAt(t, handle, channelID, sender, content, fxNow().UnixMilli())
}

func insertRawMessageAt(t *testing.T, handle *sql.DB, channelID, sender, content string, atMS int64) int64 {
	t.Helper()
	res, err := handle.Exec(`INSERT INTO messages (id, workspace_id, channel_id, sender_type, sender_id,
		content, message_type, request_digest, created_at)
		VALUES (?, ?, ?, 'user', ?, ?, 'chat', 'd', ?)`,
		"sp-"+content, fxWS, channelID, sender, content, atMS)
	if err != nil {
		t.Fatal(err)
	}
	seq, err := res.LastInsertId()
	if err != nil {
		t.Fatal(err)
	}
	return seq
}

// TestMutedOrdinaryTrafficActivityVsCatchup freezes the parent's group-11
// repro against the ORIGINAL inboxPolicyModel.test.ts:1190-1245 semantics:
// a muted ordinary message creates no Activity fact (unread Inbox stays
// empty), stays channel catch-up unread, unmute never backfills it, a real
// read clears the catch-up, and everything survives a restart.
func TestMutedOrdinaryTrafficActivityVsCatchup(t *testing.T) {
	fx := newFixture(t)
	fx.insertMessage(fxGeneral, fxAlice, "read history one")
	fx.insertMessage(fxGeneral, fxBob, "old mention", fxAlice)

	// Bob fully reads the channel and his Inbox.
	if _, err := fx.store.MarkReadLatest(fx.ctx(), fx.claims[fxBob], fxWS, fxGeneral); err != nil {
		t.Fatal(err)
	}
	// Mute at H+1 (the route captures latest+1).
	muted, err := fx.store.SetNotificationSettings(fx.ctx(), fx.claims[fxBob], fxWS, fxGeneral, true)
	if err != nil {
		t.Fatal(err)
	}
	if muted.MuteFromSeq == nil || *muted.MuteFromSeq != 3 {
		t.Fatalf("mute boundary = %+v, want 3", muted.MuteFromSeq)
	}
	// Alice sends an ORDINARY new message while muted.
	fx.insertMessage(fxGeneral, fxAlice, "ordinary while muted")

	// Activity domain: unread Inbox is EMPTY (no fact, no unread count).
	unread, err := fx.store.InboxItems(fx.ctx(), fx.claims[fxBob], fxWS, InboxQuery{Filter: FilterUnread, Limit: 30})
	if err != nil {
		t.Fatal(err)
	}
	if unread.TotalCount != 0 || unread.TotalUnreadCount != 0 || len(unread.Items) != 0 {
		t.Fatalf("muted unread inbox = %+v", unread)
	}
	// The All row survives with the OLD promotion and Activity unread 0.
	all, err := fx.store.InboxItems(fx.ctx(), fx.claims[fxBob], fxWS, InboxQuery{Filter: FilterAll, Limit: 30})
	if err != nil {
		t.Fatal(err)
	}
	item := itemByScope(all.Items, fxGeneral)
	if item == nil {
		t.Fatalf("all feed lost the muted channel: %+v", all.Items)
	}
	if item.UnreadCount != 0 || item.FirstUnreadMessageID != nil {
		t.Fatalf("muted row must carry zero Activity unread: %+v", item)
	}
	// Channel catch-up domain: GET /channels/unread still reports 1.
	counts, err := fx.store.UnreadCounts(fx.ctx(), fx.claims[fxBob], fxWS)
	if err != nil {
		t.Fatal(err)
	}
	if counts[fxGeneral] != 1 {
		t.Fatalf("catch-up unread = %d, want 1", counts[fxGeneral])
	}

	// Unmute: no backfill of the suppressed fact.
	if _, err := fx.store.SetNotificationSettings(fx.ctx(), fx.claims[fxBob], fxWS, fxGeneral, false); err != nil {
		t.Fatal(err)
	}
	unread, err = fx.store.InboxItems(fx.ctx(), fx.claims[fxBob], fxWS, InboxQuery{Filter: FilterUnread, Limit: 30})
	if err != nil {
		t.Fatal(err)
	}
	if unread.TotalCount != 0 || unread.TotalUnreadCount != 0 {
		t.Fatalf("unmute backfilled suppressed facts: %+v", unread)
	}
	counts, err = fx.store.UnreadCounts(fx.ctx(), fx.claims[fxBob], fxWS)
	if err != nil {
		t.Fatal(err)
	}
	if counts[fxGeneral] != 1 {
		t.Fatalf("unmute consumed catch-up: %d", counts[fxGeneral])
	}

	// A NEW ordinary message after the unmute IS an eligible fact again.
	newSeq := fx.insertMessage(fxGeneral, fxAlice, "after unmute")
	unread, err = fx.store.InboxItems(fx.ctx(), fx.claims[fxBob], fxWS, InboxQuery{Filter: FilterUnread, Limit: 30})
	if err != nil {
		t.Fatal(err)
	}
	item = itemByScope(unread.Items, fxGeneral)
	if item == nil || item.UnreadCount != 1 || *item.LatestActivitySeq != newSeq {
		t.Fatalf("post-unmute fact missing: %+v", unread.Items)
	}

	// A real read clears the catch-up domain too.
	if _, err := fx.store.MarkReadLatest(fx.ctx(), fx.claims[fxBob], fxWS, fxGeneral); err != nil {
		t.Fatal(err)
	}
	counts, err = fx.store.UnreadCounts(fx.ctx(), fx.claims[fxBob], fxWS)
	if err != nil {
		t.Fatal(err)
	}
	if counts[fxGeneral] != 0 {
		t.Fatalf("read did not clear catch-up: %d", counts[fxGeneral])
	}
}

// TestMuteEpochsSurviveRestartAndEqualTimestamps: the suppressed range is
// seq-based, so equal millisecond timestamps around the mute and a process
// restart cannot change eligibility.
func TestMuteEpochsSurviveRestartAndEqualTimestamps(t *testing.T) {
	path := filepath.Join(t.TempDir(), "epochs.db")
	handle, err := platformdb.Open(path)
	if err != nil {
		t.Fatal(err)
	}
	applySchemaDraft(t, handle)
	fixed := fxNow()
	channels := channel.NewStore(handle)
	store := NewStore(handle, channels)
	store.SetClock(func() time.Time { return fixed })
	seedSecondPassFixture(t, handle)
	claims := testClaims(fxBob, fxBob+"f", fixed)

	first := insertRawMessage(t, handle, fxGeneral, fxAlice, "one")
	// Bob is fully read BEFORE muting (the repro's shape): everything that
	// arrives later while muted is suppressed, and only post-unmute traffic
	// re-enters the Activity unread window.
	if _, err := store.MarkReadLatest(context.Background(), claims, fxWS, fxGeneral); err != nil {
		t.Fatal(err)
	}
	if _, err := store.SetNotificationSettings(context.Background(), claims, fxWS, fxGeneral, true); err != nil {
		t.Fatal(err)
	}
	// Two messages with IDENTICAL timestamps: one before-mute-boundary? No —
	// both after the boundary; both must stay suppressed forever.
	m1 := insertRawMessageAt(t, handle, fxGeneral, fxAlice, "same-ms-a", fixed.UnixMilli())
	m2 := insertRawMessageAt(t, handle, fxGeneral, fxAlice, "same-ms-b", fixed.UnixMilli())
	if m1 == m2 {
		t.Fatalf("expected distinct seqs")
	}
	if _, err := store.SetNotificationSettings(context.Background(), claims, fxWS, fxGeneral, false); err != nil {
		t.Fatal(err)
	}
	after := insertRawMessage(t, handle, fxGeneral, fxAlice, "after unmute")

	unread, err := store.InboxItems(context.Background(), claims, fxWS, InboxQuery{Filter: FilterUnread, Limit: 30})
	if err != nil {
		t.Fatal(err)
	}
	item := itemByScope(unread.Items, fxGeneral)
	if item == nil || item.UnreadCount != 1 || *item.LatestActivitySeq != after {
		t.Fatalf("post-unmute eligibility wrong: %+v (suppressed same-ms pair must not resurrect)", unread.Items)
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
	unread2, err := store2.InboxItems(context.Background(), claims, fxWS, InboxQuery{Filter: FilterUnread, Limit: 30})
	if err != nil {
		t.Fatal(err)
	}
	item2 := itemByScope(unread2.Items, fxGeneral)
	if item2 == nil || item2.UnreadCount != 1 || *item2.LatestActivitySeq != after {
		t.Fatalf("restart changed eligibility: %+v", unread2.Items)
	}
	_ = first
}

// TestMarkUnreadCountsRealMessages: A1 — the global AUTOINCREMENT seq is
// shared across channels; unread must COUNT this channel's real messages,
// never subtract seqs.
func TestMarkUnreadCountsRealMessages(t *testing.T) {
	fx := newFixture(t)
	// Occupy the low seq space with messages in OTHER channels.
	fx.insertMessage(fxSecret, fxAlice, "gap filler 1")
	fx.insertMessage(fxSecret, fxAlice, "gap filler 2")
	fx.insertMessage(fxSecret, fxAlice, "gap filler 3")
	fx.insertMessage(fxDM, fxAlice, "gap filler 4")
	// Two real messages in the target channel at high global seqs.
	first := fx.insertMessage(fxGeneral, fxBob, "target one")
	second := fx.insertMessage(fxGeneral, fxBob, "target two")
	if first <= 4 {
		t.Fatalf("expected the target channel to sit at high global seqs, got %d", first)
	}

	if _, err := fx.store.MarkReadLatest(fx.ctx(), fx.claims[fxAlice], fxWS, fxGeneral); err != nil {
		t.Fatal(err)
	}
	result, err := fx.store.MarkUnread(fx.ctx(), fx.claims[fxAlice], fxWS, fxGeneral)
	if err != nil {
		t.Fatal(err)
	}
	if result.UnreadCount != 1 {
		t.Fatalf("unreadCount = %d (seq arithmetic would report ~%d), want 1",
			result.UnreadCount, second)
	}
	// Cross-check against the COUNT-based unread exit.
	counts, err := fx.store.UnreadCounts(fx.ctx(), fx.claims[fxAlice], fxWS)
	if err != nil {
		t.Fatal(err)
	}
	if counts[fxGeneral] != 1 {
		t.Fatalf("map unread = %d, want 1 (domains must agree)", counts[fxGeneral])
	}
}

// TestResidueReadAllNeverTouchesPrivateHighWater: A2 — after losing a
// private channel, read-all keeps the caller's cursor EXACTLY as stored and
// never reads or returns the channel's current high-water.
func TestResidueReadAllNeverTouchesPrivateHighWater(t *testing.T) {
	fx := newFixture(t)
	first := fx.insertMessage(fxSecret, fxBob, "while member")
	if _, err := fx.store.MarkRead(fx.ctx(), fx.claims[fxBob], fxWS, fxSecret, first); err != nil {
		t.Fatal(err)
	}
	storedRead, storedVersion, _ := fx.readStateRow(fxBob, fxSecret)

	if _, err := fx.db.Exec(`DELETE FROM channel_humans WHERE channel_id = ? AND user_id = ?`, fxSecret, fxBob); err != nil {
		t.Fatal(err)
	}
	// New private messages the caller must learn nothing about.
	fx.insertMessage(fxSecret, fxAlice, "after removal one")
	fx.insertMessage(fxSecret, fxAlice, "after removal two")

	result, err := fx.store.MarkReadLatest(fx.ctx(), fx.claims[fxBob], fxWS, fxSecret)
	if err != nil {
		t.Fatal(err)
	}
	if !result.ResidueOnly {
		t.Fatal("expected residue-only receipt")
	}
	if result.State.Changed {
		t.Fatal("residue retire must not report a change")
	}
	if result.State.MaxReadSeq != storedRead || result.State.ReadStateVersion != storedVersion {
		t.Fatalf("residue receipt leaked the live frontier: %+v", result.State)
	}
	afterRead, afterVersion, _ := fx.readStateRow(fxBob, fxSecret)
	if afterRead != storedRead || afterVersion != storedVersion {
		t.Fatalf("cursor moved on residue retire: (%d,%d) -> (%d,%d)",
			storedRead, storedVersion, afterRead, afterVersion)
	}
}

// TestActivityDifferenceDeterministicOrder: A3 — the same state reached
// through the same steps produces byte-identical difference bodies (rows by
// lastActivityAt desc/rowId asc, tombstones by rowId asc).
func TestActivityDifferenceDeterministicOrder(t *testing.T) {
	run := func() string {
		fx := newFixture(t)
		fx.seedThreadParents()
		fx.insertMessage(fxGeneral, fxBob, "one")
		fx.insertMessage(fxSecret, fxBob, "two")
		fx.follow(fxAlice, fxThread, false)
		fx.insertMessage(fxThread, fxBob, "reply")
		snap, err := fx.store.ActivitySnapshot(fx.ctx(), fx.claims[fxAlice], fxWS, SnapshotQuery{RequestID: "r", Filter: ActivityFilterAll})
		if err != nil {
			t.Fatal(err)
		}
		if _, err := fx.store.DoneChannel(fx.ctx(), fx.claims[fxAlice], fxWS, fxSecret, DoneInput{}); err != nil {
			t.Fatal(err)
		}
		diff, err := fx.store.ActivityDifference(fx.ctx(), fx.claims[fxAlice], fxWS, DifferenceQuery{
			RequestID: "r", Filter: ActivityFilterAll, Epoch: snap.Epoch, AfterWatermark: snap.Watermark})
		if err != nil {
			t.Fatal(err)
		}
		if diff.Status != 200 || diff.Difference == nil {
			t.Fatalf("difference failed: %+v", diff)
		}
		buf, err := json.Marshal(map[string]any{
			"rows":       diff.Difference.Rows,
			"tombstones": diff.Difference.Tombstones,
		})
		if err != nil {
			t.Fatal(err)
		}
		// Comparator assertion: rows ordered by lastActivityAt desc, rowId asc.
		rows := diff.Difference.Rows
		for i := 1; i < len(rows); i++ {
			prevAt, _ := rows[i-1]["lastActivityAt"].(string)
			curAt, _ := rows[i]["lastActivityAt"].(string)
			prevID, _ := rows[i-1]["rowId"].(string)
			curID, _ := rows[i]["rowId"].(string)
			if prevAt < curAt || (prevAt == curAt && prevID > curID) {
				t.Fatalf("rows misordered at %d: %v/%v", i, prevAt, curAt)
			}
		}
		stones := diff.Difference.Tombstones
		for i := 1; i < len(stones); i++ {
			prevID, _ := stones[i-1]["rowId"].(string)
			curID, _ := stones[i]["rowId"].(string)
			if prevID > curID {
				t.Fatalf("tombstones misordered at %d", i)
			}
		}
		return string(buf)
	}
	firstRun := run()
	for i := 0; i < 6; i++ {
		if again := run(); again != firstRun {
			t.Fatalf("difference body not deterministic (run %d):\n%s\nvs\n%s", i, firstRun, again)
		}
	}
}

// TestAnnouncementDefaultMuteInProjections: A5 — announcement channels with
// no explicit mute row suppress ordinary Activity promotion AND unread (the
// legacy ANNOUNCEMENT_DEFAULT_MUTE, boundary 0); a personal mention pierces;
// an explicit unmute restores ordinary eligibility going forward.
func TestAnnouncementDefaultMuteInProjections(t *testing.T) {
	fx := newFixture(t)
	now := fx.clock.Now().UnixMilli()
	if _, err := fx.db.Exec(`INSERT INTO channels (id, workspace_id, name, type, system_kind, created_at)
		VALUES (?, ?, 'announce', 'channel', 'announcement', ?)`, "cccccccc-cccc-4ccc-8ccc-cccccccccc10", fxWS, now); err != nil {
		t.Fatal(err)
	}
	announce := "cccccccc-cccc-4ccc-8ccc-cccccccccc10"
	if _, err := fx.db.Exec(`INSERT INTO channel_humans (channel_id, user_id, role, authority_revision, joined_at)
		VALUES (?, ?, 'member', 1, ?)`, announce, fxAlice, now); err != nil {
		t.Fatal(err)
	}
	fx.insertMessage(announce, fxBob, "hourly post one")
	fx.insertMessage(announce, fxBob, "hourly post two")

	// GET settings synthesizes the legacy default WITH boundary 0.
	state, err := fx.store.NotificationSettings(fx.ctx(), fx.claims[fxAlice], fxWS, announce)
	if err != nil {
		t.Fatal(err)
	}
	if !state.ActivityMuted || state.MuteFromSeq == nil || *state.MuteFromSeq != 0 {
		t.Fatalf("announcement default = %+v, want {muted, boundary 0}", state)
	}

	all, err := fx.store.InboxItems(fx.ctx(), fx.claims[fxAlice], fxWS, InboxQuery{Filter: FilterAll, Limit: 30})
	if err != nil {
		t.Fatal(err)
	}
	if itemByScope(all.Items, announce) != nil {
		t.Fatalf("ordinary announcement traffic promoted into Activity: %+v", all.Items)
	}
	unread, err := fx.store.InboxItems(fx.ctx(), fx.claims[fxAlice], fxWS, InboxQuery{Filter: FilterUnread, Limit: 30})
	if err != nil {
		t.Fatal(err)
	}
	if itemByScope(unread.Items, announce) != nil {
		t.Fatalf("announcement counted as Activity unread: %+v", unread.Items)
	}
	// A personal mention pierces the default mute.
	fx.insertMessage(announce, fxBob, "ping", fxAlice)
	all, err = fx.store.InboxItems(fx.ctx(), fx.claims[fxAlice], fxWS, InboxQuery{Filter: FilterAll, Limit: 30})
	if err != nil {
		t.Fatal(err)
	}
	if itemByScope(all.Items, announce) == nil {
		t.Fatal("announcement mention must pierce the default mute")
	}

	// Explicit unmute: ordinary traffic is eligible again going forward, and
	// the previously suppressed posts are NOT backfilled.
	if _, err := fx.store.SetNotificationSettings(fx.ctx(), fx.claims[fxAlice], fxWS, announce, false); err != nil {
		t.Fatal(err)
	}
	unread, err = fx.store.InboxItems(fx.ctx(), fx.claims[fxAlice], fxWS, InboxQuery{Filter: FilterUnread, Limit: 30})
	if err != nil {
		t.Fatal(err)
	}
	item := itemByScope(unread.Items, announce)
	if item == nil || item.UnreadCount != 1 {
		t.Fatalf("post-unmute announcement unread = %+v, want exactly the mention", item)
	}
	fx.insertMessage(announce, fxBob, "ordinary after unmute")
	unread, err = fx.store.InboxItems(fx.ctx(), fx.claims[fxAlice], fxWS, InboxQuery{Filter: FilterUnread, Limit: 30})
	if err != nil {
		t.Fatal(err)
	}
	item = itemByScope(unread.Items, announce)
	if item == nil || item.UnreadCount != 2 {
		t.Fatalf("post-unmute ordinary traffic must count: %+v", item)
	}
}

// TestDoneHistoryExcludesRevivedRows: A8 — once new activity moves past the
// Done frontier, the row returns to the active Inbox and LEAVES the Done
// history (no duplicate listing).
func TestDoneHistoryExcludesRevivedRows(t *testing.T) {
	fx := newFixture(t)
	seq := fx.insertMessage(fxGeneral, fxBob, "one")
	if _, err := fx.store.DoneChannel(fx.ctx(), fx.claims[fxAlice], fxWS, fxGeneral,
		DoneInput{ThroughPresent: true, Through: strPtr(itoa(seq))}); err != nil {
		t.Fatal(err)
	}
	done, err := fx.store.DoneInboxItems(fx.ctx(), fx.claims[fxAlice], fxWS, InboxQuery{Limit: 30})
	if err != nil {
		t.Fatal(err)
	}
	if len(done.Items) != 1 {
		t.Fatalf("done history = %+v", done.Items)
	}
	fx.insertMessage(fxGeneral, fxBob, "reviving message")
	done, err = fx.store.DoneInboxItems(fx.ctx(), fx.claims[fxAlice], fxWS, InboxQuery{Limit: 30})
	if err != nil {
		t.Fatal(err)
	}
	if len(done.Items) != 0 {
		t.Fatalf("revived row still listed as Done: %+v", done.Items)
	}
	all, err := fx.store.InboxItems(fx.ctx(), fx.claims[fxAlice], fxWS, InboxQuery{Filter: FilterAll, Limit: 30})
	if err != nil {
		t.Fatal(err)
	}
	if itemByScope(all.Items, fxGeneral) == nil {
		t.Fatal("revived row missing from the active Inbox")
	}
}

// TestInboxReadAllSkipsInaccessibleThreadParents: A11 — a followed thread
// whose private parent the caller lost is NOT part of the authorized set of
// inbox read-all: no cursor write, no scope in the response.
func TestInboxReadAllSkipsInaccessibleThreadParents(t *testing.T) {
	fx := newFixture(t)
	fx.seedThreadParents()
	// Move parent two into the private channel; bob follows the thread.
	if _, err := fx.db.Exec(`UPDATE messages SET channel_id = ? WHERE id = ?`, fxSecret, fxParent2); err != nil {
		t.Fatal(err)
	}
	fx.follow(fxBob, fxThread2, false)
	fx.insertMessage(fxThread2, fxAlice, "reply")
	// Bob loses the private parent.
	if _, err := fx.db.Exec(`DELETE FROM channel_humans WHERE channel_id = ? AND user_id = ?`, fxSecret, fxBob); err != nil {
		t.Fatal(err)
	}

	result, err := fx.store.MarkInboxReadLatest(fx.ctx(), fx.claims[fxBob], fxWS)
	if err != nil {
		t.Fatal(err)
	}
	for _, scope := range result.Scopes {
		if scope.ChannelID == fxThread2 {
			t.Fatalf("inaccessible thread marked read: %+v", result.Scopes)
		}
	}
	if _, _, present := fx.readStateRow(fxBob, fxThread2); present {
		t.Fatal("inaccessible thread received a cursor row")
	}
}

// TestUnreadSummaryMentionsHonorDoneSuppression: A12 — a scope Done up to
// its frontier reports no unread/any mention in the summary, and the durable
// mention boundary caps Done'd mentions.
func TestUnreadSummaryMentionsHonorDoneSuppression(t *testing.T) {
	fx := newFixture(t)
	mentionSeq := fx.insertMessage(fxGeneral, fxBob, "with mention", fxAlice)
	if _, err := fx.store.DoneChannel(fx.ctx(), fx.claims[fxAlice], fxWS, fxGeneral,
		DoneInput{ThroughPresent: true, Through: strPtr(itoa(mentionSeq))}); err != nil {
		t.Fatal(err)
	}
	summary, err := fx.store.UnreadSummary(fx.ctx(), fx.claims[fxAlice], fxWS)
	if err != nil {
		t.Fatal(err)
	}
	if len(summary) != 0 {
		t.Fatalf("Done-to-latest scope still summarized: %+v", summary)
	}
	// A NEW mention beyond the frontier resurrects the mention fact.
	fx.insertMessage(fxGeneral, fxBob, "fresh mention", fxAlice)
	summary, err = fx.store.UnreadSummary(fx.ctx(), fx.claims[fxAlice], fxWS)
	if err != nil {
		t.Fatal(err)
	}
	entry := summary[fxGeneral]
	if !entry.HasMention {
		t.Fatalf("post-frontier mention missing from summary: %+v", entry)
	}
}

// TestTombstoneReasonReadAdvanceIsOutOfWindow: D1 — a row that leaves the
// unread window because the caller READ (not Done'd) must tombstone as
// outOfWindow, never done.
func TestTombstoneReasonReadAdvanceIsOutOfWindow(t *testing.T) {
	fx := newFixture(t)
	fx.insertMessage(fxGeneral, fxBob, "one")
	fx.insertMessage(fxSecret, fxBob, "two")
	snap, err := fx.store.ActivitySnapshot(fx.ctx(), fx.claims[fxAlice], fxWS, SnapshotQuery{RequestID: "r", Filter: ActivityFilterUnread})
	if err != nil {
		t.Fatal(err)
	}
	// Reading general fully removes it from the unread window.
	if _, err := fx.store.MarkReadLatest(fx.ctx(), fx.claims[fxAlice], fxWS, fxGeneral); err != nil {
		t.Fatal(err)
	}
	diff, err := fx.store.ActivityDifference(fx.ctx(), fx.claims[fxAlice], fxWS, DifferenceQuery{
		RequestID: "r", Filter: ActivityFilterUnread, Epoch: snap.Epoch, AfterWatermark: snap.Watermark})
	if err != nil {
		t.Fatal(err)
	}
	if diff.Status != 200 || diff.Difference == nil {
		t.Fatalf("difference = %+v", diff)
	}
	for _, stone := range diff.Difference.Tombstones {
		if stone["rowId"] == fxGeneral && stone["reason"] != "outOfWindow" {
			t.Fatalf("read-advanced row tombstoned as %v, want outOfWindow", stone["reason"])
		}
	}
	found := false
	for _, stone := range diff.Difference.Tombstones {
		if stone["rowId"] == fxGeneral {
			found = true
		}
	}
	if !found {
		t.Fatalf("general tombstone missing: %+v", diff.Difference.Tombstones)
	}
}

// TestMentionOnlyRowsCarryAnyMention: A4 evidence lock — the non-member
// public mention rows set AnyMention so the Mentions filter keeps them.
func TestMentionOnlyRowsCarryAnyMention(t *testing.T) {
	fx := newFixture(t)
	if _, err := fx.db.Exec(`DELETE FROM channel_humans WHERE channel_id = ? AND user_id = ?`, fxGeneral, fxBob); err != nil {
		t.Fatal(err)
	}
	fx.insertMessage(fxGeneral, fxAlice, "hey bob", fxBob)
	mentions, err := fx.store.InboxItems(fx.ctx(), fx.claims[fxBob], fxWS, InboxQuery{Filter: FilterMentions, Limit: 30})
	if err != nil {
		t.Fatal(err)
	}
	if mentions.TotalCount != 1 || !mentions.Items[0].AnyMention || !mentions.Items[0].mentionOnly {
		t.Fatalf("mention-only row lost its AnyMention fact: %+v", mentions.Items)
	}
}

// TestMuteEpochsSameClockTripleToggle: three mute/unmute toggles inside ONE
// fixed-clock millisecond key epochs by prefs_version (never muted_at), the
// partial unique index admits at most one open epoch, and two receivers'
// epochs stay independent.
func TestMuteEpochsSameClockTripleToggle(t *testing.T) {
	fx := newFixture(t)
	seq1 := fx.insertMessage(fxGeneral, fxBob, "one")
	// Same-clock interleaving: distinct seqs, identical timestamps.
	fixedMS := fx.clock.Now().UnixMilli()
	mA := fx.insertMessage(fxGeneral, fxBob, "same-ms-a")
	fx.clock.Advance(-10 * time.Millisecond) // restore the same ms
	_ = fixedMS
	mB := fx.insertMessage(fxGeneral, fxBob, "same-ms-b")
	if mA == mB {
		t.Fatalf("distinct seqs expected")
	}

	// Triple toggle on one receiver with the clock FROZEN (muted_at identical).
	for i := 0; i < 3; i++ {
		if _, err := fx.store.SetNotificationSettings(fx.ctx(), fx.claims[fxAlice], fxWS, fxGeneral, true); err != nil {
			t.Fatalf("toggle %d mute: %v", i, err)
		}
		if _, err := fx.store.SetNotificationSettings(fx.ctx(), fx.claims[fxAlice], fxWS, fxGeneral, false); err != nil {
			t.Fatalf("toggle %d unmute: %v", i, err)
		}
	}
	var epochs int
	if err := fx.db.QueryRow(`SELECT COUNT(*) FROM user_channel_mute_epochs
		WHERE workspace_id = ? AND user_id = ? AND channel_id = ?`,
		fxWS, fxAlice, fxGeneral).Scan(&epochs); err != nil {
		t.Fatal(err)
	}
	if epochs != 3 {
		t.Fatalf("same-clock triple toggle produced %d epochs, want 3", epochs)
	}
	var openEpochs int
	if err := fx.db.QueryRow(`SELECT COUNT(*) FROM user_channel_mute_epochs
		WHERE workspace_id = ? AND user_id = ? AND channel_id = ? AND suppressed_through_seq IS NULL`,
		fxWS, fxAlice, fxGeneral).Scan(&openEpochs); err != nil {
		t.Fatal(err)
	}
	if openEpochs != 0 {
		t.Fatalf("open epochs after final unmute = %d", openEpochs)
	}
	// A second receiver's epochs are fully independent.
	if _, err := fx.store.SetNotificationSettings(fx.ctx(), fx.claims[fxBob], fxWS, fxGeneral, true); err != nil {
		t.Fatal(err)
	}
	var bobEpochs int
	if err := fx.db.QueryRow(`SELECT COUNT(*) FROM user_channel_mute_epochs
		WHERE workspace_id = ? AND user_id = ? AND channel_id = ?`,
		fxWS, fxBob, fxGeneral).Scan(&bobEpochs); err != nil {
		t.Fatal(err)
	}
	if bobEpochs != 1 {
		t.Fatalf("second receiver epochs = %d", bobEpochs)
	}
	// The partial unique index refuses a SECOND open epoch on direct write:
	// open one through the real path first.
	if _, err := fx.store.SetNotificationSettings(fx.ctx(), fx.claims[fxAlice], fxWS, fxGeneral, true); err != nil {
		t.Fatal(err)
	}
	if _, err := fx.db.Exec(`INSERT INTO user_channel_mute_epochs
		(workspace_id, user_id, channel_id, epoch_version, mute_from_seq, suppressed_through_seq, muted_at)
		VALUES (?, ?, ?, 99, 0, NULL, 0)`, fxWS, fxAlice, fxGeneral); err == nil {
		t.Fatal("duplicate open epoch accepted")
	}
	_ = seq1
}
