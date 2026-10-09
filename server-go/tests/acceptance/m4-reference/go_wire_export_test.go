// M4 reference: in-process Go wire export (no TCP, no router, no live data).
//
// This test drives the REAL public store APIs of the message/readstate
// slices against an isolated migrated SQLite database in t.TempDir(), and
// prints ONE JSON document between markers on stdout. The Node-side
// reference verifier (go-wire-export.mjs) parses that document and compares
// it against the ORIGINAL TypeScript reducers/schemas actually executed —
// giving executable Go-vs-original evidence without inventing go-like
// samples. Parent's true-HTTP runs remain separate.
//
// Product surface used (exported, non-_test): platformdb.Open, channel.NewStoreWithOptions,
// message.NewStoreWithOptionsForTest / Create / AddReaction / RemoveReaction /
// ViewerSnapshot / ListReactionActors, readstate.NewStore / MarkRead /
// MarkUnread / MarkReadLatest / DoneChannel / ActivitySnapshot /
// ActivityDifference / UnreadCounts / UnreadSummary.
package m4reference

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"path/filepath"
	"testing"
	"time"

	"raft.local/server-go/internal/application/messaging"
	"raft.local/server-go/internal/auth"
	"raft.local/server-go/internal/channel"
	"raft.local/server-go/internal/message"
	"raft.local/server-go/internal/platform/clock"
	platformdb "raft.local/server-go/internal/platform/db"
	"raft.local/server-go/internal/readstate"
)

const (
	xsAlice = "11111111-1111-4111-8111-111111111111"
	xsBob   = "22222222-2222-4222-8222-222222222222"
	xsWS    = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
	xsChan  = "cccccccc-cccc-4ccc-8ccc-cccccccccc01"
)

func mustExec(t *testing.T, db *sql.DB, query string, args ...any) {
	t.Helper()
	if _, err := db.Exec(query, args...); err != nil {
		t.Fatalf("seed %q: %v", query, err)
	}
}

func exportClaims(t *testing.T, db *sql.DB, id string, nowMS int64, at time.Time) auth.AccessTokenClaims {
	t.Helper()
	family := id + "f"
	mustExec(t, db, `INSERT OR IGNORE INTO session_families (id, user_id, created_at) VALUES (?, ?, ?)`, family, id, nowMS)
	return auth.AccessTokenClaims{
		Subject: id, Type: "access", FamilyID: family,
		IssuedAt: at, ExpiresAt: at.Add(1 * time.Hour),
	}
}

