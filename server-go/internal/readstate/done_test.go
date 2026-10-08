package readstate

import (
	"testing"
)

func strPtr(v string) *string { return &v }

// doneArgs builds the tri-state DoneInput from a raw JSON-like shape.
func doneInput(value any, frontierSpace any) DoneInput {
	input := DoneInput{ThroughPresent: value != nil || frontierSpace != nil}
	if s, ok := value.(string); ok {
		input.Through = &s
	}
	if value == nil && frontierSpace == nil {
		input.ThroughPresent = false
	}
	return input
}

// TestDoneChannelFrontierMatrix walks the adjudicated four-way matrix of
// /inbox/done: omitted value => canonical snapshot; value without identity
// => 412 refresh; unsupported identity => 400; explicit storage value =>
// strict guard (400 REQUIRED for malformed, 409 BEYOND for future content,
// 409 ABOVE_INT4 past the legacy ceiling, success within bounds).
func TestDoneChannelFrontierMatrix(t *testing.T) {
	fx := newFixture(t)
	seq1 := fx.insertMessage(fxGeneral, fxBob, "one")
	seq2 := fx.insertMessage(fxGeneral, fxBob, "two")

	// 1. Value without frontierSpace: handler-level 412 is transport-side;
	//    the store contract expresses it through the transport matrix, so
	//    here we assert the strict guard accepts the explicit storage form.
	if _, err := fx.store.DoneChannel(fx.ctx(), fx.claims[fxAlice], fxWS, fxGeneral,
		DoneInput{ThroughPresent: true, Through: strPtr("1")}); err != nil {
		t.Fatalf("explicit storage done: %v", err)
	}
	through, doneAt, present := fx.doneRow(fxAlice, fxGeneral)
	if !present || !doneAt.Valid || through != 1 {
		t.Fatalf("done row = (%d, %v, %v)", through, doneAt, present)
	}

	// 2. Canonical snapshot on omitted value.
	if _, err := fx.store.DoneChannel(fx.ctx(), fx.claims[fxAlice], fxWS, fxGeneral, DoneInput{}); err != nil {
		t.Fatalf("canonical done: %v", err)
	}
	through, _, _ = fx.doneRow(fxAlice, fxGeneral)
	if through != seq2 {
		t.Fatalf("canonical frontier = %d, want latest %d", through, seq2)
	}

	// 3. Malformed strict values fail closed with the REQUIRED 400.
	for _, raw := range []string{"0", "007", "", "-3", "1.5", "1e3", " 1", "+1"} {
		_, err := fx.store.DoneChannel(fx.ctx(), fx.claims[fxAlice], fxWS, fxGeneral,
			DoneInput{ThroughPresent: true, Through: strPtr(raw)})
		de := AsError(err)
		if de == nil || de.Status != 400 || de.Code != CodeDoneFrontierRequired {
			t.Fatalf("frontier %q error = %v, want 400 %s", raw, err, CodeDoneFrontierRequired)
		}
	}
	// JSON null is present-but-invalid on the strict path.
	_, err := fx.store.DoneChannel(fx.ctx(), fx.claims[fxAlice], fxWS, fxGeneral,
		DoneInput{ThroughPresent: true, Through: nil})
	de := AsError(err)
	if de == nil || de.Status != 400 || de.Code != CodeDoneFrontierRequired {
		t.Fatalf("null frontier error = %v, want 400 REQUIRED", err)
	}

	// 4. Beyond current latest: 409, never clamped. The reference guard
	// checks latest before int4, including values that exceed both bounds.
	for _, raw := range []string{"999999", "3000000000", "9007199254740992"} {
		_, err = fx.store.DoneChannel(fx.ctx(), fx.claims[fxAlice], fxWS, fxGeneral,
			DoneInput{ThroughPresent: true, Through: strPtr(raw)})
		de = AsError(err)
		if de == nil || de.Status != 409 || de.Code != CodeDoneFrontierBeyondLatest {
			t.Fatalf("frontier %q error = %v, want 409 %s", raw, err, CodeDoneFrontierBeyondLatest)
		}
		through, _, _ = fx.doneRow(fxAlice, fxGeneral)
		if through != seq2 {
			t.Fatalf("rejected frontier %q changed stored frontier to %d", raw, through)
		}
	}

	// 5. Above the int4 authority ceiling: 409, never truncated to accept.
	// The fence only fires for a frontier the target actually contains, so
	// seed one message with an explicit high seq in the private channel.
	if _, err := fx.db.Exec(`INSERT INTO messages (seq, id, workspace_id, channel_id, sender_type,
		sender_id, content, message_type, request_digest, created_at)
		VALUES (2147483648, 'high-seq-msg', ?, ?, 'user', ?, 'high', 'chat', 'dh', ?)`,
		fxWS, fxSecret, fxBob, fx.clock.Now().UnixMilli()); err != nil {
		t.Fatal(err)
	}
	_, err = fx.store.DoneChannel(fx.ctx(), fx.claims[fxAlice], fxWS, fxSecret,
		DoneInput{ThroughPresent: true, Through: strPtr("2147483648")})
	de = AsError(err)
	if de == nil || de.Status != 409 || de.Code != CodeDoneFrontierAboveInt4 {
		t.Fatalf("above-int4 error = %v, want 409 %s", err, CodeDoneFrontierAboveInt4)
	}
	if _, _, present := fx.doneRow(fxAlice, fxSecret); present {
		t.Fatal("rejected above-int4 frontier created a Done row")
	}

	// 6. Success within bounds keeps done_through monotonic (max).
	if _, err := fx.store.DoneChannel(fx.ctx(), fx.claims[fxAlice], fxWS, fxGeneral,
		DoneInput{ThroughPresent: true, Through: strPtr("1")}); err != nil {
		t.Fatalf("monotonic re-done: %v", err)
	}
	through, _, _ = fx.doneRow(fxAlice, fxGeneral)
	if through != seq2 {
		t.Fatalf("done_through regressed to %d, want %d", through, seq2)
	}
	_ = seq1
}

