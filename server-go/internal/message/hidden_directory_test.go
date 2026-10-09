package message

import (
	"context"
	"database/sql"
	"testing"

	"raft.local/server-go/internal/channel"
	"raft.local/server-go/internal/platform/db"
)

func withTx(f *fixture, fn func(tx *sql.Tx) error) error {
	return db.WithWriteTx(context.Background(), f.db, fn)
}

// TestReactionActorsHiddenDirectoryPolicy ports the exact original rules:
// when the workspace hides its human directory from member-role requesters,
// an #all-directory scope (the #all channel itself or a thread rooted in
// #all) exposes only the requester plus community-server owner/admins; other
// scopes and owner/admin requesters keep the full roster.
func TestReactionActorsHiddenDirectoryPolicy(t *testing.T) {
	f := newFixture(t)
	f.seed()
	// Hide the human directory from member-role requesters.
	if _, err := f.db.Exec(`UPDATE workspaces SET hide_humans_from_members = 1 WHERE id = ?`, txWS); err != nil {
		t.Fatal(err)
	}
	// The implicit-roster #all channel carries messages from three humans.
	all := "abababab-0000-4000-8000-00000000a11a"
	now := f.clock.Now().UnixMilli()
	if _, err := f.db.Exec(`INSERT INTO channels (id, workspace_id, name, type, system_kind, created_at)
		VALUES (?, ?, 'all', 'channel', 'all', ?)`, all, txWS, now); err != nil {
		t.Fatal(err)
	}
	// System-channel posting and directory projection both use implicit
	// workspace membership; do not seed artificial channel roster rows.
	msg := f.sendMsg(t, all, "root")
	if _, err := f.store.AddReaction(context.Background(), NewClaims(claimsFor(txAlice, txFamAlice)), txWS, msg.ID, "👍"); err != nil {
		t.Fatal(err)
	}
	for _, u := range []struct{ user, family string }{
		{txBob, txFamBob}, {txCara, txFamCara},
	} {
		if _, err := f.store.AddReaction(context.Background(), NewClaims(claimsFor(u.user, u.family)), txWS, msg.ID, "👍"); err != nil {
			t.Fatal(err)
		}
	}
	alice := NewClaims(claimsFor(txAlice, txFamAlice))

	// Member-role requester (bob) in the #all scope: only himself; alice and
	// cara are filtered (this workspace is not "community").
	page, err := f.store.ListReactionActors(context.Background(), NewClaims(claimsFor(txBob, txFamBob)), txWS, msg.ID, "👍", 50, "")
	if err != nil {
		t.Fatal(err)
	}
	if len(page.Actors) != 1 || page.Actors[0].ActorID != txBob {
		t.Fatalf("hidden directory must filter to the requester: %+v", page.Actors)
	}

	// The SAME requester sees the full roster on a normal channel scope.
	f.seedChannel(txGeneral, "general", channel.TypeChannel, txAlice, txBob, txCara)
	normalMsg := f.sendMsg(t, txGeneral, "normal")
	for _, u := range []struct{ user, family string }{
		{txAlice, txFamAlice}, {txCara, txFamCara},
	} {
		if _, err := f.store.AddReaction(context.Background(), NewClaims(claimsFor(u.user, u.family)), txWS, normalMsg.ID, "👍"); err != nil {
			t.Fatal(err)
		}
	}
	page, err = f.store.ListReactionActors(context.Background(), NewClaims(claimsFor(txBob, txFamBob)), txWS, normalMsg.ID, "👍", 50, "")
	if err != nil {
		t.Fatal(err)
	}
	if len(page.Actors) != 2 {
		t.Fatalf("non-#all scope keeps the full roster: %+v", page.Actors)
	}

	// Owner-role requester is never subject to the hidden directory: the
	// full reactor set (bob + cara) stays visible.
	page, err = f.store.ListReactionActors(context.Background(), alice, txWS, msg.ID, "👍", 50, "")
	if err != nil {
		t.Fatal(err)
	}
	if len(page.Actors) != 3 {
		t.Fatalf("owner sees every actor in the #all scope: %+v", page.Actors)
	}

	// A community workspace exposes owner/admin humans even to members.
	if _, err := f.db.Exec(`UPDATE workspaces SET slug = 'community' WHERE id = ?`, txWS); err != nil {
		t.Fatal(err)
	}
	page, err = f.store.ListReactionActors(context.Background(), NewClaims(claimsFor(txBob, txFamBob)), txWS, msg.ID, "👍", 50, "")
	if err != nil {
		t.Fatal(err)
	}
	ids := map[string]bool{}
	for _, a := range page.Actors {
		ids[a.ActorID] = true
	}
	// bob (member self) + alice (community owner) become visible; cara stays hidden.
	if len(page.Actors) != 2 || !ids[txBob] || !ids[txAlice] || ids[txCara] {
		t.Fatalf("community workspace exposes member self + owner/admin: %+v", page.Actors)
	}
}

// TestThreadSummaryUnreadUsesRealCursor drives the 0011 read cursor: a
// follower with last_read_seq=N only counts thread rows above N.
func TestThreadSummaryUnreadUsesRealCursor(t *testing.T) {
	f := newFixture(t)
	f.seed()
	f.seedChannel(txGeneral, "general", channel.TypeChannel, txAlice, txBob)

	parent := f.sendMsg(t, txGeneral, "root")
	var threadID string
	if err := withTx(f, func(tx *sql.Tx) error {
		thread, err := f.channels.EnsureThreadTx(context.Background(), tx, txWS, txGeneral, parent.ID, txAlice)
		threadID = thread.ID
		return err
	}); err != nil {
		t.Fatal(err)
	}
	replies := f.seedConversation(t, threadID, 3)

	// Alice follows (authored); seed a read cursor through the middle reply.
	if err := withTx(f, func(tx *sql.Tx) error {
		_, err := tx.Exec(`INSERT INTO user_channel_read_states
			(workspace_id, user_id, channel_id, last_read_seq, read_state_version, updated_at)
			VALUES (?,?,?,?,1,1)`, txWS, txAlice, threadID, replies[1].Seq)
		return err
	}); err != nil {
		t.Fatal(err)
	}

	page, err := f.store.ListChannelPage(context.Background(), NewClaims(claimsFor(txAlice, txFamAlice)), txWS, txGeneral, PageQuery{Limit: 10})
	if err != nil {
		t.Fatal(err)
	}
	summary := page.ThreadSummaries[parent.ID]
	if summary.ReplyCount != 3 {
		t.Fatalf("replyCount counts all rows: %+v", summary)
	}
	if summary.UnreadCount != 1 {
		t.Fatalf("cursor must leave exactly one unread reply: %+v", summary)
	}
	if summary.FirstUnreadMessageID == nil || *summary.FirstUnreadMessageID != replies[2].ID {
		t.Fatalf("firstUnread must be the row above the cursor: %+v", summary)
	}
}

func (f *fixture) joinRoster(channelID string, users ...string) {
	f.t.Helper()
	for _, u := range users {
		if _, err := f.db.Exec(`INSERT INTO channel_humans (channel_id, user_id, role, joined_at)
			VALUES (?,?,'member',1)`, channelID, u); err != nil {
			f.t.Fatal(err)
		}
	}
}