// TestM4ReferenceExportGoWire prints the wire fixture between markers.
func TestM4ReferenceExportGoWire(t *testing.T) {
	ctx := context.Background()
	handle, err := platformdb.Open(filepath.Join(t.TempDir(), "raft.db"))
	if err != nil {
		t.Fatalf("open db: %v", err)
	}
	t.Cleanup(func() { _ = handle.Close() })

	start := time.Date(2026, 10, 8, 12, 0, 0, 0, time.UTC)
	nowMS := start.UnixMilli()
	mustExec(t, handle, `INSERT INTO users (id, email, name, display_name, password_hash, email_verified, profile_setup_completed_at, created_at, updated_at)
		VALUES (?, 'alice@example.test', 'alice', 'Alice', 'x', 1, ?, ?, ?)`, xsAlice, nowMS, nowMS, nowMS)
	mustExec(t, handle, `INSERT INTO users (id, email, name, display_name, password_hash, email_verified, profile_setup_completed_at, created_at, updated_at)
		VALUES (?, 'bob@example.test', 'bob', 'Bob', 'x', 1, ?, ?, ?)`, xsBob, nowMS, nowMS, nowMS)
	mustExec(t, handle, `INSERT INTO workspaces (id, name, slug, owner_id, created_at) VALUES (?, 'Export WS', 'export-ws', ?, ?)`, xsWS, xsAlice, nowMS)
	mustExec(t, handle, `INSERT INTO workspace_memberships (workspace_id, user_id, role, server_push_muted, joined_at) VALUES (?, ?, 'owner', 0, ?)`, xsWS, xsAlice, nowMS)
	mustExec(t, handle, `INSERT INTO workspace_memberships (workspace_id, user_id, role, server_push_muted, joined_at) VALUES (?, ?, 'member', 0, ?)`, xsWS, xsBob, nowMS)
	mustExec(t, handle, `INSERT INTO channels (id, workspace_id, name, type, created_at) VALUES (?, ?, 'general', 'channel', ?)`, xsChan, xsWS, nowMS)
	for _, u := range []string{xsAlice, xsBob} {
		mustExec(t, handle, `INSERT INTO channel_humans (channel_id, user_id, joined_at) VALUES (?, ?, ?)`, xsChan, u, nowMS)
	}

	aliceClaims := exportClaims(t, handle, xsAlice, nowMS, start)
	bobClaims := exportClaims(t, handle, xsBob, nowMS, start)

	fixed := &clock.Fixed{T: start}
	channelStore := channel.NewStoreWithOptions(handle, channel.Options{Clock: fixed})
	msgStore := message.NewStoreWithOptionsForTest(handle, channelStore, fixed)
	rsStore := readstate.NewStoreWithOptions(handle, channelStore, readstate.Options{Clock: func() time.Time { return fixed.T }})
	sendSvc, err := messaging.NewService(channelStore, msgStore, rsStore)
	if err != nil {
		t.Fatalf("messaging service: %v", err)
	}

	out := map[string]any{}
	step := func(ms int64) { fixed.T = fixed.T.Add(time.Duration(ms) * time.Millisecond) }

	// ---- 1. messages through the real create path (global AUTOINCREMENT seqs)
	type sentMsg struct {
		Seq  int64  `json:"seq"`
		ID   string `json:"id"`
		From string `json:"from"`
	}
	var msgs []sentMsg
	for i, from := range []string{xsBob, xsBob, xsBob} {
		step(10)
		claims := aliceClaims
		if from == xsBob {
			claims = bobClaims
		}
		res, err := sendSvc.SendHuman(ctx, claims, xsWS, message.CreateInput{
			ChannelID: xsChan,
			Content:   fmt.Sprintf("export message %d", i+1),
		})
		if err != nil {
			t.Fatalf("create message %d: %v", i+1, err)
		}
		msgs = append(msgs, sentMsg{Seq: res.Message.Seq, ID: res.Message.ID, From: from})
	}
	out["messages"] = msgs

	// ---- 2. reaction viewer-version stream (real Add/Remove + ViewerSnapshot)
	type viewerStep struct {
		Op            string   `json:"op"`
		Viewer        string   `json:"viewer"`
		Changed       bool     `json:"changed"`
		ViewerVersion int64    `json:"viewerVersion"`
		ReactedEmojis []string `json:"reactedEmojis"`
	}
	msg0 := msgs[0].ID
	var reactionStream []viewerStep
	doReaction := func(op string, viewer auth.AccessTokenClaims, add bool, emoji string) {
		t.Helper()
		var mut *message.ReactionMutation
		var err error
		if add {
			mut, err = msgStore.AddReaction(ctx, message.NewClaims(viewer), xsWS, msg0, emoji)
		} else {
			mut, err = msgStore.RemoveReaction(ctx, message.NewClaims(viewer), xsWS, msg0, emoji)
		}
		if err != nil {
			t.Fatalf("%s %s: %v", op, emoji, err)
		}
		snap, _, err := msgStore.ViewerSnapshot(ctx, message.NewClaims(viewer), xsWS, msg0)
		if err != nil {
			t.Fatalf("viewer snapshot after %s: %v", op, err)
		}
		reactionStream = append(reactionStream, viewerStep{
			Op: op, Viewer: viewer.Subject, Changed: mut.Changed,
			ViewerVersion: snap.ViewerVersion, ReactedEmojis: snap.ReactedEmojis,
		})
	}
	doReaction("add", aliceClaims, true, "👍")
	doReaction("remove", aliceClaims, false, "👍")
	doReaction("add", aliceClaims, true, "🎉")
	doReaction("add-idempotent", aliceClaims, true, "🎉")
	doReaction("add", bobClaims, true, "👍")
	doReaction("remove", aliceClaims, false, "🎉")
	doReaction("add", aliceClaims, true, "👍") // add/remove/add: version must keep rising
	out["reactionViewerVersionStream"] = reactionStream

	// discussion-version stream (ListReactionActors' guarded counter).
	type discussionStep struct {
		Op      string `json:"op"`
		Version int64  `json:"discussionVersion"`
	}
	var discussionStream []discussionStep
	captureDiscussion := func(op string) {
		t.Helper()
		page, err := msgStore.ListReactionActors(ctx, message.NewClaims(aliceClaims), xsWS, msg0, "👍", 50, "")
		if err != nil {
			t.Fatalf("list actors: %v", err)
		}
		discussionStream = append(discussionStream, discussionStep{Op: op, Version: page.DiscussionVersion})
	}
	discussionStream = append(discussionStream, discussionStep{Op: "initial"})
	captureDiscussion("after-bob-add")
	out["reactionDiscussionVersions"] = discussionStream

	// ---- 3. read stream (real MarkRead/MarkUnread/MarkReadLatest)
	type readStep struct {
		Op               string `json:"op"`
		MaxReadSeq       int64  `json:"maxReadSeq"`
		ReadStateVersion int64  `json:"readStateVersion"`
		Changed          bool   `json:"changed"`
		UnreadCount      *int64 `json:"unreadCount,omitempty"`
	}
	var readStream []readStep
	seq1, seq2, seq3 := msgs[0].Seq, msgs[1].Seq, msgs[2].Seq
	if s, err := rsStore.MarkRead(ctx, aliceClaims, xsWS, xsChan, seq2); err != nil {
		t.Fatalf("mark read: %v", err)
	} else {
		readStream = append(readStream, readStep{Op: "read-to-seq2", MaxReadSeq: s.MaxReadSeq, ReadStateVersion: s.ReadStateVersion, Changed: s.Changed})
	}
	if u, err := rsStore.MarkUnread(ctx, aliceClaims, xsWS, xsChan); err != nil {
		t.Fatalf("mark unread: %v", err)
	} else {
		uc := u.UnreadCount
		readStream = append(readStream, readStep{Op: "unread-rewind", MaxReadSeq: u.State.MaxReadSeq, ReadStateVersion: u.State.ReadStateVersion, Changed: u.State.Changed, UnreadCount: &uc})
	}
	if s, err := rsStore.MarkRead(ctx, aliceClaims, xsWS, xsChan, seq2); err != nil { // late lower read after rewind
		t.Fatalf("late read: %v", err)
	} else {
		readStream = append(readStream, readStep{Op: "late-read-seq2", MaxReadSeq: s.MaxReadSeq, ReadStateVersion: s.ReadStateVersion, Changed: s.Changed})
	}
	if r, err := rsStore.MarkReadLatest(ctx, aliceClaims, xsWS, xsChan); err != nil {
		t.Fatalf("read all: %v", err)
	} else {
		readStream = append(readStream, readStep{Op: "read-all", MaxReadSeq: r.State.MaxReadSeq, ReadStateVersion: r.State.ReadStateVersion, Changed: r.State.Changed})
	}
	_ = seq1
	_ = seq3
	out["readStateStream"] = readStream

	// ---- 4. Activity snapshot / difference / notModified (handler-shaped wire)
	snap, err := rsStore.ActivitySnapshot(ctx, aliceClaims, xsWS, readstate.SnapshotQuery{RequestID: "req-export-1", Filter: "all"})
	if err != nil {
		t.Fatalf("activity snapshot: %v", err)
	}
	out["activitySnapshot"] = activitySnapshotWire(snap)

	// One new message, then difference must return changes.
	step(10)
	if _, err := sendSvc.SendHuman(ctx, bobClaims, xsWS, message.CreateInput{ChannelID: xsChan, Content: "export message 4"}); err != nil {
		t.Fatalf("create message 4: %v", err)
	}
	diff, err := rsStore.ActivityDifference(ctx, aliceClaims, xsWS, readstate.DifferenceQuery{
		RequestID: "req-export-2", Filter: "all", Epoch: snap.Epoch, AfterWatermark: snap.Watermark,
	})
	if err != nil {
		t.Fatalf("activity difference: %v", err)
	}
	out["activityDifferenceAfterChange"] = activityDifferenceWire(diff)

	// Same parameters again: reconcile finds nothing new -> notModified.
	after := diff.Difference
	if after == nil {
		t.Fatal("expected a difference body after a new message")
	}
	diff2, err := rsStore.ActivityDifference(ctx, aliceClaims, xsWS, readstate.DifferenceQuery{
		RequestID: "req-export-3", Filter: "all", Epoch: snap.Epoch, AfterWatermark: after.ToSeq,
	})
	if err != nil {
		t.Fatalf("activity difference 2: %v", err)
	}
	out["activityNotModified"] = activityDifferenceWire(diff2)

	// Done the channel, then difference must carry the tombstone.
	if _, err := rsStore.DoneChannel(ctx, aliceClaims, xsWS, xsChan, readstate.DoneInput{ThroughPresent: false}); err != nil {
		t.Fatalf("done channel: %v", err)
	}
	snap2, err := rsStore.ActivitySnapshot(ctx, aliceClaims, xsWS, readstate.SnapshotQuery{RequestID: "req-export-4", Filter: "all"})
	if err != nil {
		t.Fatalf("activity snapshot 2: %v", err)
	}
	out["activitySnapshotAfterDone"] = activitySnapshotWire(snap2)
	if diff3, err := rsStore.ActivityDifference(ctx, aliceClaims, xsWS, readstate.DifferenceQuery{
		RequestID: "req-export-5", Filter: "all", Epoch: snap2.Epoch, AfterWatermark: snap2.Watermark,
	}); err != nil {
		t.Fatalf("activity difference 3: %v", err)
	} else {
		out["activityAfterDoneNotModified"] = activityDifferenceWire(diff3)
	}

	// ---- 5. unread surfaces (summary/count maps, handler-shaped)
	counts, err := rsStore.UnreadCounts(ctx, aliceClaims, xsWS)
	if err != nil {
		t.Fatalf("unread counts: %v", err)
	}
	plain := map[string]int64{}
	for k, v := range counts {
		plain[k] = v
	}
	out["unreadCounts"] = plain
	summary, err := rsStore.UnreadSummary(ctx, aliceClaims, xsWS)
	if err != nil {
		t.Fatalf("unread summary: %v", err)
	}
	summaryWire := map[string]any{}
	for scope, entry := range summary {
		summaryWire[scope] = map[string]any{
			"unreadCount":   entry.UnreadCount,
			"hasMention":    entry.HasMention,
			"hasAnyMention": entry.HasAnyMention,
		}
	}
	out["unreadSummary"] = summaryWire

	blob, err := json.Marshal(out)
	if err != nil {
		t.Fatalf("marshal export: %v", err)
	}
	fmt.Printf("M4REF_GO_WIRE_BEGIN%sM4REF_GO_WIRE_END\n", blob)
}

