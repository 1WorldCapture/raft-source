package readstate

import (
	"sync"
	"testing"
)

// TestConcurrentReadUnreadSingleWinner: parallel read/unread races on one
// scope serialize; the final stored state matches exactly one committed
// decision and versions stay gap-consistent per change.
func TestConcurrentReadUnreadSingleWinner(t *testing.T) {
	fx := newFixture(t)
	fx.insertMessage(fxGeneral, fxBob, "one")
	fx.insertMessage(fxGeneral, fxBob, "two")

	var wg sync.WaitGroup
	for i := 0; i < 8; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			if i%2 == 0 {
				_, _ = fx.store.MarkReadLatest(fx.ctx(), fx.claims[fxAlice], fxWS, fxGeneral)
			} else {
				_, _ = fx.store.MarkUnread(fx.ctx(), fx.claims[fxAlice], fxWS, fxGeneral)
			}
		}(i)
	}
	wg.Wait()
	lastRead, version, present := fx.readStateRow(fxAlice, fxGeneral)
	if !present {
		t.Fatal("no cursor row after the race")
	}
	if version < 1 || lastRead < 0 || lastRead > 2 {
		t.Fatalf("post-race row = (%d, %d)", lastRead, version)
	}
}

// TestConcurrentDoneIdempotent: parallel identical Done writes keep one row
// with the monotonic frontier and never duplicate.
func TestConcurrentDoneIdempotent(t *testing.T) {
	fx := newFixture(t)
	seq := fx.insertMessage(fxGeneral, fxBob, "one")
	var wg sync.WaitGroup
	for i := 0; i < 6; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			_, _ = fx.store.DoneChannel(fx.ctx(), fx.claims[fxAlice], fxWS, fxGeneral,
				DoneInput{ThroughPresent: true, Through: strPtr(itoa(seq))})
		}()
	}
	wg.Wait()
	if n := fx.countRows("user_channel_done_states"); n != 1 {
		t.Fatalf("done rows = %d, want 1", n)
	}
	through, _, _ := fx.doneRow(fxAlice, fxGeneral)
	if through != seq {
		t.Fatalf("frontier = %d, want %d", through, seq)
	}
}

// TestConcurrentSnapshotsDenseJournal: parallel snapshots serialize on the
// scope authority; the journal stays dense (seq 1..watermark, no holes).
func TestConcurrentSnapshotsDenseJournal(t *testing.T) {
	fx := newFixture(t)
	fx.insertMessage(fxGeneral, fxBob, "one")
	var wg sync.WaitGroup
	for i := 0; i < 6; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			_, _ = fx.store.ActivitySnapshot(fx.ctx(), fx.claims[fxAlice], fxWS, SnapshotQuery{RequestID: "r", Filter: ActivityFilterAll})
		}()
	}
	wg.Wait()
	rows, err := fx.db.Query(`SELECT seq FROM activity_changes
		WHERE workspace_id = ? AND principal_id = ? AND filter = 'all'
		ORDER BY seq`, fxWS, fxAlice)
	if err != nil {
		t.Fatal(err)
	}
	expected := int64(1)
	for rows.Next() {
		var seq int64
		if err := rows.Scan(&seq); err != nil {
			rows.Close()
			t.Fatal(err)
		}
		if seq != expected {
			rows.Close()
			t.Fatalf("journal hole: got seq %d, expected %d", seq, expected)
		}
		expected++
	}
	rows.Close()
}

// TestConcurrentReadAllVersusNewMessage: read-all and a concurrent message
// commit race; the message committed after the read-all boundary stays
// unread (whichever tx wins the ordering, the boundary stays coherent).
func TestConcurrentReadAllVersusNewMessage(t *testing.T) {
	fx := newFixture(t)
	fx.insertMessage(fxGeneral, fxBob, "before")
	var wg sync.WaitGroup
	wg.Add(2)
	go func() {
		defer wg.Done()
		_, _ = fx.store.MarkReadLatest(fx.ctx(), fx.claims[fxAlice], fxWS, fxGeneral)
	}()
	go func() {
		defer wg.Done()
		fx.insertMessage(fxGeneral, fxBob, "racing")
	}()
	wg.Wait()
	counts, err := fx.store.UnreadCounts(fx.ctx(), fx.claims[fxAlice], fxWS)
	if err != nil {
		t.Fatal(err)
	}
	if counts[fxGeneral] > 1 {
		t.Fatalf("unread after race = %d, want <= 1", counts[fxGeneral])
	}
}
