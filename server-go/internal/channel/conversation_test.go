// M4 conversation domain tests: the fail-closed authorization matrix, DM and
// thread ensure uniqueness under concurrency, follow interest semantics, the
// sync audience, and parent-chain defenses (cross-space, nesting, cycles).
package channel

import (
	"context"
	"database/sql"
	"fmt"
	"strings"
	"sync"
	"testing"
)

// insertMessage seeds one messages row (AUTOINCREMENT seq, digest constant:
// test rows never participate in idempotency replay).
func (f *fixture) insertMessage(t *testing.T, workspaceID, channelID, senderType, senderID, content string, seqFill ...any) string {
	t.Helper()
	id := "m-" + fmt.Sprintf("%06d", f.countWhere(`SELECT COUNT(*) FROM messages`)+1) + "-" + senderID[:4]
	if _, err := f.db.Exec(`INSERT INTO messages (id, workspace_id, channel_id, sender_type, sender_id, content, request_digest, created_at)
		VALUES (?,?,?,?,?,?, 'test', ?)`,
		id, workspaceID, channelID, senderType, senderID, content, f.clock.T.UnixMilli()); err != nil {
		t.Fatal(err)
	}
	return id
}

func (f *fixture) threadFollowRow(t *testing.T, userID, threadID string) (unfollowed sql.NullInt64, revision int64) {
	t.Helper()
	if err := f.db.QueryRow(`SELECT unfollowed_at, revision FROM thread_follows
		WHERE workspace_id = ? AND user_id = ? AND thread_channel_id = ?`, fxWS, userID, threadID).Scan(&unfollowed, &revision); err != nil {
		t.Fatal(err)
	}
	return
}

func (f *fixture) authorizeErr(workspaceID, channelID, userID string, posting bool) *DomainError {
	_, err := f.store.AuthorizeConversationTx(f.ctx(), f.db, workspaceID, channelID, userID, posting)
	return AsDomainError(err)
}

func TestAuthorizeConversationMatrix(t *testing.T) {
	f := newFixture(t)
	public, err := f.store.CreateChannel(f.ctx(), CreateInput{WorkspaceID: fxWS, Name: "town", Type: TypeChannel, CreatorUserID: fxOwner})
	if err != nil {
		t.Fatal(err)
	}

	t.Run("non-member of the workspace is refused before anything else", func(t *testing.T) {
		de := f.authorizeErr(fxWS, public.ID, fxOther, false)
		if de == nil || de.Code != CodeForbidden || de.Message != NotServerMemberMessage {
			t.Fatalf("foreign actor: %+v", de)
		}
	})

	t.Run("cross-workspace channel is invisible", func(t *testing.T) {
		foreign, err := f.store.CreateChannel(f.ctx(), CreateInput{WorkspaceID: fxWS2, Name: "their", Type: TypeChannel, CreatorUserID: fxOther})
		if err != nil {
			t.Fatal(err)
		}
		de := f.authorizeErr(fxWS, foreign.ID, fxMember, false)
		if de == nil || de.Code != CodeNotFound {
			t.Fatalf("cross-space: %+v", de)
		}
	})

	t.Run("public channel reads with membership, posts need a roster row", func(t *testing.T) {
		conv, err := f.store.AuthorizeConversationTx(f.ctx(), f.db, fxWS, public.ID, fxMember, false)
		if err != nil || conv.Root.ID != public.ID || conv.IsMember {
			t.Fatalf("public read: %+v %v", conv, err)
		}
		de := f.authorizeErr(fxWS, public.ID, fxMember, true)
		if de == nil || de.Code != CodeForbidden || de.Message != postJoinRequiredMessage {
			t.Fatalf("public post without roster: %+v", de)
		}
		if _, err := f.store.AddHumanTx(f.ctx(), public.ID, fxMember, ""); err != nil {
			t.Fatal(err)
		}
		if _, err := f.store.AuthorizeConversationTx(f.ctx(), f.db, fxWS, public.ID, fxMember, true); err != nil {
			t.Fatalf("public post with roster: %v", err)
		}
	})

	t.Run("hidden #all stays invisible", func(t *testing.T) {
		if _, err := f.db.Exec(`INSERT INTO channels (id, workspace_id, name, type, system_kind, created_at)
			VALUES ('ch-hidden-all', ?, 'all', 'private', 'all', ?)`, fxWS, f.clock.T.UnixMilli()); err != nil {
			t.Fatal(err)
		}
		if de := f.authorizeErr(fxWS, "ch-hidden-all", fxMember, false); de == nil || de.Code != CodeNotFound {
			t.Fatalf("hidden #all read: %+v", de)
		}
		if de := f.authorizeErr(fxWS, "ch-hidden-all", fxOwner, true); de == nil || de.Code != CodeForbidden {
			t.Fatalf("hidden #all post: %+v", de)
		}
	})

	t.Run("guest gate stays closed", func(t *testing.T) {
		if de := f.authorizeErr(fxWS, public.ID, fxGuest, false); de == nil || de.Code != CodeNotFound {
			t.Fatalf("guest read: %+v", de)
		}
		if de := f.authorizeErr(fxWS, public.ID, fxGuest, true); de == nil || de.Code != CodeForbidden {
			t.Fatalf("guest post: %+v", de)
		}
	})

	t.Run("private channel needs a roster row", func(t *testing.T) {
		priv, err := f.store.CreateChannel(f.ctx(), CreateInput{WorkspaceID: fxWS, Name: "secret", Type: TypePrivate, CreatorUserID: fxOwner})
		if err != nil {
			t.Fatal(err)
		}
		if de := f.authorizeErr(fxWS, priv.ID, fxMember, false); de == nil || de.Code != CodeNotFound {
			t.Fatalf("private stranger: %+v", de)
		}
		if _, err := f.store.AddHumanTx(f.ctx(), priv.ID, fxMember, ""); err != nil {
			t.Fatal(err)
		}
		conv, err := f.store.AuthorizeConversationTx(f.ctx(), f.db, fxWS, priv.ID, fxMember, false)
		if err != nil || !conv.IsMember {
			t.Fatalf("private member: %+v %v", conv, err)
		}
	})

	t.Run("archived root keeps history but refuses posting", func(t *testing.T) {
		archived, err := f.store.CreateChannel(f.ctx(), CreateInput{WorkspaceID: fxWS, Name: "gone", Type: TypeChannel, CreatorUserID: fxOwner})
		if err != nil {
			t.Fatal(err)
		}
		if _, err := f.store.AddHumanTx(f.ctx(), archived.ID, fxMember, ""); err != nil {
			t.Fatal(err)
		}
		if _, err := f.store.ArchiveChannel(f.ctx(), fxWS, archived.ID, fxOwner); err != nil {
			t.Fatal(err)
		}
		if _, err := f.store.AuthorizeConversationTx(f.ctx(), f.db, fxWS, archived.ID, fxMember, false); err != nil {
			t.Fatalf("archived read: %v", err)
		}
		de := f.authorizeErr(fxWS, archived.ID, fxMember, true)
		if de == nil || de.Code != CodeConflict || de.Message != "This channel is archived" {
			t.Fatalf("archived post: %+v", de)
		}
		// Error precedence: a NON-member of an archived channel gets the
		// membership 403 first, exactly like the original send route.
		de = f.authorizeErr(fxWS, archived.ID, fxOther, true)
		if de == nil || de.Code != CodeForbidden || de.Message != NotServerMemberMessage {
			t.Fatalf("stranger on archived channel: %+v", de)
		}
		joinedStranger, err := f.store.CreateChannel(f.ctx(), CreateInput{WorkspaceID: fxWS, Name: "gone2", Type: TypeChannel, CreatorUserID: fxOwner})
		if err != nil {
			t.Fatal(err)
		}
		if _, err := f.store.ArchiveChannel(f.ctx(), fxWS, joinedStranger.ID, fxOwner); err != nil {
			t.Fatal(err)
		}
		de = f.authorizeErr(fxWS, joinedStranger.ID, fxMember, true)
		if de == nil || de.Code != CodeForbidden || de.Message != postJoinRequiredMessage {
			t.Fatalf("non-member archived precedence: %+v", de)
		}
	})
}

