package readstate

import (
	"errors"
	"testing"
)

// TestMarkReadAdvancesAndClamps: a read advances to min(requested, latest);
// a forged huge seq can never become a future all-read certificate.
func TestMarkReadAdvancesAndClamps(t *testing.T) {
	fx := newFixture(t)
	seq1 := fx.insertMessage(fxGeneral, fxBob, "one")
	seq2 := fx.insertMessage(fxGeneral, fxBob, "two")

	state, err := fx.store.MarkRead(fx.ctx(), fx.claims[fxAlice], fxWS, fxGeneral, seq2)
	if err != nil {
		t.Fatalf("mark read: %v", err)
	}
	if !state.Changed || state.MaxReadSeq != seq2 || state.ReadStateVersion != 1 {
		t.Fatalf("unexpected first read state: %+v", state)
	}
	// A forged frontier far beyond the channel clamps to the real latest.
	state, err = fx.store.MarkRead(fx.ctx(), fx.claims[fxAlice], fxWS, fxGeneral, seq2+1_000_000)
	if err != nil {
		t.Fatalf("mark read clamp: %v", err)
	}
	if state.Changed {
		t.Fatalf("clamped read must be a no-op, got %+v", state)
	}
	if state.MaxReadSeq != seq2 {
		t.Fatalf("clamped frontier = %d, want %d", state.MaxReadSeq, seq2)
	}
	if state.ReadStateVersion != 1 {
		t.Fatalf("no-op read bumped version to %d", state.ReadStateVersion)
	}
	_ = seq1
}

// TestMarkReadLateLowSeqDoesNotRegress: an advancing-only cursor means a
// stale low read response cannot undo a newer frontier.
func TestMarkReadLateLowSeqDoesNotRegress(t *testing.T) {
	fx := newFixture(t)
	fx.insertMessage(fxGeneral, fxBob, "one")
	seq2 := fx.insertMessage(fxGeneral, fxBob, "two")

	if _, err := fx.store.MarkRead(fx.ctx(), fx.claims[fxAlice], fxWS, fxGeneral, seq2); err != nil {
		t.Fatal(err)
	}
	state, err := fx.store.MarkRead(fx.ctx(), fx.claims[fxAlice], fxWS, fxGeneral, 1)
	if err != nil {
		t.Fatal(err)
	}
	if state.Changed || state.MaxReadSeq != seq2 {
		t.Fatalf("late low read regressed the cursor: %+v", state)
	}
}

// TestMarkUnreadRewindsToOneUnread: explicit unread rewinds to just before
// the newest non-own message, bumps the version, and reports one unread.
func TestMarkUnreadRewindsToOneUnread(t *testing.T) {
	fx := newFixture(t)
	seq1 := fx.insertMessage(fxGeneral, fxBob, "one")
	seq2 := fx.insertMessage(fxGeneral, fxBob, "two")

	if _, err := fx.store.MarkReadLatest(fx.ctx(), fx.claims[fxAlice], fxWS, fxGeneral); err != nil {
		t.Fatal(err)
	}
	result, err := fx.store.MarkUnread(fx.ctx(), fx.claims[fxAlice], fxWS, fxGeneral)
	if err != nil {
		t.Fatalf("mark unread: %v", err)
	}
	if !result.State.Changed {
		t.Fatalf("unread should change the effective state: %+v", result)
	}
	if result.UnreadCount != 1 {
		t.Fatalf("unreadCount = %d, want 1 (latest non-own message)", result.UnreadCount)
	}
	if result.State.MaxReadSeq != seq2-1 || result.State.MaxReadSeq < seq1 {
		t.Fatalf("rewound frontier = %d", result.State.MaxReadSeq)
	}
	if result.State.ReadStateVersion != 2 {
		t.Fatalf("rewind version = %d, want 2", result.State.ReadStateVersion)
	}
	// A late low read after the rewind cannot re-advance past the boundary.
	late, err := fx.store.MarkRead(fx.ctx(), fx.claims[fxAlice], fxWS, fxGeneral, 1)
	if err != nil {
		t.Fatal(err)
	}
	if late.MaxReadSeq > seq2-1 {
		t.Fatalf("late read advanced beyond the rewind: %+v", late)
	}
}

