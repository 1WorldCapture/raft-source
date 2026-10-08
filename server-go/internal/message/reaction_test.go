package message

import (
	"context"
	"errors"
	"testing"

	"raft.local/server-go/internal/channel"
)

func TestReactionAddRemoveIdempotentAndAggregate(t *testing.T) {
	f := newFixture(t)
	f.seed()
	f.seedChannel(txGeneral, "general", channel.TypeChannel, txAlice, txBob, txCara)
	msg := f.sendMsg(t, txGeneral, "react to me")
	alice := NewClaims(claimsFor(txAlice, txFamAlice))

	m1, err := f.store.AddReaction(context.Background(), alice, txWS, msg.ID, "👍")
	if err != nil {
		t.Fatalf("add: %v", err)
	}
	if !m1.Changed || m1.Message.Revision != 2 {
		t.Fatalf("first add must mutate and bump the revision: %+v", m1)
	}
	m2, err := f.store.AddReaction(context.Background(), alice, txWS, msg.ID, "👍")
	if err != nil {
		t.Fatalf("re-add: %v", err)
	}
	if m2.Changed || m2.Message.Revision != 2 {
		t.Fatalf("idempotent re-add must not churn the revision: %+v", m2)
	}

	bob := NewClaims(claimsFor(txBob, txFamBob))
	if _, err := f.store.AddReaction(context.Background(), bob, txWS, msg.ID, "👍"); err != nil {
		t.Fatal(err)
	}
	if _, err := f.store.AddReaction(context.Background(), bob, txWS, msg.ID, "🎉"); err != nil {
		t.Fatal(err)
	}

	// Shared aggregate from real rows.
	page, err := f.store.ListChannelPage(context.Background(), alice, txWS, txGeneral, PageQuery{Limit: 10})
	if err != nil {
		t.Fatal(err)
	}
	dtos, err := f.store.ProjectSnapshot(context.Background(), txWS, page.Messages)
	if err != nil {
		t.Fatal(err)
	}
	if len(dtos) != 1 {
		t.Fatalf("page: %d", len(dtos))
	}
	reactions := dtos[0].Reactions
	if len(reactions) != 2 {
		t.Fatalf("aggregates: %+v", reactions)
	}
	for _, r := range reactions {
		if r.Emoji == "👍" && (r.Count != 2 || len(r.ReactorIDs) != 2 || len(r.ReactorNames) != 2) {
			t.Fatalf("thumbs aggregate: %+v", r)
		}
		if r.Emoji == "🎉" && r.Count != 1 {
			t.Fatalf("party aggregate: %+v", r)
		}
	}

	// Remove is idempotent too, and the revision only moves on real change.
	r1, err := f.store.RemoveReaction(context.Background(), bob, txWS, msg.ID, "🎉")
	if err != nil || !r1.Changed {
		t.Fatalf("remove: %v %+v", err, r1)
	}
	r2, err := f.store.RemoveReaction(context.Background(), bob, txWS, msg.ID, "🎉")
	if err != nil || r2.Changed {
		t.Fatalf("idempotent remove: %v %+v", err, r2)
	}
	if r1.Message.Revision != r2.Message.Revision {
		t.Fatalf("idempotent remove must keep the revision stable: %d vs %d", r1.Message.Revision, r2.Message.Revision)
	}
}

func TestReactionViewerVersionIsOrderedCounter(t *testing.T) {
	f := newFixture(t)
	f.seed()
	f.seedChannel(txGeneral, "general", channel.TypeChannel, txAlice)
	msg := f.sendMsg(t, txGeneral, "viewer")
	alice := NewClaims(claimsFor(txAlice, txFamAlice))

	state, _, err := f.store.ViewerSnapshot(context.Background(), alice, txWS, msg.ID)
	if err != nil {
		t.Fatal(err)
	}
	if state.ViewerVersion != 0 || len(state.ReactedEmojis) != 0 {
		t.Fatalf("empty viewer: %+v", state)
	}
	if _, err := f.store.AddReaction(context.Background(), alice, txWS, msg.ID, "b"); err != nil {
		t.Fatal(err)
	}
	if _, err := f.store.AddReaction(context.Background(), alice, txWS, msg.ID, "a"); err != nil {
		t.Fatal(err)
	}
	state, _, err = f.store.ViewerSnapshot(context.Background(), alice, txWS, msg.ID)
	if err != nil {
		t.Fatal(err)
	}
	if state.ViewerVersion != 2 {
		t.Fatalf("two mutations must leave version 2: %+v", state)
	}
	if len(state.ReactedEmojis) != 2 || state.ReactedEmojis[0] != "a" || state.ReactedEmojis[1] != "b" {
		t.Fatalf("sorted emojis: %+v", state)
	}
	// add/remove/add: a repeated payload still gets a HIGHER ordered
	// version — the web merge (reactionReadModels.ts) treats lower arrivals
	// as stale, so versions must be monotone counters, never state hashes.
	if _, err := f.store.RemoveReaction(context.Background(), alice, txWS, msg.ID, "b"); err != nil {
		t.Fatal(err)
	}
	state, _, _ = f.store.ViewerSnapshot(context.Background(), alice, txWS, msg.ID)
	if state.ViewerVersion != 3 || len(state.ReactedEmojis) != 1 {
		t.Fatalf("after remove: %+v", state)
	}
	if _, err := f.store.AddReaction(context.Background(), alice, txWS, msg.ID, "b"); err != nil {
		t.Fatal(err)
	}
	state, _, _ = f.store.ViewerSnapshot(context.Background(), alice, txWS, msg.ID)
	if state.ViewerVersion != 4 || len(state.ReactedEmojis) != 2 {
		t.Fatalf("repeated payload must still advance the ordered version: %+v", state)
	}
}

