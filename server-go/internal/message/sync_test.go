package message

import (
	"context"
	"database/sql"
	"testing"

	"raft.local/server-go/internal/channel"
	"raft.local/server-go/internal/platform/db"
)

func TestSyncFiltersByVisibilityAndThreadInterest(t *testing.T) {
	f := newFixture(t)
	f.seed()
	f.seedChannel(txGeneral, "general", channel.TypeChannel, txAlice, txBob)
	private := "dddddddd-dddd-4ddd-8ddd-dddddddddddd"
	f.seedChannel(private, "secret", channel.TypePrivate, txAlice)

	// seq 1..2 public
	pub := f.seedConversation(t, txGeneral, 2)
	// seq 3 private (bob cannot read)
	f.seedConversation(t, private, 1)
	// seq 5 public again (hole for bob at 3..4? no—private invisible)
	f.seedConversation(t, txGeneral, 1)
	allPub := append(pub, f.seedConversation(t, txGeneral, 0)...)
	_ = allPub

	alice := NewClaims(claimsFor(txAlice, txFamAlice))
	bob := NewClaims(claimsFor(txBob, txFamBob))

	res, err := f.store.SyncVisibleMessages(context.Background(), alice, txWS, 0, "", 200)
	if err != nil {
		t.Fatalf("alice sync: %v", err)
	}
	if len(res.Messages) != 4 {
		t.Fatalf("alice sees 4 messages (3 public + 1 private), got %d", len(res.Messages))
	}
	res, err = f.store.SyncVisibleMessages(context.Background(), bob, txWS, 0, "", 200)
	if err != nil {
		t.Fatalf("bob sync: %v", err)
	}
	if len(res.Messages) != 3 {
		t.Fatalf("bob sees the 3 public messages, got %d", len(res.Messages))
	}
	for _, m := range res.Messages {
		if m.ChannelID == private {
			t.Fatalf("private message leaked into bob's stream: %+v", m)
		}
	}
	// Coverage ran to the workspace high-water.
	if res.CoveredThrough != res.HighWater || res.HasMore {
		t.Fatalf("coverage: %+v", res)
	}
}

func TestSyncThreadRequiresActiveFollow(t *testing.T) {
	f := newFixture(t)
	f.seed()
	f.seedChannel(txGeneral, "general", channel.TypeChannel, txAlice, txBob)

	parent := f.seedConversation(t, txGeneral, 1)
	var threadID string
	if err := db.WithWriteTx(context.Background(), f.db, func(tx *sql.Tx) error {
		thread, err := f.channels.EnsureThreadTx(context.Background(), tx, txWS, txGeneral, parent[0].ID, txAlice)
		threadID = thread.ID
		return err
	}); err != nil {
		t.Fatal(err)
	}
	reply := f.sendMsg(t, threadID, "thread reply")

	alice := NewClaims(claimsFor(txAlice, txFamAlice))
	bob := NewClaims(claimsFor(txBob, txFamBob))

	// Alice authored the parent: auto-followed, thread streams.
	res, err := f.store.SyncVisibleMessages(context.Background(), alice, txWS, 0, "", 200)
	if err != nil {
		t.Fatal(err)
	}
	found := false
	for _, m := range res.Messages {
		if m.ID == reply.ID {
			found = true
		}
	}
	if !found {
		t.Fatalf("follower alice must stream the thread reply: %+v", res.Messages)
	}

	// Bob can READ the thread (base content) but does not follow: the reply
	// stays out of his stream while history still serves it.
	res, err = f.store.SyncVisibleMessages(context.Background(), bob, txWS, 0, "", 200)
	if err != nil {
		t.Fatal(err)
	}
	for _, m := range res.Messages {
		if m.ID == reply.ID {
			t.Fatalf("unfollowed thread leaked into bob's sync stream")
		}
	}
	page, err := f.store.ListChannelPage(context.Background(), bob, txWS, threadID, PageQuery{Limit: 50})
	if err != nil || len(page.Messages) != 1 {
		t.Fatalf("readable-but-unfollowed thread must remain readable via history: %v %+v", err, page)
	}

	// Bob follows explicitly; the reply now streams.
	if err := db.WithWriteTx(context.Background(), f.db, func(tx *sql.Tx) error {
		return f.channels.SetThreadFollowTx(context.Background(), tx, txWS, threadID, txBob, true, false)
	}); err != nil {
		t.Fatal(err)
	}
	res, err = f.store.SyncVisibleMessages(context.Background(), bob, txWS, 0, "", 200)
	if err != nil {
		t.Fatal(err)
	}
	found = false
	for _, m := range res.Messages {
		if m.ID == reply.ID {
			found = true
		}
	}
	if !found {
		t.Fatalf("followed thread must stream: %+v", res.Messages)
	}

	// Unfollow removes it again; content read survives.
	if err := db.WithWriteTx(context.Background(), f.db, func(tx *sql.Tx) error {
		return f.channels.SetThreadFollowTx(context.Background(), tx, txWS, threadID, txBob, false, false)
	}); err != nil {
		t.Fatal(err)
	}
	res, err = f.store.SyncVisibleMessages(context.Background(), bob, txWS, 0, "", 200)
	if err != nil {
		t.Fatal(err)
	}
	for _, m := range res.Messages {
		if m.ID == reply.ID {
			t.Fatalf("unfollowed again leaked into stream")
		}
	}
}