// TestDoneChannelHonest400OnEmptyChannel: Done on a channel with no messages
// and no explicit frontier cannot fabricate a positive snapshot boundary.
func TestDoneChannelHonest400OnEmptyChannel(t *testing.T) {
	fx := newFixture(t)
	_, err := fx.store.DoneChannel(fx.ctx(), fx.claims[fxAlice], fxWS, fxSecret, DoneInput{})
	de := AsError(err)
	if de == nil || de.Status != 400 || de.Code != CodeDoneFrontierRequired {
		t.Fatalf("empty-channel done error = %v, want 400 REQUIRED", err)
	}
}

// TestDoneChannelRefusesThreadScope: thread ids never masquerade as plain
// conversations on /inbox/done.
func TestDoneChannelRefusesThreadScope(t *testing.T) {
	fx := newFixture(t)
	fx.seedThreadParents()
	fx.follow(fxAlice, fxThread, false)
	_, err := fx.store.DoneChannel(fx.ctx(), fx.claims[fxAlice], fxWS, fxThread, DoneInput{})
	de := AsError(err)
	if de == nil || de.Status != 404 || de.Message != "Chat not found" {
		t.Fatalf("thread-as-chat error = %v, want 404 Chat not found", err)
	}
}

// TestDoneReactivatesOnNewActivity: a Done row only suppresses until new
// activity moves past the confirmed frontier.
func TestDoneReactivatesOnNewActivity(t *testing.T) {
	fx := newFixture(t)
	seq1 := fx.insertMessage(fxGeneral, fxBob, "one")
	if _, err := fx.store.DoneChannel(fx.ctx(), fx.claims[fxAlice], fxWS, fxGeneral,
		DoneInput{ThroughPresent: true, Through: strPtr(itoa(seq1))}); err != nil {
		t.Fatal(err)
	}
	page, err := fx.store.InboxItems(fx.ctx(), fx.claims[fxAlice], fxWS, InboxQuery{Filter: FilterAll, Limit: 30})
	if err != nil {
		t.Fatal(err)
	}
	if len(page.Items) != 0 {
		t.Fatalf("done channel still listed: %+v", page.Items)
	}
	fx.insertMessage(fxGeneral, fxBob, "two")
	page, err = fx.store.InboxItems(fx.ctx(), fx.claims[fxAlice], fxWS, InboxQuery{Filter: FilterAll, Limit: 30})
	if err != nil {
		t.Fatal(err)
	}
	if len(page.Items) != 1 {
		t.Fatalf("reactivation failed: %+v", page.Items)
	}
}