func TestAuthorizeConversationThreads(t *testing.T) {
	f := newFixture(t)
	parent, err := f.store.CreateChannel(f.ctx(), CreateInput{WorkspaceID: fxWS, Name: "town", Type: TypeChannel, CreatorUserID: fxOwner})
	if err != nil {
		t.Fatal(err)
	}
	parentMsg := f.insertMessage(t, fxWS, parent.ID, "user", fxOwner, "root message")
	thread, err := func() (*Channel, error) {
		var thread *Channel
		err := f.store.withTx(f.ctx(), func(tx *sql.Tx) error {
			var err error
			thread, err = f.store.EnsureThreadTx(f.ctx(), tx, fxWS, parent.ID, parentMsg, fxMember)
			return err
		})
		return thread, err
	}()
	if err != nil {
		t.Fatal(err)
	}

	t.Run("thread inherits the root conversation", func(t *testing.T) {
		conv, err := f.store.AuthorizeConversationTx(f.ctx(), f.db, fxWS, thread.ID, fxMember, false)
		if err != nil || conv.Root.ID != parent.ID || conv.ParentMessageID != parentMsg {
			t.Fatalf("thread read: %+v %v", conv, err)
		}
		// Posting inherits the root: no roster row on the public parent yet.
		de := f.authorizeErr(fxWS, thread.ID, fxMember, true)
		if de == nil || de.Code != CodeForbidden {
			t.Fatalf("thread post before join: %+v", de)
		}
		if _, err := f.store.AddHumanTx(f.ctx(), parent.ID, fxMember, ""); err != nil {
			t.Fatal(err)
		}
		if _, err := f.store.AuthorizeConversationTx(f.ctx(), f.db, fxWS, thread.ID, fxMember, true); err != nil {
			t.Fatalf("thread post after join: %v", err)
		}
	})

	t.Run("missing parent message fails closed", func(t *testing.T) {
		if _, err := f.db.Exec(`INSERT INTO channels (id, workspace_id, name, type, parent_message_id, created_at)
			VALUES ('ch-broken-thread', ?, 'thread-broken', 'thread', 'm-missing', ?)`, fxWS, f.clock.T.UnixMilli()); err != nil {
			t.Fatal(err)
		}
		if de := f.authorizeErr(fxWS, "ch-broken-thread", fxMember, false); de == nil || de.Code != CodeNotFound {
			t.Fatalf("broken chain: %+v", de)
		}
	})

	t.Run("cross-space parent message fails closed", func(t *testing.T) {
		foreign, err := f.store.CreateChannel(f.ctx(), CreateInput{WorkspaceID: fxWS2, Name: "their", Type: TypeChannel, CreatorUserID: fxOther})
		if err != nil {
			t.Fatal(err)
		}
		foreignMsg := f.insertMessage(t, fxWS2, foreign.ID, "user", fxOther, "foreign root")
		threadID := "ch-cross-thread"
		if _, err := f.db.Exec(`INSERT INTO channels (id, workspace_id, name, type, parent_message_id, created_at)
			VALUES (?, ?, 'thread-x', 'thread', ?, ?)`, threadID, fxWS, foreignMsg, f.clock.T.UnixMilli()); err != nil {
			t.Fatal(err)
		}
		if de := f.authorizeErr(fxWS, threadID, fxMember, false); de == nil || de.Code != CodeNotFound {
			t.Fatalf("cross-space parent: %+v", de)
		}
	})

	t.Run("nesting and self-cycles fail closed", func(t *testing.T) {
		if de := f.authorizeErr(fxWS, thread.ID, fxMember, false); de != nil {
			t.Fatalf("healthy thread must authorize: %+v", de)
		}
		// Corrupt a self-cycle: parent message lives in the thread channel.
		cycleMsg := f.insertMessage(t, fxWS, thread.ID, "user", fxMember, "cycle")
		cycleID := "ch-cycle-thread"
		if _, err := f.db.Exec(`INSERT INTO channels (id, workspace_id, name, type, parent_message_id, created_at)
			VALUES (?, ?, 'thread-c', 'thread', ?, ?)`, cycleID, fxWS, cycleMsg, f.clock.T.UnixMilli()); err != nil {
			t.Fatal(err)
		}
		if de := f.authorizeErr(fxWS, cycleID, fxMember, false); de == nil || de.Code != CodeNotFound {
			t.Fatalf("self cycle: %+v", de)
		}
		// A thread whose parent channel is another thread cannot authorize.
		nestedMsg := f.insertMessage(t, fxWS, thread.ID, "user", fxMember, "nested")
		nestedID := "ch-nested-thread"
		if _, err := f.db.Exec(`INSERT INTO channels (id, workspace_id, name, type, parent_message_id, created_at)
			VALUES (?, ?, 'thread-n', 'thread', ?, ?)`, nestedID, fxWS, nestedMsg, f.clock.T.UnixMilli()); err != nil {
			t.Fatal(err)
		}
		if de := f.authorizeErr(fxWS, nestedID, fxMember, false); de == nil || de.Code != CodeNotFound {
			t.Fatalf("nested thread: %+v", de)
		}
	})
}