func TestSyncChannelScopedAndPagination(t *testing.T) {
	f := newFixture(t)
	f.seed()
	f.seedChannel(txGeneral, "general", channel.TypeChannel, txAlice)
	f.seedChannel("dddddddd-dddd-4ddd-8ddd-dddddddddddd", "other", channel.TypeChannel, txAlice)
	other := "dddddddd-dddd-4ddd-8ddd-dddddddddddd"

	all := f.seedConversation(t, txGeneral, 5)
	f.sendMsg(t, other, "elsewhere")
	alice := NewClaims(claimsFor(txAlice, txFamAlice))

	// Channel scope returns only that channel, paging by last seq.
	res, err := f.store.SyncVisibleMessages(context.Background(), alice, txWS, 0, txGeneral, 2)
	if err != nil {
		t.Fatal(err)
	}
	if len(res.Messages) != 2 || res.Messages[0].ID != all[0].ID || res.Messages[1].ID != all[1].ID {
		t.Fatalf("scoped page 1: %+v", res.Messages)
	}
	if !res.HasMore {
		t.Fatalf("full page must report hasMore while rows remain")
	}
	res, err = f.store.SyncVisibleMessages(context.Background(), alice, txWS, res.Messages[1].Seq, txGeneral, 2)
	if err != nil {
		t.Fatal(err)
	}
	if len(res.Messages) != 2 || res.Messages[0].ID != all[2].ID {
		t.Fatalf("scoped page 2: %+v", res.Messages)
	}
	res, err = f.store.SyncVisibleMessages(context.Background(), alice, txWS, res.Messages[1].Seq, txGeneral, 2)
	if err != nil {
		t.Fatal(err)
	}
	if len(res.Messages) != 1 || res.Messages[0].ID != all[4].ID || res.HasMore {
		t.Fatalf("scoped last page: %+v", res.Messages)
	}
	if res.CoveredThrough != res.HighWater {
		t.Fatalf("final page covers to H: %+v", res)
	}
}

func TestSyncDeniesInvisibleChannelAndEmptyRange(t *testing.T) {
	f := newFixture(t)
	f.seed()
	f.seedChannel(txGeneral, "general", channel.TypeChannel, txAlice)
	private := "dddddddd-dddd-4ddd-8ddd-dddddddddddd"
	f.seedChannel(private, "secret", channel.TypePrivate, txAlice)
	f.seedConversation(t, private, 1)

	// Bob cannot read the private channel: denial, not an empty stream.
	_, err := f.store.SyncVisibleMessages(context.Background(), NewClaims(claimsFor(txBob, txFamBob)), txWS, 0, private, 200)
	if err == nil {
		t.Fatal("expected denial for unreadable channel sync")
	}
	// sinceSeq at/after the high water returns an empty page with lastSeq kept.
	res, err := f.store.SyncVisibleMessages(context.Background(), NewClaims(claimsFor(txAlice, txFamAlice)), txWS, 999, "", 200)
	if err != nil || len(res.Messages) != 0 || res.CoveredThrough != 999 || res.HighWater != 1 {
		t.Fatalf("empty range: %+v %v", res, err)
	}
}

func TestSyncScanBudgetAdvancesAndResumes(t *testing.T) {
	f := newFixture(t)
	f.seed()
	// A channel bob cannot stream floods the seq range; his visible channel
	// has one message at the very end.
	flood := "dddddddd-dddd-4ddd-8ddd-dddddddddddd"
	f.seedChannel(flood, "flood", channel.TypePrivate, txAlice)
	f.seedChannel(txGeneral, "general", channel.TypeChannel, txAlice, txBob)
	f.seedConversation(t, flood, 30)
	visible := f.sendMsg(t, txGeneral, "for bob")

	bob := NewClaims(claimsFor(txBob, txFamBob))
	res, err := f.store.SyncVisibleMessages(context.Background(), bob, txWS, 0, "", 10)
	if err != nil {
		t.Fatal(err)
	}
	if len(res.Messages) != 1 || res.Messages[0].ID != visible.ID {
		t.Fatalf("scan must pass invisible holes: %+v", res.Messages)
	}
	if res.CoveredThrough != res.HighWater {
		t.Fatalf("scan must cover through H even with holes: %+v", res)
	}
	if res.HasMore {
		t.Fatalf("no more pages: %+v", res)
	}
	// Resuming from the covered cursor is stable and empty.
	res, err = f.store.SyncVisibleMessages(context.Background(), bob, txWS, res.CoveredThrough, "", 10)
	if err != nil || len(res.Messages) != 0 {
		t.Fatalf("resume after coverage: %+v %v", res, err)
	}
}