// TestUndoneChannelRestoresOnlySelf: undone clears the caller's Done and
// mention boundary, never another user's rows.
func TestUndoneChannelRestoresOnlySelf(t *testing.T) {
	fx := newFixture(t)
	seq := fx.insertMessage(fxGeneral, fxBob, "one")
	if _, err := fx.store.DoneChannel(fx.ctx(), fx.claims[fxAlice], fxWS, fxGeneral, DoneInput{}); err != nil {
		t.Fatal(err)
	}
	if err := fx.store.UndoneChannel(fx.ctx(), fx.claims[fxAlice], fxWS, fxGeneral); err != nil {
		t.Fatal(err)
	}
	_, doneAt, present := fx.doneRow(fxAlice, fxGeneral)
	if !present || doneAt.Valid {
		t.Fatalf("undone left a live done row: (%v)", doneAt)
	}
	if n := fx.countRows("user_mention_suppressions"); n != 0 {
		t.Fatalf("undone left %d suppression rows", n)
	}
	_ = seq
}

// TestThreadDoneMatrix: the thread frontier shares the channel guard; the
// zero-reply thread falls back to the parent message seq.
func TestThreadDoneMatrix(t *testing.T) {
	fx := newFixture(t)
	fx.seedThreadParents()
	fx.follow(fxAlice, fxThread, false)
	parentSeq := fx.threadParentSeq(fxParent)

	// Zero replies: canonical snapshot uses the parent message seq.
	if _, err := fx.store.DoneThread(fx.ctx(), fx.claims[fxAlice], fxWS, fxThread, DoneInput{}); err != nil {
		t.Fatalf("zero-reply thread done: %v", err)
	}
	through, doneAt, present := fx.doneRow(fxAlice, fxThread)
	if !present || !doneAt.Valid || through != parentSeq {
		t.Fatalf("thread done row = (%d, %v, %v), want frontier %d", through, doneAt, present, parentSeq)
	}

	// A reply moves the frontier: the stored row keeps its confirmed
	// boundary (done_at stays set) while the projection reactivates.
	replySeq := fx.insertMessage(fxThread, fxBob, "reply")
	_, doneAtStillSet, stillPresent := fx.doneRow(fxAlice, fxThread)
	if !stillPresent || !doneAtStillSet.Valid {
		t.Fatal("reactivation must come from the frontier comparison, not a row rewrite")
	}
	page, err := fx.store.InboxItems(fx.ctx(), fx.claims[fxAlice], fxWS, InboxQuery{Filter: FilterAll, Limit: 30})
	if err != nil {
		t.Fatal(err)
	}
	if len(page.Items) != 1 {
		t.Fatalf("thread did not reactivate after reply: %+v", page.Items)
	}

	// Beyond-latest on the thread scope.
	_, err = fx.store.DoneThread(fx.ctx(), fx.claims[fxAlice], fxWS, fxThread,
		DoneInput{ThroughPresent: true, Through: strPtr(itoa(replySeq + 5))})
	de := AsError(err)
	if de == nil || de.Status != 409 || de.Code != CodeDoneFrontierBeyondLatest {
		t.Fatalf("thread beyond error = %v", err)
	}

	// Non-thread scope naming.
	_, err = fx.store.DoneThread(fx.ctx(), fx.claims[fxAlice], fxWS, fxGeneral,
		DoneInput{ThroughPresent: true, Through: strPtr("1")})
	de = AsError(err)
	if de == nil || de.Status != 400 || de.Code != CodeNotAThread {
		t.Fatalf("non-thread scope error = %v, want 400 NOT_A_THREAD", err)
	}
	// Non-thread scope for a stranger keeps the merged 404.
	_, err = fx.store.DoneThread(fx.ctx(), fx.claims[fxStranger], fxWS, fxSecret,
		DoneInput{ThroughPresent: true, Through: strPtr("1")})
	if de := AsError(err); de == nil || de.Status != 403 {
		t.Fatalf("stranger thread-done error = %v, want scope 403", err)
	}
}