func TestEnsureDM(t *testing.T) {
	f := newFixture(t)

	t.Run("pair is canonical and idempotent in both directions", func(t *testing.T) {
		first := f.mustEnsureDM(t, fxOwner, fxMember)
		second := f.mustEnsureDM(t, fxMember, fxOwner)
		if first.ID != second.ID {
			t.Fatalf("pair not canonical: %s vs %s", first.ID, second.ID)
		}
		if n := f.countWhere(`SELECT COUNT(*) FROM direct_messages`); n != 1 {
			t.Fatalf("direct_messages rows: %d", n)
		}
		if n := f.countWhere(`SELECT COUNT(*) FROM channel_humans WHERE channel_id = ?`, first.ID); n != 2 {
			t.Fatalf("roster rows: %d", n)
		}
	})

	t.Run("self-DM keeps one roster row", func(t *testing.T) {
		self := f.mustEnsureDM(t, fxMember, fxMember)
		if n := f.countWhere(`SELECT COUNT(*) FROM channel_humans WHERE channel_id = ?`, self.ID); n != 1 {
			t.Fatalf("self roster rows: %d", n)
		}
		if n := f.countWhere(`SELECT COUNT(*) FROM direct_messages WHERE user_low = user_high AND user_low = ?`, fxMember); n != 1 {
			t.Fatalf("self pair rows: %d", n)
		}
	})

	t.Run("eligibility guards", func(t *testing.T) {
		de := f.dmErr(fxOwner, fxOther) // target in another workspace
		if de == nil || de.Code != CodeInvalidInput || de.Message != DMTargetNotMemberMessage {
			t.Fatalf("foreign target: %+v", de)
		}
		de = f.dmErr(fxOwner, fxGuest)
		if de == nil || de.Code != CodeForbidden || de.Message != DMGuestTargetMessage {
			t.Fatalf("guest target: %+v", de)
		}
		de = f.dmErr(fxGuest, fxOwner)
		if de == nil || de.Code != CodeForbidden || de.Message != DMGuestCreateMessage {
			t.Fatalf("guest actor: %+v", de)
		}
	})

	t.Run("soft-deleted DM is restored, not duplicated", func(t *testing.T) {
		dm := f.mustEnsureDM(t, fxOwner, fxMember)
		before := f.countWhere(`SELECT COUNT(*) FROM channels WHERE type = 'dm'`)
		if _, err := f.db.Exec(`UPDATE channels SET deleted_at = ? WHERE id = ?`, f.clock.T.UnixMilli(), dm.ID); err != nil {
			t.Fatal(err)
		}
		restored := f.mustEnsureDM(t, fxOwner, fxMember)
		if restored.ID != dm.ID {
			t.Fatalf("restore mismatch: %s vs %s", restored.ID, dm.ID)
		}
		if after := f.countWhere(`SELECT COUNT(*) FROM channels WHERE type = 'dm'`); after != before {
			t.Fatalf("dm channels before=%d after=%d", before, after)
		}
	})

	t.Run("concurrent ensures converge on one channel", func(t *testing.T) {
		const workers = 8
		ids := make([]string, workers)
		var wg sync.WaitGroup
		var mu sync.Mutex
		errs := []error{}
		for i := 0; i < workers; i++ {
			wg.Add(1)
			go func(i int) {
				defer wg.Done()
				var ch *Channel
				err := f.store.withTx(f.ctx(), func(tx *sql.Tx) error {
					var err error
					ch, err = f.store.EnsureDMTx(f.ctx(), tx, fxWS, fxOwner, fxMember)
					return err
				})
				mu.Lock()
				defer mu.Unlock()
				if err != nil {
					errs = append(errs, err)
					return
				}
				ids[i] = ch.ID
			}(i)
		}
		wg.Wait()
		for _, err := range errs {
			t.Fatalf("concurrent ensure: %v", err)
		}
		for _, id := range ids {
			if id != ids[0] {
				t.Fatalf("diverging channels: %v", ids)
			}
		}
		if n := f.countWhere(`SELECT COUNT(*) FROM direct_messages WHERE user_low = ? AND user_high = ?`, fxOwner, fxMember); n != 1 {
			t.Fatalf("pair rows after race: %d", n)
		}
	})
}

func (f *fixture) mustEnsureDM(t *testing.T, a, b string) *Channel {
	t.Helper()
	var ch *Channel
	if err := f.store.withTx(f.ctx(), func(tx *sql.Tx) error {
		var err error
		ch, err = f.store.EnsureDMTx(f.ctx(), tx, fxWS, a, b)
		return err
	}); err != nil {
		t.Fatal(err)
	}
	return ch
}

func (f *fixture) dmErr(a, b string) *DomainError {
	err := f.store.withTx(f.ctx(), func(tx *sql.Tx) error {
		_, err := f.store.EnsureDMTx(f.ctx(), tx, fxWS, a, b)
		return err
	})
	if err != nil {
		return AsDomainError(err)
	}
	return nil
}