func TestReactionVersionsPersistAcrossRestartAndTwoUsers(t *testing.T) {
	f := newFixture(t)
	f.seed()
	f.seedChannel(txGeneral, "general", channel.TypeChannel, txAlice, txBob)
	msg := f.sendMsg(t, txGeneral, "versions")
	alice := NewClaims(claimsFor(txAlice, txFamAlice))
	bob := NewClaims(claimsFor(txBob, txFamBob))

	if _, err := f.store.AddReaction(context.Background(), alice, txWS, msg.ID, "👍"); err != nil {
		t.Fatal(err)
	}
	if _, err := f.store.AddReaction(context.Background(), bob, txWS, msg.ID, "👍"); err != nil {
		t.Fatal(err)
	}
	// Idempotent repeats do not advance any counter.
	if _, err := f.store.AddReaction(context.Background(), alice, txWS, msg.ID, "👍"); err != nil {
		t.Fatal(err)
	}
	page, err := f.store.ListReactionActors(context.Background(), alice, txWS, msg.ID, "👍", 10, "")
	if err != nil {
		t.Fatal(err)
	}
	if page.DiscussionVersion != 2 {
		t.Fatalf("two real mutations must leave discussion version 2: %d", page.DiscussionVersion)
	}
	aliceState, _, err := f.store.ViewerSnapshot(context.Background(), alice, txWS, msg.ID)
	if err != nil {
		t.Fatal(err)
	}
	bobState, _, err := f.store.ViewerSnapshot(context.Background(), bob, txWS, msg.ID)
	if err != nil {
		t.Fatal(err)
	}
	if aliceState.ViewerVersion != 1 || bobState.ViewerVersion != 1 {
		t.Fatalf("per-viewer counters are independent: %+v %+v", aliceState, bobState)
	}

	// A new store over the SAME database (process restart) keeps the counters.
	reopened := NewStoreWithOptionsForTest(f.db, f.channels, f.clock)
	state, _, err := reopened.ViewerSnapshot(context.Background(), alice, txWS, msg.ID)
	if err != nil {
		t.Fatal(err)
	}
	if state.ViewerVersion != aliceState.ViewerVersion {
		t.Fatalf("viewer version lost across restart: %d vs %d", state.ViewerVersion, aliceState.ViewerVersion)
	}
	page, err = reopened.ListReactionActors(context.Background(), alice, txWS, msg.ID, "👍", 10, "")
	if err != nil || page.DiscussionVersion != 2 {
		t.Fatalf("discussion version lost across restart: %d %v", page.DiscussionVersion, err)
	}
	// And the counters keep counting after the restart.
	if _, err := reopened.RemoveReaction(context.Background(), alice, txWS, msg.ID, "👍"); err != nil {
		t.Fatal(err)
	}
	page, err = reopened.ListReactionActors(context.Background(), alice, txWS, msg.ID, "👍", 10, "")
	if err != nil || page.DiscussionVersion != 3 {
		t.Fatalf("post-restart increment: %d %v", page.DiscussionVersion, err)
	}
}