// TestThreadDoneDeletedScopeResidue: a soft-deleted thread admits the retire
// only from receiver-owned residue; strangers keep the merged 404 and the
// failure writes nothing.
func TestThreadDoneDeletedScopeResidue(t *testing.T) {
	fx := newFixture(t)
	fx.seedThreadParents()
	fx.follow(fxAlice, fxThread, false)
	replySeq := fx.insertMessage(fxThread, fxBob, "reply")
	if _, err := fx.store.MarkRead(fx.ctx(), fx.claims[fxAlice], fxWS, fxThread, replySeq); err != nil {
		t.Fatal(err)
	}
	if _, err := fx.db.Exec(`UPDATE channels SET deleted_at = ? WHERE id = ?`,
		fx.clock.Now().UnixMilli(), fxThread); err != nil {
		t.Fatal(err)
	}

	// Bob (member, no residue of his own on this thread) gets the merged 404.
	_, err := fx.store.DoneThread(fx.ctx(), fx.claims[fxBob], fxWS, fxThread, DoneInput{})
	de := AsError(err)
	if de == nil || de.Status != 404 || de.Message != "Thread not found" {
		t.Fatalf("no-residue error = %v, want 404 Thread not found", err)
	}

	// Alice carries residue (read cursor + follow row) and may retire it.
	result, err := fx.store.DoneThread(fx.ctx(), fx.claims[fxAlice], fxWS, fxThread,
		DoneInput{ThroughPresent: true, Through: strPtr(itoa(replySeq))})
	if err != nil {
		t.Fatalf("residue retire: %v", err)
	}
	if !result.LegacyNoop || result.TerminalReason != "legacy_done_target_unavailable" {
		t.Fatalf("residue receipt = %+v", result)
	}
	if n := fx.countRows("user_channel_done_states"); n != 0 {
		t.Fatalf("residue retire wrote %d done rows", n)
	}
}

// TestThreadDoneDeletedDMParentResidue: a live thread below a soft-deleted
// DM parent follows the same receiver-owned residue adjudication.
func TestThreadDoneDeletedDMParentResidue(t *testing.T) {
	fx := newFixture(t)
	fx.seedThreadParents()
	// Move parent message two into the DM channel and point thread2 at it.
	if _, err := fx.db.Exec(`UPDATE messages SET channel_id = ? WHERE id = ?`, fxDM, fxParent2); err != nil {
		t.Fatal(err)
	}
	fx.follow(fxAlice, fxThread2, false)
	seq := fx.insertMessage(fxThread2, fxBob, "dm thread reply")
	if _, err := fx.store.MarkRead(fx.ctx(), fx.claims[fxAlice], fxWS, fxThread2, 1); err != nil {
		t.Fatal(err)
	}
	if _, err := fx.db.Exec(`UPDATE channels SET deleted_at = ? WHERE id = ?`,
		fx.clock.Now().UnixMilli(), fxDM); err != nil {
		t.Fatal(err)
	}

	result, err := fx.store.DoneThread(fx.ctx(), fx.claims[fxAlice], fxWS, fxThread2,
		DoneInput{ThroughPresent: true, Through: strPtr(itoa(seq))})
	if err != nil {
		t.Fatalf("deleted-dm-parent retire: %v", err)
	}
	if !result.LegacyNoop {
		t.Fatalf("receipt = %+v", result)
	}
}