// activitySnapshotWire mirrors the m4_readstate_handlers ActivitySnapshot JSON shape.
func activitySnapshotWire(s *readstate.ActivitySnapshotResult) map[string]any {
	return map[string]any{
		"type": "snapshot", "requestId": s.RequestID, "scope": s.Scope,
		"epoch": s.Epoch, "watermark": s.Watermark, "activityVersion": s.ActivityVersion,
		"window": map[string]any{
			"rows": rowsOrEmpty(s.Window.Rows), "tombstones": tombstonesOrEmpty(s.Window.Tombstones),
			"nextCursor": s.Window.NextCursor, "hasMore": s.Window.HasMore,
			"complete": s.Window.Complete, "totalCount": s.Window.TotalCount,
			"totalUnreadCount": s.Window.TotalUnreadCount,
		},
	}
}

// activityDifferenceWire mirrors the handler's 200/409 shapes (snapshotRequired included).
func activityDifferenceWire(d *readstate.ActivityDifferenceResult) map[string]any {
	switch {
	case d.SnapshotRequired != nil:
		return map[string]any{
			"snapshotRequired": true,
			"scope":            d.SnapshotRequired.Scope, "epoch": d.SnapshotRequired.Epoch,
			"watermark": d.SnapshotRequired.Watermark, "activityVersion": d.SnapshotRequired.ActivityVersion,
		}
	case d.NotModified != nil:
		return map[string]any{
			"type": "notModified", "requestId": d.NotModified.RequestID,
			"scope": d.NotModified.Scope, "epoch": d.NotModified.Epoch,
			"watermark": d.NotModified.Watermark, "activityVersion": d.NotModified.ActivityVersion,
		}
	case d.Difference != nil:
		x := d.Difference
		return map[string]any{
			"type": "difference", "requestId": x.RequestID, "scope": x.Scope,
			"epoch": x.Epoch, "fromSeq": x.FromSeq, "toSeq": x.ToSeq, "activityVersion": x.ActivityVersion,
			"rows": rowsOrEmpty(x.Rows), "tombstones": tombstonesOrEmpty(x.Tombstones),
			"nextCursor": x.NextCursor, "hasMore": x.HasMore, "complete": x.Complete,
			"totalCount": x.TotalCount, "totalUnreadCount": x.TotalUnreadCount, "nextFromSeq": nil,
		}
	}
	return map[string]any{"status": d.Status, "unexpected": true}
}

func rowsOrEmpty(rows []map[string]any) []map[string]any {
	if rows == nil {
		return []map[string]any{}
	}
	return rows
}

func tombstonesOrEmpty(ts []map[string]any) []map[string]any {
	if ts == nil {
		return []map[string]any{}
	}
	return ts
}