// TestMarkUnreadNoEligibleMessage: with only the caller's own messages the
// honest answer is the zero no-op, not a fabricated unread.
func TestMarkUnreadNoEligibleMessage(t *testing.T) {
	fx := newFixture(t)
	fx.insertMessage(fxGeneral, fxAlice, "just me")
	result, err := fx.store.MarkUnread(fx.ctx(), fx.claims[fxAlice], fxWS, fxGeneral)
	if err != nil {
		t.Fatal(err)
	}
	if result.State.Changed || result.UnreadCount != 0 {
		t.Fatalf("own-only unread = %+v", result)
	}
}

// TestReadLatestFixedBoundary: read-all fixes the boundary inside its
// transaction; a message committed afterwards stays unread.
func TestReadLatestFixedBoundary(t *testing.T) {
	fx := newFixture(t)
	fx.insertMessage(fxGeneral, fxBob, "one")
	result, err := fx.store.MarkReadLatest(fx.ctx(), fx.claims[fxAlice], fxWS, fxGeneral)
	if err != nil {
		t.Fatal(err)
	}
	if result.ResidueOnly {
		t.Fatal("live channel read-all must not be residue-only")
	}
	if !result.State.Changed || result.State.MaxReadSeq == 0 {
		t.Fatalf("read-all did not advance: %+v", result)
	}
	newSeq := fx.insertMessage(fxGeneral, fxBob, "after read-all")
	counts, err := fx.store.UnreadCounts(fx.ctx(), fx.claims[fxAlice], fxWS)
	if err != nil {
		t.Fatal(err)
	}
	if counts[fxGeneral] != 1 {
		t.Fatalf("post-read-all unread = %d, want 1 (seq %d)", counts[fxGeneral], newSeq)
	}
}

// TestInboxReadAllMarksOnlyChangedScopes: markedCount counts scopes whose
// frontier actually moved and a second call is a zero-mark no-op.
func TestInboxReadAllMarksOnlyChangedScopes(t *testing.T) {
	fx := newFixture(t)
	fx.seedThreadParents()
	fx.insertMessage(fxGeneral, fxBob, "hello")
	fx.insertMessage(fxSecret, fxBob, "secret hello")
	fx.insertMessage(fxDM, fxBob, "dm hello")
	fx.insertMessage(fxThread, fxBob, "reply")
	fx.follow(fxAlice, fxThread, false)

	result, err := fx.store.MarkInboxReadLatest(fx.ctx(), fx.claims[fxAlice], fxWS)
	if err != nil {
		t.Fatal(err)
	}
	if result.MarkedCount != 4 {
		t.Fatalf("markedCount = %d, want 4 (general/secret/dm/thread): %+v", result.MarkedCount, result.Scopes)
	}
	again, err := fx.store.MarkInboxReadLatest(fx.ctx(), fx.claims[fxAlice], fxWS)
	if err != nil {
		t.Fatal(err)
	}
	if again.MarkedCount != 0 || len(again.Scopes) != 0 {
		t.Fatalf("second read-all = %+v, want zero changes", again)
	}
}