func TestEnsureThread(t *testing.T) {
	f := newFixture(t)
	parent, err := f.store.CreateChannel(f.ctx(), CreateInput{WorkspaceID: fxWS, Name: "town", Type: TypeChannel, CreatorUserID: fxOwner})
	if err != nil {
		t.Fatal(err)
	}
	parentMsg := f.insertMessage(t, fxWS, parent.ID, "user", fxOwner, "root message")

	t.Run("unique thread, projected parent, authored follow only", func(t *testing.T) {
		var thread, again *Channel
		if err := f.store.withTx(f.ctx(), func(tx *sql.Tx) error {
			var err error
			thread, err = f.store.EnsureThreadTx(f.ctx(), tx, fxWS, parent.ID, parentMsg, fxMember)
			if err != nil {
				return err
			}
			again, err = f.store.EnsureThreadTx(f.ctx(), tx, fxWS, parent.ID, parentMsg, fxOwner)
			return err
		}); err != nil {
			t.Fatal(err)
		}
		if thread.ID != again.ID {
			t.Fatalf("thread not unique: %s vs %s", thread.ID, again.ID)
		}
		if !strings.HasPrefix(thread.Name, "thread-") || len(thread.Name) != len("thread-")+8 {
			t.Fatalf("thread name: %q", thread.Name)
		}
		// messages.thread_id is MESSAGE-owned: the channel domain must
		// leave it untouched here. The projection itself is attached in the
		// same application transaction through message.AttachThreadToParentTx
		// and asserted end-to-end by the messaging/HTTP conversation suites.
		var projected sql.NullString
		if err := f.db.QueryRow(`SELECT thread_id FROM messages WHERE id = ?`, parentMsg).Scan(&projected); err != nil {
			t.Fatal(err)
		}
		if projected.Valid {
			t.Fatalf("channel domain wrote messages.thread_id: %+v", projected)
		}
		// Parent author follows (authored); the opener does not.
		if unfollowed, _ := f.threadFollowRow(t, fxOwner, thread.ID); unfollowed.Valid {
			t.Fatal("author follow recorded as unfollowed")
		}
		var openerFollows int
		if err := f.db.QueryRow(`SELECT COUNT(*) FROM thread_follows WHERE user_id = ? AND thread_channel_id = ?`, fxMember, thread.ID).Scan(&openerFollows); err != nil {
			t.Fatal(err)
		}
		if openerFollows != 0 {
			t.Fatal("opener auto-followed")
		}
	})

	t.Run("authored follow never resurrects an explicit unfollow", func(t *testing.T) {
		otherMsg := f.insertMessage(t, fxWS, parent.ID, "user", fxMember, "second root")
		var thread *Channel
		if err := f.store.withTx(f.ctx(), func(tx *sql.Tx) error {
			var err error
			thread, err = f.store.EnsureThreadTx(f.ctx(), tx, fxWS, parent.ID, otherMsg, fxOwner)
			if err != nil {
				return err
			}
			return f.store.SetThreadFollowTx(f.ctx(), tx, fxWS, thread.ID, fxMember, false, false)
		}); err != nil {
			t.Fatal(err)
		}
		// Re-ensure (e.g. someone opens the thread again): the author's
		// explicit unfollow must survive.
		if err := f.store.withTx(f.ctx(), func(tx *sql.Tx) error {
			_, err := f.store.EnsureThreadTx(f.ctx(), tx, fxWS, parent.ID, otherMsg, fxOwner)
			return err
		}); err != nil {
			t.Fatal(err)
		}
		if unfollowed, _ := f.threadFollowRow(t, fxMember, thread.ID); !unfollowed.Valid {
			t.Fatal("explicit unfollow resurrected by authored follow")
		}
	})

	t.Run("guards", func(t *testing.T) {
		var thread *Channel
		if err := f.store.withTx(f.ctx(), func(tx *sql.Tx) error {
			var err error
			thread, err = f.store.EnsureThreadTx(f.ctx(), tx, fxWS, parent.ID, parentMsg, fxMember)
			return err
		}); err != nil {
			t.Fatal(err)
		}
		nested := f.threadErr(fxWS, thread.ID, parentMsg, fxMember)
		if nested == nil || nested.Code != CodeInvalidInput || nested.Message != ThreadNestedMessage {
			t.Fatalf("nested: %+v", nested)
		}
		wrongParent := f.threadErr(fxWS, parent.ID, "m-does-not-exist", fxMember)
		if wrongParent == nil || wrongParent.Code != CodeNotFound || wrongParent.Message != ThreadParentMessageMissing {
			t.Fatalf("missing parent: %+v", wrongParent)
		}
	})

	t.Run("announcement refuses threads", func(t *testing.T) {
		if _, err := f.db.Exec(`INSERT INTO channels (id, workspace_id, name, type, system_kind, created_at)
			VALUES ('ch-announce', ?, 'announcement', 'channel', 'announcement', ?)`, fxWS, f.clock.T.UnixMilli()); err != nil {
			t.Fatal(err)
		}
		msg := f.insertMessage(t, fxWS, "ch-announce", "user", fxOwner, "one-way")
		de := f.threadErr(fxWS, "ch-announce", msg, fxMember)
		if de == nil || de.Code != CodeInvalidInput || de.Message != AnnouncementNoThreadsMsg {
			t.Fatalf("announcement: %+v", de)
		}
	})

	t.Run("concurrent ensures keep one thread per parent", func(t *testing.T) {
		raceMsg := f.insertMessage(t, fxWS, parent.ID, "user", fxOwner, "race root")
		const workers = 8
		ids := make([]string, workers)
		var wg sync.WaitGroup
		for i := 0; i < workers; i++ {
			wg.Add(1)
			go func(i int) {
				defer wg.Done()
				var ch *Channel
				err := f.store.withTx(f.ctx(), func(tx *sql.Tx) error {
					var err error
					ch, err = f.store.EnsureThreadTx(f.ctx(), tx, fxWS, parent.ID, raceMsg, fxMember)
					return err
				})
				if err != nil {
					t.Errorf("concurrent ensure: %v", err)
					return
				}
				ids[i] = ch.ID
			}(i)
		}
		wg.Wait()
		for _, id := range ids {
			if id != ids[0] {
				t.Fatalf("diverging threads: %v", ids)
			}
		}
		if n := f.countWhere(`SELECT COUNT(*) FROM channels WHERE type = 'thread' AND parent_message_id = ?`, raceMsg); n != 1 {
			t.Fatalf("threads for parent: %d", n)
		}
	})
}

func (f *fixture) threadErr(workspaceID, channelID, parentMessageID, userID string) *DomainError {
	err := f.store.withTx(f.ctx(), func(tx *sql.Tx) error {
		_, err := f.store.EnsureThreadTx(f.ctx(), tx, workspaceID, channelID, parentMessageID, userID)
		return err
	})
	if err != nil {
		return AsDomainError(err)
	}
	return nil
}

func TestSetThreadFollowSemantics(t *testing.T) {
	f := newFixture(t)
	parent, err := f.store.CreateChannel(f.ctx(), CreateInput{WorkspaceID: fxWS, Name: "town", Type: TypeChannel, CreatorUserID: fxOwner})
	if err != nil {
		t.Fatal(err)
	}
	parentMsg := f.insertMessage(t, fxWS, parent.ID, "user", fxOwner, "root")
	thread := f.mustThread(t, parent.ID, parentMsg)

	mustFollow := func(follow, automatic bool) {
		t.Helper()
		if err := f.store.withTx(f.ctx(), func(tx *sql.Tx) error {
			return f.store.SetThreadFollowTx(f.ctx(), tx, fxWS, thread.ID, fxMember, follow, automatic)
		}); err != nil {
			t.Fatal(err)
		}
	}

	t.Run("manual follows, explicit unfollow keeps history", func(t *testing.T) {
		mustFollow(true, false)
		if unfollowed, _ := f.threadFollowRow(t, fxMember, thread.ID); unfollowed.Valid {
			t.Fatal("manual follow recorded unfollowed")
		}
		mustFollow(false, false)
		if unfollowed, revision := f.threadFollowRow(t, fxMember, thread.ID); !unfollowed.Valid {
			t.Fatal("explicit unfollow not recorded")
		} else if revision != 2 {
			t.Fatalf("revision after follow+unfollow: %d", revision)
		}
		if n := f.countWhere(`SELECT COUNT(*) FROM thread_follows WHERE user_id = ? AND thread_channel_id = ?`, fxMember, thread.ID); n != 1 {
			t.Fatalf("history row deleted: %d", n)
		}
	})

	t.Run("automatic follow reactivates without churning active rows", func(t *testing.T) {
		// Currently unfollowed: reply-sender rule (automatic) reactivates.
		mustFollow(true, true)
		if unfollowed, revision := f.threadFollowRow(t, fxMember, thread.ID); unfollowed.Valid || revision != 3 {
			t.Fatalf("reactivation: %+v %d", unfollowed, revision)
		}
		// Repeated automatic follows leave the active row untouched.
		mustFollow(true, true)
		mustFollow(true, true)
		if _, revision := f.threadFollowRow(t, fxMember, thread.ID); revision != 3 {
			t.Fatalf("automatic churn: %d", revision)
		}
		// A manual follow refreshes the row like the original upsert.
		mustFollow(true, false)
		if _, revision := f.threadFollowRow(t, fxMember, thread.ID); revision != 4 {
			t.Fatalf("manual refresh: %d", revision)
		}
	})
}

func (f *fixture) mustThread(t *testing.T, parentChannelID, parentMessageID string) *Channel {
	t.Helper()
	var thread *Channel
	if err := f.store.withTx(f.ctx(), func(tx *sql.Tx) error {
		var err error
		thread, err = f.store.EnsureThreadTx(f.ctx(), tx, fxWS, parentChannelID, parentMessageID, fxMember)
		return err
	}); err != nil {
		t.Fatal(err)
	}
	return thread
}