func TestReactionRulesAndAuthorization(t *testing.T) {
	f := newFixture(t)
	f.seed()
	f.seedChannel(txGeneral, "general", channel.TypeChannel, txAlice, txBob)
	private := "dddddddd-dddd-4ddd-8ddd-dddddddddddd"
	f.seedChannel(private, "secret", channel.TypePrivate, txAlice)
	msg := f.sendMsg(t, txGeneral, "target")
	alice := NewClaims(claimsFor(txAlice, txFamAlice))
	stranger := NewClaims(claimsFor(txCara, txFamCara))

	// Invalid emoji shapes reject with the legacy 400.
	for _, bad := range []string{"", "  ", "a b", "emoji-longer-than16u"} {
		if _, err := f.store.AddReaction(context.Background(), alice, txWS, msg.ID, bad); AsInvalidInput(err) == nil {
			t.Fatalf("emoji %q must be invalid, got %v", bad, err)
		}
	}
	// Non-member cannot react.
	if _, err := f.store.AddReaction(context.Background(), stranger, txWS, msg.ID, "👍"); !isJoinRequiredErr(err) {
		t.Fatalf("stranger react: %v", err)
	}
	// A message in a channel the caller cannot read is a 404.
	privateMsg := f.sendMsg(t, private, "hidden")
	if _, err := f.store.AddReaction(context.Background(), NewClaims(claimsFor(txBob, txFamBob)), txWS, privateMsg.ID, "👍"); !errors.Is(err, ErrMessageNotFound) {
		t.Fatalf("hidden message react: %v", err)
	}
	if _, _, err := f.store.ViewerSnapshot(context.Background(), NewClaims(claimsFor(txBob, txFamBob)), txWS, privateMsg.ID); !errors.Is(err, ErrMessageNotFound) {
		t.Fatalf("hidden viewer: %v", err)
	}
	// Unknown message id.
	if _, err := f.store.AddReaction(context.Background(), alice, txWS, "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee", "👍"); !errors.Is(err, ErrMessageNotFound) {
		t.Fatalf("unknown message: %v", err)
	}
	// Archived channel refuses mutations.
	archived := "abdddddd-dddd-4ddd-8ddd-dddddddddddd"
	f.seedChannel(archived, "frozen", channel.TypeChannel, txAlice)
	archivedMsg := f.sendMsg(t, archived, "before freeze")
	if _, err := f.db.Exec(`UPDATE channels SET archived_at = 1 WHERE id = ?`, archived); err != nil {
		t.Fatal(err)
	}
	if _, err := f.store.AddReaction(context.Background(), alice, txWS, archivedMsg.ID, "👍"); !errors.Is(err, ErrChannelArchived) {
		t.Fatalf("archived react: %v", err)
	}
}

func isJoinRequiredErr(err error) bool {
	var member *ErrNotChannelMember
	return errors.As(err, &member)
}