// TestReadAllResidueOnlyReceipt: after losing a private channel, a caller
// with prior relationship may retire their own residue and receives the
// receipt WITHOUT the live frontier; a stranger keeps the merged 404.
func TestReadAllResidueOnlyReceipt(t *testing.T) {
	fx := newFixture(t)
	fx.insertMessage(fxSecret, fxBob, "secret")
	if _, err := fx.store.MarkRead(fx.ctx(), fx.claims[fxBob], fxWS, fxSecret, 1); err != nil {
		t.Fatal(err)
	}
	// Bob is removed from the private channel (residue: read cursor row).
	if _, err := fx.db.Exec(`DELETE FROM channel_humans WHERE channel_id = ? AND user_id = ?`, fxSecret, fxBob); err != nil {
		t.Fatal(err)
	}
	result, err := fx.store.MarkReadLatest(fx.ctx(), fx.claims[fxBob], fxWS, fxSecret)
	if err != nil {
		t.Fatalf("residue read-all: %v", err)
	}
	if !result.ResidueOnly {
		t.Fatal("removed member read-all should be residue-only")
	}
	// A stranger holds no workspace membership at all: the scope gate
	// refuses exactly like the legacy requireServer middleware (403).
	strangerClaims := fx.claims[fxStranger]
	_, err = fx.store.MarkReadLatest(fx.ctx(), strangerClaims, fxWS, fxSecret)
	if err == nil {
		t.Fatal("stranger read-all should fail")
	}
	de := AsError(err)
	if de == nil || de.Status != 403 {
		t.Fatalf("stranger error = %v, want 403", err)
	}
	if fx.countRows("user_channel_read_states") != 1 {
		t.Fatal("stranger write leaked a cursor row")
	}
}

// TestCrossWorkspaceAndMembershipGuards: cross-workspace scope and missing
// membership are refused before any write.
func TestCrossWorkspaceAndMembershipGuards(t *testing.T) {
	fx := newFixture(t)
	fx.insertMessage(fxGeneral, fxBob, "one")
	before := fx.countRows("user_channel_read_states")

	if _, err := fx.store.MarkRead(fx.ctx(), fx.claims[fxStranger], fxWS, fxGeneral, 1); err == nil {
		t.Fatal("non-member read must fail")
	} else if de := AsError(err); de == nil || de.Status != 403 {
		t.Fatalf("non-member error = %v, want 403", err)
	}
	if _, err := fx.store.MarkRead(fx.ctx(), fx.claims[fxAlice], fxWS2, fxGeneral, 1); err == nil {
		t.Fatal("cross-workspace read must fail")
	}
	if fx.countRows("user_channel_read_states") != before {
		t.Fatal("rejected writes must not persist cursor rows")
	}
}

// TestRevokedFamilyInvalidatesInTx: a revoked session family fails the
// in-transaction revalidation with ErrTokenInvalid even though the claims
// shape is intact.
func TestRevokedFamilyInvalidatesInTx(t *testing.T) {
	fx := newFixture(t)
	fx.insertMessage(fxGeneral, fxBob, "one")
	if _, err := fx.db.Exec(`UPDATE session_families SET revoked_at = ? WHERE id = ?`,
		fx.clock.Now().UnixMilli(), fx.family[fxAlice]); err != nil {
		t.Fatal(err)
	}
	_, err := fx.store.MarkRead(fx.ctx(), fx.claims[fxAlice], fxWS, fxGeneral, 1)
	if !errors.Is(err, ErrTokenInvalid) {
		t.Fatalf("revoked family error = %v, want ErrTokenInvalid", err)
	}
	if fx.countRows("user_channel_read_states") != 0 {
		t.Fatal("revoked session must not write")
	}
}

// TestOwnMessagesNeverUnread: the caller's own messages never inflate any
// unread counter on any exit.
func TestOwnMessagesNeverUnread(t *testing.T) {
	fx := newFixture(t)
	fx.insertMessage(fxGeneral, fxAlice, "mine one")
	fx.insertMessage(fxGeneral, fxAlice, "mine two")
	counts, err := fx.store.UnreadCounts(fx.ctx(), fx.claims[fxAlice], fxWS)
	if err != nil {
		t.Fatal(err)
	}
	if len(counts) != 0 {
		t.Fatalf("own-only channel produced unread: %+v", counts)
	}
	page, err := fx.store.InboxItems(fx.ctx(), fx.claims[fxAlice], fxWS, InboxQuery{Filter: FilterUnread, Limit: 30})
	if err != nil {
		t.Fatal(err)
	}
	if len(page.Items) != 0 {
		t.Fatalf("unread filter returned own-only rows: %+v", page.Items)
	}
}