func TestSyncAudienceAndSubscriptions(t *testing.T) {
	f := newFixture(t)
	town, err := f.store.CreateChannel(f.ctx(), CreateInput{WorkspaceID: fxWS, Name: "town", Type: TypeChannel, CreatorUserID: fxOwner})
	if err != nil {
		t.Fatal(err)
	}
	secret, err := f.store.CreateChannel(f.ctx(), CreateInput{WorkspaceID: fxWS, Name: "secret", Type: TypePrivate, CreatorUserID: fxOwner})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := f.store.AddHumanTx(f.ctx(), secret.ID, fxMember, ""); err != nil {
		t.Fatal(err)
	}
	dm := f.mustEnsureDM(t, fxOwner, fxMember)

	townMsg := f.insertMessage(t, fxWS, town.ID, "user", fxOwner, "hello town")
	thread := f.mustThread(t, town.ID, townMsg)

	in := func(list []string, id string) bool {
		for _, v := range list {
			if v == id {
				return true
			}
		}
		return false
	}

	t.Run("base channels and DM are subscriptions, threads are not until followed", func(t *testing.T) {
		subs, err := f.store.ListSubscriptionsTx(f.ctx(), f.db, fxWS, fxMember)
		if err != nil {
			t.Fatal(err)
		}
		if !in(subs, town.ID) || !in(subs, secret.ID) || !in(subs, dm.ID) {
			t.Fatalf("missing base subscriptions: %v", subs)
		}
		if in(subs, thread.ID) {
			t.Fatalf("unfollowed thread in sync audience: %v", subs)
		}
		ok, err := f.store.SelectSyncAudienceTx(f.ctx(), f.db, fxWS, thread.ID, fxMember)
		if err != nil || ok {
			t.Fatalf("unfollowed thread selected: %v %v", ok, err)
		}
	})

	t.Run("following adds the thread; history reads never do", func(t *testing.T) {
		if err := f.store.withTx(f.ctx(), func(tx *sql.Tx) error {
			return f.store.SetThreadFollowTx(f.ctx(), tx, fxWS, thread.ID, fxMember, true, false)
		}); err != nil {
			t.Fatal(err)
		}
		ok, err := f.store.SelectSyncAudienceTx(f.ctx(), f.db, fxWS, thread.ID, fxMember)
		if err != nil || !ok {
			t.Fatalf("followed thread not selected: %v %v", ok, err)
		}
		subs, err := f.store.ListSubscriptionsTx(f.ctx(), f.db, fxWS, fxMember)
		if err != nil || !in(subs, thread.ID) {
			t.Fatalf("followed thread missing: %v %v", subs, err)
		}
		// Reading the thread (authorize for history) must not change anything.
		if _, err := f.store.AuthorizeConversationTx(f.ctx(), f.db, fxWS, thread.ID, fxMember, false); err != nil {
			t.Fatal(err)
		}
		if n := f.countWhere(`SELECT COUNT(*) FROM thread_follows WHERE user_id = ?`, fxMember); n != 1 {
			t.Fatalf("read wrote a follow: %d", n)
		}
	})

	t.Run("unfollow removes interest but not content access", func(t *testing.T) {
		if err := f.store.withTx(f.ctx(), func(tx *sql.Tx) error {
			return f.store.SetThreadFollowTx(f.ctx(), tx, fxWS, thread.ID, fxMember, false, false)
		}); err != nil {
			t.Fatal(err)
		}
		ok, err := f.store.SelectSyncAudienceTx(f.ctx(), f.db, fxWS, thread.ID, fxMember)
		if err != nil || ok {
			t.Fatalf("unfollowed thread still selected: %v %v", ok, err)
		}
		if _, err := f.store.AuthorizeConversationTx(f.ctx(), f.db, fxWS, thread.ID, fxMember, false); err != nil {
			t.Fatalf("unfollow revoked content access: %v", err)
		}
	})

	t.Run("losing the private parent drops the thread from the stream", func(t *testing.T) {
		privMsg := f.insertMessage(t, fxWS, secret.ID, "user", fxOwner, "secret root")
		privThread := f.mustThread(t, secret.ID, privMsg)
		if err := f.store.withTx(f.ctx(), func(tx *sql.Tx) error {
			return f.store.SetThreadFollowTx(f.ctx(), tx, fxWS, privThread.ID, fxMember, true, false)
		}); err != nil {
			t.Fatal(err)
		}
		if ok, _ := f.store.SelectSyncAudienceTx(f.ctx(), f.db, fxWS, privThread.ID, fxMember); !ok {
			t.Fatal("private thread not in audience while member")
		}
		if _, err := f.db.Exec(`DELETE FROM channel_humans WHERE channel_id = ? AND user_id = ?`, secret.ID, fxMember); err != nil {
			t.Fatal(err)
		}
		if ok, err := f.store.SelectSyncAudienceTx(f.ctx(), f.db, fxWS, privThread.ID, fxMember); err == nil && ok {
			t.Fatal("thread survived parent membership loss")
		}
		subs, err := f.store.ListSubscriptionsTx(f.ctx(), f.db, fxWS, fxMember)
		if err != nil {
			t.Fatal(err)
		}
		if in(subs, privThread.ID) {
			t.Fatal("revoked thread in subscription list")
		}
		// History of the now-invisible thread is refused too.
		if de := f.authorizeErr(fxWS, privThread.ID, fxMember, false); de == nil {
			t.Fatal("content access survived parent loss")
		}
	})

	t.Run("guests and strangers get honest empty sets", func(t *testing.T) {
		subs, err := f.store.ListSubscriptionsTx(f.ctx(), f.db, fxWS, fxGuest)
		if err != nil || len(subs) != 0 {
			t.Fatalf("guest subscriptions: %v %v", subs, err)
		}
		subs, err = f.store.ListSubscriptionsTx(f.ctx(), f.db, fxWS, fxOther)
		if err != nil || len(subs) != 0 {
			t.Fatalf("stranger subscriptions: %v %v", subs, err)
		}
	})
}