func TestReactionActorsPagingAndGuards(t *testing.T) {
	f := newFixture(t)
	f.seed()
	f.seedChannel(txGeneral, "general", channel.TypeChannel, txAlice, txBob, txCara)
	msg := f.sendMsg(t, txGeneral, "actors")
	alice := NewClaims(claimsFor(txAlice, txFamAlice))
	cara := NewClaims(claimsFor(txCara, txFamCara))

	for _, u := range []struct{ user, family string }{
		{txAlice, txFamAlice}, {txBob, txFamBob}, {txCara, txFamCara},
	} {
		if _, err := f.store.AddReaction(context.Background(), NewClaims(claimsFor(u.user, u.family)), txWS, msg.ID, "👍"); err != nil {
			t.Fatal(err)
		}
	}

	// First page of 2 with a signed cursor.
	page, err := f.store.ListReactionActors(context.Background(), alice, txWS, msg.ID, "👍", 2, "")
	if err != nil {
		t.Fatalf("actors page 1: %v", err)
	}
	if len(page.Actors) != 2 || page.NextCursor == nil {
		t.Fatalf("page 1: %+v", page)
	}
	if page.Actors[0].ActorID > page.Actors[1].ActorID {
		t.Fatalf("actors must be ordered by id: %+v", page.Actors)
	}
	cursor := *page.NextCursor
	page2, err := f.store.ListReactionActors(context.Background(), alice, txWS, msg.ID, "👍", 2, cursor)
	if err != nil {
		t.Fatalf("actors page 2: %v", err)
	}
	if len(page2.Actors) != 1 || page2.NextCursor != nil {
		t.Fatalf("page 2: %+v", page2)
	}

	// A same-emoji mutation invalidates the cursor's discussion version (a
	// different emoji never touches this discussion, like the per-emoji TS
	// version rows).
	if _, err := f.store.RemoveReaction(context.Background(), cara, txWS, msg.ID, "👍"); err != nil {
		t.Fatal(err)
	}
	_, err = f.store.ListReactionActors(context.Background(), alice, txWS, msg.ID, "👍", 2, cursor)
	var changed *ReactionDiscussionChanged
	if !errors.As(err, &changed) {
		t.Fatalf("stale cursor must 409 with discussion change, got %v", err)
	}
	// Restore the aggregate so the state/version return to the original.
	if _, err := f.store.AddReaction(context.Background(), cara, txWS, msg.ID, "👍"); err != nil {
		t.Fatal(err)
	}

	// Visibility change invalidates the cursor's hash: shrink the visible
	// actor set, take a page with a cursor, restore the roster, then the old
	// cursor must be refused with the visibility-changed 409.
	if _, err := f.db.Exec(`DELETE FROM channel_humans WHERE channel_id = ? AND user_id = ?`, txGeneral, txCara); err != nil {
		t.Fatal(err)
	}
	shrunk, err := f.store.ListReactionActors(context.Background(), alice, txWS, msg.ID, "👍", 1, "")
	if err != nil {
		t.Fatal(err)
	}
	if len(shrunk.Actors) != 1 || shrunk.NextCursor == nil {
		t.Fatalf("shrunk page: %+v", shrunk)
	}
	if _, err := f.db.Exec(`INSERT INTO channel_humans (channel_id, user_id, role, joined_at) VALUES (?,?,'member',1)`, txGeneral, txCara); err != nil {
		t.Fatal(err)
	}
	_, err = f.store.ListReactionActors(context.Background(), alice, txWS, msg.ID, "👍", 1, *shrunk.NextCursor)
	var visibility *ReactionVisibilityChanged
	if !errors.As(err, &visibility) {
		t.Fatalf("visibility change must invalidate the cursor, got %v", err)
	}

	// Tampered cursor is invalid.
	if _, err := f.store.ListReactionActors(context.Background(), alice, txWS, msg.ID, "👍", 2, cursor+"x"); !isCursorError(err) {
		t.Fatalf("tampered cursor: %v", err)
	}

	// System messages cannot receive reactions.
	if _, err := f.db.Exec(`INSERT INTO messages (id, workspace_id, channel_id, sender_type, sender_id, content, message_type, request_digest, revision, created_at)
		VALUES ('eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', ?, ?, 'user', ?, 'sys', 'system', 'x', 1, 1)`,
		txWS, txGeneral, txAlice); err != nil {
		t.Fatal(err)
	}
	if _, err := f.store.AddReaction(context.Background(), alice, txWS, "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee", "👍"); !errors.Is(err, ErrSystemMessage) {
		t.Fatalf("system message react: %v", err)
	}
	if _, _, err := f.store.ViewerSnapshot(context.Background(), alice, txWS, "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee"); !errors.Is(err, ErrSystemMessage) {
		t.Fatalf("system viewer: %v", err)
	}
}

func isCursorError(err error) bool {
	if _, ok := err.(ReactionActorsCursorError); ok {
		return true
	}
	_, ok := err.(*ReactionActorsCursorError)
	return ok
}

func TestReactionPublicationsCarrySharedAndPrivateIntents(t *testing.T) {
	f := newFixture(t)
	f.seed()
	f.seedChannel(txGeneral, "general", channel.TypeChannel, txAlice, txBob)
	msg := f.sendMsg(t, txGeneral, "pubs")

	if _, err := f.store.AddReaction(context.Background(), NewClaims(claimsFor(txAlice, txFamAlice)), txWS, msg.ID, "👍"); err != nil {
		t.Fatal(err)
	}
	var shared, viewer int
	_ = f.db.QueryRow(`SELECT COUNT(*) FROM realtime_publications WHERE event_type = 'message:updated' AND object_id = ?`, msg.ID).Scan(&shared)
	_ = f.db.QueryRow(`SELECT COUNT(*) FROM realtime_publications WHERE event_type = 'reaction_viewer:updated' AND object_id = ? AND subject_user_id = ?`, msg.ID, txAlice).Scan(&viewer)
	if shared != 1 || viewer != 1 {
		t.Fatalf("publications: shared=%d viewer=%d", shared, viewer)
	}
	// An idempotent repeat enqueues nothing new.
	if _, err := f.store.AddReaction(context.Background(), NewClaims(claimsFor(txAlice, txFamAlice)), txWS, msg.ID, "👍"); err != nil {
		t.Fatal(err)
	}
	_ = f.db.QueryRow(`SELECT COUNT(*) FROM realtime_publications WHERE event_type = 'message:updated' AND object_id = ?`, msg.ID).Scan(&shared)
	if shared != 1 {
		t.Fatalf("idempotent repeat must not publish: %d", shared)
	}
}