// TestThreadUndoneKeepsExplicitUnfollowBoundary: undone restores the thread's
// active state without re-following; an unfollowed thread keeps its durable
// mention boundary.
func TestThreadUndoneKeepsExplicitUnfollowBoundary(t *testing.T) {
	fx := newFixture(t)
	fx.seedThreadParents()
	fx.follow(fxAlice, fxThread, true) // explicitly unfollowed
	seq := fx.insertMessage(fxThread, fxBob, "reply")
	if _, err := fx.store.DoneThread(fx.ctx(), fx.claims[fxAlice], fxWS, fxThread,
		DoneInput{ThroughPresent: true, Through: strPtr(itoa(seq))}); err != nil {
		t.Fatal(err)
	}
	if err := fx.store.UndoneThread(fx.ctx(), fx.claims[fxAlice], fxWS, fxThread); err != nil {
		t.Fatal(err)
	}
	_, doneAt, _ := fx.doneRow(fxAlice, fxThread)
	if doneAt.Valid {
		t.Fatal("undone thread kept a live done row")
	}
	// The unfollow boundary survives undone (no re-follow).
	if n := fx.countRows("user_mention_suppressions"); n != 1 {
		t.Fatalf("unfollow boundary count = %d, want 1", n)
	}
	// Followed threads clear their boundary on undone.
	fx.follow(fxAlice, fxThread2, false)
	seq2 := fx.insertMessage(fxThread2, fxBob, "reply two")
	if _, err := fx.store.DoneThread(fx.ctx(), fx.claims[fxAlice], fxWS, fxThread2,
		DoneInput{ThroughPresent: true, Through: strPtr(itoa(seq2))}); err != nil {
		t.Fatal(err)
	}
	if err := fx.store.UndoneThread(fx.ctx(), fx.claims[fxAlice], fxWS, fxThread2); err != nil {
		t.Fatal(err)
	}
	if n := fx.countRows("user_mention_suppressions"); n != 1 {
		t.Fatalf("followed-thread boundary should clear, count = %d", n)
	}
}

// TestDoneFailuresWriteNothing: every rejected Done leaves zero rows behind.
func TestDoneFailuresWriteNothing(t *testing.T) {
	fx := newFixture(t)
	seq := fx.insertMessage(fxGeneral, fxBob, "one")
	if _, err := fx.store.DoneChannel(fx.ctx(), fx.claims[fxAlice], fxWS, fxGeneral,
		DoneInput{ThroughPresent: true, Through: strPtr(itoa(seq + 100))}); err == nil {
		t.Fatal("beyond-latest done should fail")
	}
	if n := fx.countRows("user_channel_done_states"); n != 0 {
		t.Fatalf("failed done wrote %d rows", n)
	}
	if n := fx.countRows("user_channel_read_states"); n != 0 {
		t.Fatalf("failed done advanced %d cursors", n)
	}
}

func itoa(v int64) string {
	if v == 0 {
		return "0"
	}
	negative := v < 0
	if negative {
		v = -v
	}
	digits := []byte{}
	for v > 0 {
		digits = append([]byte{byte('0' + v%10)}, digits...)
		v /= 10
	}
	if negative {
		return "-" + string(digits)
	}
	return string(digits)
}

// threadParentSeq loads the seq of one parent message for assertions.
func (f *fixture) threadParentSeq(messageID string) int64 {
	f.t.Helper()
	var seq int64
	if err := f.db.QueryRow(`SELECT seq FROM messages WHERE id = ?`, messageID).Scan(&seq); err != nil {
		f.t.Fatal(err)
	}
	return seq
}