func TestThreadProjections(t *testing.T) {
	f := newFixture(t)
	town, err := f.store.CreateChannel(f.ctx(), CreateInput{WorkspaceID: fxWS, Name: "town", Type: TypeChannel, CreatorUserID: fxOwner})
	if err != nil {
		t.Fatal(err)
	}
	parentMsg := f.insertMessage(t, fxWS, town.ID, "user", fxOwner, "the root message")
	thread := f.mustThread(t, town.ID, parentMsg)
	f.insertMessage(t, fxWS, thread.ID, "user", fxOwner, "first reply")
	f.insertMessage(t, fxWS, thread.ID, "user", fxMember, "second reply")
	f.insertMessage(t, fxWS, thread.ID, "user", fxOwner, "third reply")
	f.insertMessage(t, fxWS, thread.ID, "user", fxOwner, "fourth reply")

	// Member follows; cursor at 0 = nothing read yet.
	if err := f.store.withTx(f.ctx(), func(tx *sql.Tx) error {
		return f.store.SetThreadFollowTx(f.ctx(), tx, fxWS, thread.ID, fxMember, true, false)
	}); err != nil {
		t.Fatal(err)
	}
	cursor := func(ctx context.Context, ex Executor, workspaceID, userID, channelID string) (int64, error) {
		return 0, nil
	}

	t.Run("summary carries real counts, previews and unread", func(t *testing.T) {
		summaries, err := f.store.ThreadSummariesTx(f.ctx(), f.db, fxWS, town.ID, []string{parentMsg}, fxMember, cursor)
		if err != nil {
			t.Fatal(err)
		}
		s, ok := summaries[parentMsg]
		if !ok {
			t.Fatalf("summary missing: %v", summaries)
		}
		if s.ReplyCount != 4 {
			t.Fatalf("reply count: %d", s.ReplyCount)
		}
		if s.UnreadCount != 4 {
			t.Fatalf("unread (follow, cursor 0): %d", s.UnreadCount)
		}
		if len(s.ParticipantIDs) != 2 {
			t.Fatalf("participants: %v", s.ParticipantIDs)
		}
		if len(s.LatestReplies) != 3 { // bounded preview of the newest 3
			t.Fatalf("latest replies: %d", len(s.LatestReplies))
		}
		if s.LatestReplies[len(s.LatestReplies)-1].Preview != "fourth reply" {
			t.Fatalf("newest preview: %+v", s.LatestReplies)
		}
		// Sender identity resolved from the directory.
		for _, r := range s.LatestReplies {
			if r.SenderType != "user" || r.SenderName == "" {
				t.Fatalf("sender identity: %+v", r)
			}
		}
	})

	t.Run("unread requires an active follow", func(t *testing.T) {
		// The author was auto-followed at ensure time; lose interest first.
		if err := f.store.withTx(f.ctx(), func(tx *sql.Tx) error {
			return f.store.SetThreadFollowTx(f.ctx(), tx, fxWS, thread.ID, fxOwner, false, false)
		}); err != nil {
			t.Fatal(err)
		}
		summaries, err := f.store.ThreadSummariesTx(f.ctx(), f.db, fxWS, town.ID, []string{parentMsg}, fxOwner, cursor)
		if err != nil {
			t.Fatal(err)
		}
		if s := summaries[parentMsg]; s.UnreadCount != 0 || s.FirstUnreadMessageID != nil {
			t.Fatalf("unfollowed viewer unread: %+v", s)
		}
	})

	t.Run("thread info matches the channel view", func(t *testing.T) {
		info, err := f.store.ThreadInfoTx(f.ctx(), f.db, town.ID, parentMsg)
		if err != nil || info == nil {
			t.Fatalf("info: %+v %v", info, err)
		}
		if info.ThreadChannelID != thread.ID || info.ReplyCount != 4 || len(info.ParticipantIDs) != 2 {
			t.Fatalf("info mismatch: %+v", info)
		}
	})

	t.Run("followed list projects real activity and frontiers", func(t *testing.T) {
		threads, err := f.store.FollowedThreadsTx(f.ctx(), f.db, fxWS, fxMember, cursor)
		if err != nil {
			t.Fatal(err)
		}
		if len(threads) != 1 {
			t.Fatalf("followed: %+v", threads)
		}
		got := threads[0]
		if got.ThreadChannelID != thread.ID || got.ParentChannelID != town.ID || got.ParentChannelType != TypeChannel {
			t.Fatalf("identities: %+v", got)
		}
		if got.ReplyCount != 4 || got.UnreadCount != 3 {
			// Unread excludes the viewer's own reply (followed-list rule).
			t.Fatalf("counts: %+v", got)
		}
		if got.LatestActivitySeq == nil || !strings.HasPrefix(*got.LatestActivitySeq, "5") && *got.LatestActivitySeq != "5" {
			t.Fatalf("frontier not a canonical decimal: %+v", got.LatestActivitySeq)
		}
		if got.LatestActivityPreview != "fourth reply" || got.LatestActivityMessageID == "" {
			t.Fatalf("latest activity: %+v", got)
		}
		if got.ParentMessagePreview != "the root message" {
			t.Fatalf("parent preview: %+v", got.ParentMessagePreview)
		}
	})

	t.Run("preview truncation is UTF-16 faithful", func(t *testing.T) {
		if got := truncateUTF16("héllo", 100); got != "héllo" {
			t.Fatalf("short passthrough: %q", got)
		}
		long := strings.Repeat("é", 101)
		if got := truncateUTF16(long, 100); utf16Len(got) != 101 || !strings.HasSuffix(got, "…") {
			t.Fatalf("truncation length: %d", utf16Len(got))
		}
		// Astral pair (emoji) counts as two units and is never split: the
		// 101-unit budget holds 50 whole pairs plus the 1-unit ellipsis.
		emoji := strings.Repeat("\U0001F600", 51) // 102 units
		if got := truncateUTF16(emoji, 101); utf16Len(got) != 101 || !strings.HasSuffix(got, "…") {
			t.Fatalf("astral truncation: units=%d", utf16Len(got))
		}
	})
}

func TestPriorChannelRelationshipWitnesses(t *testing.T) {
	f := newFixture(t)
	town, err := f.store.CreateChannel(f.ctx(), CreateInput{WorkspaceID: fxWS, Name: "town", Type: TypeChannel, CreatorUserID: fxOwner})
	if err != nil {
		t.Fatal(err)
	}
	msg := f.insertMessage(t, fxWS, town.ID, "user", fxOwner, "root")
	thread := f.mustThread(t, town.ID, msg)

	prior, err := f.store.HasPriorChannelRelationshipTx(f.ctx(), f.db, fxOwner, thread.ID)
	if err != nil || !prior {
		t.Fatalf("author follow should witness: %v %v", prior, err)
	}
	prior, err = f.store.HasPriorChannelRelationshipTx(f.ctx(), f.db, fxOther, town.ID)
	if err != nil || prior {
		t.Fatalf("stranger must not witness: %v %v", prior, err)
	}
	dm := f.mustEnsureDM(t, fxOwner, fxMember)
	prior, err = f.store.HasPriorChannelRelationshipTx(f.ctx(), f.db, fxMember, dm.ID)
	if err != nil || !prior {
		t.Fatalf("dm participant should witness: %v %v", prior, err)
	}
}

// publicationCount counts committed realtime_publications rows matching the
// identity of one intent.
func (f *fixture) publicationCount(objectType, objectID, eventType string, revision int64) int {
	f.t.Helper()
	var n int
	if err := f.db.QueryRow(`SELECT COUNT(*) FROM realtime_publications
		WHERE object_type = ? AND object_id = ? AND event_type = ? AND revision = ?`,
		objectType, objectID, eventType, revision).Scan(&n); err != nil {
		f.t.Fatal(err)
	}
	return n
}

func TestFollowPublicationIdentities(t *testing.T) {
	f := newFixture(t)
	parent, err := f.store.CreateChannel(f.ctx(), CreateInput{WorkspaceID: fxWS, Name: "town", Type: TypeChannel, CreatorUserID: fxOwner})
	if err != nil {
		t.Fatal(err)
	}
	parentMsg := f.insertMessage(t, fxWS, parent.ID, "user", fxMember, "root")
	// fxMember authored → authored follow + intent at ensure time.
	thread := f.mustThread(t, parent.ID, parentMsg)

	relID := func(userID string) string { return thread.ID + ":" + userID }

	t.Run("authored ensure emits exactly one intent", func(t *testing.T) {
		if n := f.publicationCount("thread_follow", relID(fxMember), "thread:followers-updated", 1); n != 1 {
			t.Fatalf("authored intent rows: %d", n)
		}
		// Re-ensure (panel open by someone else) must not re-emit.
		if err := f.store.withTx(f.ctx(), func(tx *sql.Tx) error {
			_, err := f.store.EnsureThreadTx(f.ctx(), tx, fxWS, parent.ID, parentMsg, fxOwner)
			return err
		}); err != nil {
			t.Fatal(err)
		}
		if n := f.countWhere(`SELECT COUNT(*) FROM realtime_publications WHERE object_type = 'thread_follow'`); n != 1 {
			t.Fatalf("re-ensure emitted: %d", n)
		}
	})

	t.Run("different users at revision 1 never collide", func(t *testing.T) {
		if err := f.store.withTx(f.ctx(), func(tx *sql.Tx) error {
			return f.store.SetThreadFollowTx(f.ctx(), tx, fxWS, thread.ID, fxOwner, true, false)
		}); err != nil {
			t.Fatal(err)
		}
		// Two relationship objects, both at revision 1.
		if n := f.publicationCount("thread_follow", relID(fxMember), "thread:followers-updated", 1); n != 1 {
			t.Fatalf("member intent: %d", n)
		}
		if n := f.publicationCount("thread_follow", relID(fxOwner), "thread:followers-updated", 1); n != 1 {
			t.Fatalf("owner intent: %d", n)
		}
		if n := f.countWhere(`SELECT COUNT(*) FROM realtime_publications WHERE object_type = 'thread_follow'`); n != 2 {
			t.Fatalf("total follow intents: %d", n)
		}
	})

	t.Run("automatic no-op emits nothing, reactivation does", func(t *testing.T) {
		before := f.countWhere(`SELECT COUNT(*) FROM realtime_publications WHERE object_type = 'thread_follow'`)
		// fxOwner already follows → automatic (reply/mention rule) is a no-op.
		if err := f.store.withTx(f.ctx(), func(tx *sql.Tx) error {
			return f.store.SetThreadFollowTx(f.ctx(), tx, fxWS, thread.ID, fxOwner, true, true)
		}); err != nil {
			t.Fatal(err)
		}
		after := f.countWhere(`SELECT COUNT(*) FROM realtime_publications WHERE object_type = 'thread_follow'`)
		if after != before {
			t.Fatalf("automatic no-op emitted: %d → %d", before, after)
		}
		// Unfollow then automatic (reply) → reactivation emits at revision 3.
		if err := f.store.withTx(f.ctx(), func(tx *sql.Tx) error {
			if err := f.store.SetThreadFollowTx(f.ctx(), tx, fxWS, thread.ID, fxOwner, false, false); err != nil {
				return err
			}
			return f.store.SetThreadFollowTx(f.ctx(), tx, fxWS, thread.ID, fxOwner, true, true)
		}); err != nil {
			t.Fatal(err)
		}
		if n := f.publicationCount("thread_follow", relID(fxOwner), "thread:followers-updated", 3); n != 1 {
			t.Fatalf("reactivation intent at rev 3: %d", n)
		}
		// Unfollow the reactivated row (a REAL transition, emits rev 4) and
		// then unfollow again: the second call is a no-op and must not emit.
		if err := f.store.withTx(f.ctx(), func(tx *sql.Tx) error {
			return f.store.SetThreadFollowTx(f.ctx(), tx, fxWS, thread.ID, fxOwner, false, false)
		}); err != nil {
			t.Fatal(err)
		}
		if n := f.publicationCount("thread_follow", relID(fxOwner), "thread:followers-updated", 4); n != 1 {
			t.Fatalf("real unfollow intent at rev 4: %d", n)
		}
		before = f.countWhere(`SELECT COUNT(*) FROM realtime_publications WHERE object_type = 'thread_follow'`)
		if err := f.store.withTx(f.ctx(), func(tx *sql.Tx) error {
			return f.store.SetThreadFollowTx(f.ctx(), tx, fxWS, thread.ID, fxOwner, false, false)
		}); err != nil {
			t.Fatal(err)
		}
		after = f.countWhere(`SELECT COUNT(*) FROM realtime_publications WHERE object_type = 'thread_follow'`)
		if after != before {
			t.Fatalf("double unfollow emitted: %d → %d", before, after)
		}
	})

	t.Run("thread appearance intent fires on create only", func(t *testing.T) {
		if n := f.publicationCount("channel", thread.ID, "thread:updated", 1); n != 1 {
			t.Fatalf("thread:updated rows: %d", n)
		}
	})
}

func TestDMPublicationAndHiddenPeer(t *testing.T) {
	f := newFixture(t)

	t.Run("create → one intent; ensure → no new; revive → fresh intent", func(t *testing.T) {
		dm := f.mustEnsureDM(t, fxOwner, fxMember)
		if n := f.countWhere(`SELECT COUNT(*) FROM realtime_publications WHERE event_type = 'dm:new' AND object_id = ?`, dm.ID); n != 1 {
			t.Fatalf("create intents: %d", n)
		}
		f.mustEnsureDM(t, fxOwner, fxMember)
		if n := f.countWhere(`SELECT COUNT(*) FROM realtime_publications WHERE event_type = 'dm:new' AND object_id = ?`, dm.ID); n != 1 {
			t.Fatalf("idempotent ensure emitted: %d", n)
		}
		// Soft-delete then revive: the create-time key must NOT suppress it.
		if _, err := f.db.Exec(`UPDATE channels SET deleted_at = ? WHERE id = ?`, f.clock.T.UnixMilli(), dm.ID); err != nil {
			t.Fatal(err)
		}
		restored := f.mustEnsureDM(t, fxOwner, fxMember)
		if restored.ID != dm.ID {
			t.Fatalf("revive mismatch")
		}
		if n := f.countWhere(`SELECT COUNT(*) FROM realtime_publications WHERE event_type = 'dm:new' AND object_id = ?`, dm.ID); n != 2 {
			t.Fatalf("revive intents: %d", n)
		}
	})

	t.Run("passive peer hides the fresh DM, actor and self-DM do not", func(t *testing.T) {
		dm := f.mustEnsureDM(t, fxOwner, fxMember)
		var hidden string
		if err := f.db.QueryRow(`SELECT COALESCE(hidden_dm_ids, '[]')
			FROM workspace_member_preferences WHERE workspace_id = ? AND user_id = ?`, fxWS, fxMember).Scan(&hidden); err != nil {
			t.Fatal(err)
		}
		if !strings.Contains(hidden, dm.ID) {
			t.Fatalf("passive peer hidden_dm_ids: %s", hidden)
		}
		var actorRows int
		if err := f.db.QueryRow(`SELECT COUNT(*) FROM workspace_member_preferences
			WHERE workspace_id = ? AND user_id = ? AND hidden_dm_ids IS NOT NULL`, fxWS, fxOwner).Scan(&actorRows); err != nil {
			t.Fatal(err)
		}
		if actorRows != 0 {
			t.Fatal("actor row hidden the DM")
		}
		self := f.mustEnsureDM(t, fxMember, fxMember)
		var selfHidden int
		if err := f.db.QueryRow(`SELECT COUNT(*) FROM workspace_member_preferences
			WHERE workspace_id = ? AND user_id = ? AND hidden_dm_ids LIKE ?`, fxWS, fxMember, "%"+self.ID+"%").Scan(&selfHidden); err != nil {
			t.Fatal(err)
		}
		if selfHidden != 0 {
			t.Fatal("self-DM hidden for the user themself")
		}
		// Idempotency: recreating the same pair never duplicates the id.
		f.mustEnsureDM(t, fxOwner, fxMember)
		var count int
		if err := f.db.QueryRow(`SELECT json_array_length(COALESCE(hidden_dm_ids, '[]'))
			FROM workspace_member_preferences WHERE workspace_id = ? AND user_id = ?`, fxWS, fxMember).Scan(&count); err != nil {
			t.Fatal(err)
		}
		if count != 1 {
			t.Fatalf("hidden ids after re-ensure: %d", count)
		}
	})
}

func TestPostingScopeHonorsImplicitMembershipChannels(t *testing.T) {
	f := newFixture(t)
	// Enabled #all: a real channel row with implicit server membership.
	if _, err := f.db.Exec(`INSERT INTO channels (id, workspace_id, name, type, system_kind, created_at)
		VALUES ('ch-enabled-all', ?, 'all', 'channel', 'all', ?)`, fxWS, f.clock.T.UnixMilli()); err != nil {
		t.Fatal(err)
	}
	if _, err := f.db.Exec(`INSERT INTO channels (id, workspace_id, name, type, system_kind, created_at)
		VALUES ('ch-announce2', ?, 'announcement', 'channel', 'announcement', ?)`, fxWS, f.clock.T.UnixMilli()); err != nil {
		t.Fatal(err)
	}
	for _, id := range []string{"ch-enabled-all", "ch-announce2"} {
		conv, err := f.store.AuthorizeConversationTx(f.ctx(), f.db, fxWS, id, fxMember, false)
		if err != nil || conv.Root.ID != id {
			t.Fatalf("read %s: %+v %v", id, conv, err)
		}
		for _, actor := range []string{fxOwner, fxMember} {
			if _, err := f.store.AuthorizeConversationTx(f.ctx(), f.db, fxWS, id, actor, true); err != nil {
				t.Fatalf("implicit post %s by %s: %v", id, actor, err)
			}
		}
		if de := f.authorizeErr(fxWS, id, fxGuest, true); de == nil || de.Code != CodeForbidden {
			t.Fatalf("implicit membership must not enable guests: %+v", de)
		}
		var roster int
		if err := f.db.QueryRow(`SELECT COUNT(*) FROM channel_humans WHERE channel_id = ?`, id).Scan(&roster); err != nil || roster != 0 {
			t.Fatalf("implicit posting must not fabricate roster rows: count=%d err=%v", roster, err)
		}
		if _, err := f.db.Exec(`UPDATE channels SET archived_at = ? WHERE id = ?`, f.clock.T.UnixMilli(), id); err != nil {
			t.Fatal(err)
		}
		if de := f.authorizeErr(fxWS, id, fxMember, true); de == nil || de.Code != CodeConflict {
			t.Fatalf("archived implicit channel must remain unwritable: %+v", de)
		}
	}
	// An explicitly joined channel still posts with its roster row.
	joined, err := f.store.CreateChannel(f.ctx(), CreateInput{WorkspaceID: fxWS, Name: "joined", Type: TypeChannel, CreatorUserID: fxOwner})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := f.store.AddHumanTx(f.ctx(), joined.ID, fxMember, ""); err != nil {
		t.Fatal(err)
	}
	if _, err := f.store.AuthorizeConversationTx(f.ctx(), f.db, fxWS, joined.ID, fxMember, true); err != nil {
		t.Fatalf("joined post: %v", err)
	}
}

func TestPriorRelationshipResidueWitnesses(t *testing.T) {
	f := newFixture(t)
	// fxGuest holds a plain membership so the route-level actor checks pass;
	// residue tests drive HasPriorChannelRelationshipTx directly.
	parent, err := f.store.CreateChannel(f.ctx(), CreateInput{WorkspaceID: fxWS, Name: "town", Type: TypeChannel, CreatorUserID: fxOwner})
	if err != nil {
		t.Fatal(err)
	}
	msg := f.insertMessage(t, fxWS, parent.ID, "user", fxOwner, "root")
	thread := f.mustThread(t, parent.ID, msg)

	witness := func(user string) bool {
		t.Helper()
		got, err := f.store.HasPriorChannelRelationshipTx(f.ctx(), f.db, user, thread.ID)
		if err != nil {
			t.Fatal(err)
		}
		return got
	}

	// Baseline: the author follows (fixture invariant), a stranger with no
	// residue does not witness even after reading history via the API would
	// be impossible — here directly.
	if !witness(fxOwner) {
		t.Fatal("author follow should witness")
	}

	t.Run("history-only ex-member does not witness", func(t *testing.T) {
		// A member who joined, left, and never left read/done/mention rows.
		if _, err := f.db.Exec(`INSERT INTO channel_humans (channel_id, user_id, role, authority_revision, joined_at)
			VALUES (?, ?, 'member', 1, 1)`, parent.ID, fxMember); err != nil {
			t.Fatal(err)
		}
		if _, err := f.db.Exec(`DELETE FROM channel_humans WHERE channel_id = ? AND user_id = ?`, parent.ID, fxMember); err != nil {
			t.Fatal(err)
		}
		if witness(fxMember) {
			t.Fatal("history-only ex-member witnessed")
		}
	})

	t.Run("own read residue witnesses, another user's does not", func(t *testing.T) {
		if _, err := f.db.Exec(`INSERT INTO user_channel_read_states
			(workspace_id, user_id, channel_id, last_read_seq, read_state_version, updated_at)
			VALUES (?, ?, ?, 5, 1, 1)`, fxWS, fxMember, thread.ID); err != nil {
			t.Fatal(err)
		}
		if !witness(fxMember) {
			t.Fatal("own read residue did not witness")
		}
		if witness(fxGuest) {
			t.Fatal("another user's residue witnessed")
		}
	})

	t.Run("done and mention residues witness", func(t *testing.T) {
		if _, err := f.db.Exec(`INSERT INTO user_channel_done_states
			(workspace_id, user_id, channel_id, done_through_activity_seq, done_at, active_override, revision, updated_at)
			VALUES (?, ?, ?, 5, 1, 0, 1, 1)`, fxWS, fxGuest, thread.ID); err != nil {
			t.Fatal(err)
		}
		if !witness(fxGuest) {
			t.Fatal("own done residue did not witness")
		}
		if _, err := f.db.Exec(`INSERT INTO user_mention_suppressions
			(workspace_id, user_id, target_kind, channel_id, done_through_seq, done_at, updated_at)
			VALUES (?, ?, 'thread', ?, 3, 1, 1)`, fxWS, fxOther, thread.ID); err != nil {
			t.Fatal(err)
		}
		if !witness(fxOther) {
			t.Fatal("own mention residue did not witness")
		}
	})
}
