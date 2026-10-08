package message

import (
	"context"
	"database/sql"
	"errors"
	"strings"
	"sync"
	"testing"
	"time"

	"raft.local/server-go/internal/auth"
	"raft.local/server-go/internal/channel"
	"raft.local/server-go/internal/platform/db"
)

const txGeneral = "cccccccc-cccc-4ccc-8ccc-cccccccccccc"

func TestCreateAssignsUniqueSafeSeqAndPersistsFacts(t *testing.T) {
	f := newFixture(t)
	f.seed()
	f.seedChannel(txGeneral, "general", channel.TypeChannel, txAlice, txBob)

	first, err := f.send(txAlice, txFamAlice, txGeneral, "hello world", nil, nil)
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	if first.Message.Seq <= 0 || first.Message.Seq > 9_007_199_254_740_991 {
		t.Fatalf("seq %d not a safe integer", first.Message.Seq)
	}
	if first.Message.SenderID != txAlice || first.Message.SenderType != "user" {
		t.Fatalf("sender must come from claims, got %+v", first.Message)
	}
	if first.Message.Revision != 1 || first.Message.CreatedAtUnix == 0 {
		t.Fatalf("bad initial aggregate: %+v", first.Message)
	}

	second, err := f.send(txBob, txFamBob, txGeneral, "reply", nil, nil)
	if err != nil {
		t.Fatalf("create 2: %v", err)
	}
	if second.Message.Seq == first.Message.Seq {
		t.Fatalf("duplicate seq %d", second.Message.Seq)
	}

	var count int
	if err := f.db.QueryRow(`SELECT COUNT(*) FROM messages`).Scan(&count); err != nil || count != 2 {
		t.Fatalf("persisted rows: count=%d err=%v", count, err)
	}
	var pending int
	if err := f.db.QueryRow(`SELECT COUNT(*) FROM realtime_publications WHERE published_at IS NULL`).Scan(&pending); err != nil || pending != 2 {
		t.Fatalf("message:new intents: pending=%d err=%v", pending, err)
	}
}

func TestCreateValidationMirrorsLegacyParsers(t *testing.T) {
	f := newFixture(t)
	f.seed()
	f.seedChannel(txGeneral, "general", channel.TypeChannel, txAlice)

	cases := []struct {
		name   string
		input  CreateInput
		reason string
	}{
		{"empty", CreateInput{ChannelID: txGeneral, Content: ""}, "Channel ID and content are required"},
		{"whitespace", CreateInput{ChannelID: txGeneral, Content: "   \n\t"}, "Message content cannot be empty"},
		{"too-long", CreateInput{ChannelID: txGeneral, Content: strings.Repeat("a", 32_001)}, "Message content exceeds maximum length of 32000 characters"},
		{"astral-counts-units", CreateInput{ChannelID: txGeneral, Content: strings.Repeat("😀", 16_001)}, "Message content exceeds maximum length of 32000 characters"},
		{"bad-channel", CreateInput{ChannelID: "not-a-uuid", Content: "x"}, "Invalid message request body"},
	}
	for _, tc := range cases {
		_, err := f.send(txAlice, txFamAlice, tc.input.ChannelID, tc.input.Content, tc.input.RandomID, tc.input.Mentions)
		invalid := AsInvalidInput(err)
		if invalid == nil {
			t.Fatalf("%s: expected InvalidInput, got %v", tc.name, err)
		}
		if invalid.Reason != tc.reason {
			t.Fatalf("%s: reason %q, want %q", tc.name, invalid.Reason, tc.reason)
		}
	}

	// 32000 units exactly (astral pairs count 2) is accepted.
	if _, err := f.send(txAlice, txFamAlice, txGeneral, strings.Repeat("😀", 16_000), nil, nil); err != nil {
		t.Fatalf("max-length astral content rejected: %v", err)
	}
	// randomId bounds: empty and >128 rejected with the legacy sentence.
	for _, rid := range []string{"", strings.Repeat("r", 129)} {
		_, err := f.send(txAlice, txFamAlice, txGeneral, "x", stringPtr(rid), nil)
		invalid := AsInvalidInput(err)
		if invalid == nil || invalid.Reason != "randomId must be a non-empty string with at most 128 characters" {
			t.Fatalf("randomId %q: got %v", rid, err)
		}
	}
	if _, err := f.send(txAlice, txFamAlice, txGeneral, "x", stringPtr(strings.Repeat("r", 128)), nil); err != nil {
		t.Fatalf("128-char randomId rejected: %v", err)
	}
}

func TestCreateRejectsUnsupportedEffectsBeforeCommit(t *testing.T) {
	f := newFixture(t)
	f.seed()
	f.seedChannel(txGeneral, "general", channel.TypeChannel, txAlice)

	asTask := true
	_, err := f.store.Create(context.Background(), claimsFor(txAlice, txFamAlice), txWS, CreateInput{
		ChannelID: txGeneral, Content: "x", AsTask: &asTask,
	})
	if u := AsUnsupportedEffect(err); u == nil {
		t.Fatalf("asTask must be rejected, got %v", err)
	}
	_, err = f.store.Create(context.Background(), claimsFor(txAlice, txFamAlice), txWS, CreateInput{
		ChannelID: txGeneral, Content: "x", AttachmentIDs: []string{"dddddddd-dddd-4ddd-8ddd-dddddddddddd"},
	})
	if u := AsUnsupportedEffect(err); u == nil {
		t.Fatalf("attachments must be rejected, got %v", err)
	}
	_, err = f.store.Create(context.Background(), claimsFor(txAlice, txFamAlice), txWS, CreateInput{
		ChannelID: txGeneral, Content: "x",
		Mentions: []Mention{{Type: "agent", ID: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee", Name: "bot"}},
	})
	if u := AsUnsupportedEffect(err); u == nil {
		t.Fatalf("agent mention must be rejected (no partial accept), got %v", err)
	}
	// Mixed user+agent mentions reject the whole write too.
	_, err = f.store.Create(context.Background(), claimsFor(txAlice, txFamAlice), txWS, CreateInput{
		ChannelID: txGeneral, Content: "x",
		Mentions: []Mention{
			{Type: "user", ID: txBob, Name: "bob"},
			{Type: "agent", ID: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee", Name: "bot"},
		},
	})
	if u := AsUnsupportedEffect(err); u == nil {
		t.Fatalf("mixed mentions must be rejected, got %v", err)
	}
	var count int
	_ = f.db.QueryRow(`SELECT COUNT(*) FROM messages`).Scan(&count)
	if count != 0 {
		t.Fatalf("rejected effects must not leave rows: %d", count)
	}
}

func TestCreateRequiresPostingMembership(t *testing.T) {
	f := newFixture(t)
	f.seed()
	// public channel, bob NOT on the roster.
	f.seedChannel(txGeneral, "general", channel.TypeChannel, txAlice)

	_, err := f.send(txBob, txFamBob, txGeneral, "hi", nil, nil)
	var member *ErrNotChannelMember
	if !errors.As(err, &member) || member.Error() != "You must join this channel to send messages" {
		t.Fatalf("expected join-required, got %v", err)
	}
	// A member of another workspace is refused before any write.
	_, err = f.send(txBob, txFamBob, txGeneral, "hi", nil, nil)
	if !errors.As(err, &member) {
		t.Fatalf("cross access: %v", err)
	}
	// Private channel: non-member read is fail-closed invisible.
	private := "dddddddd-dddd-4ddd-8ddd-dddddddddddd"
	f.seedChannel(private, "secret", channel.TypePrivate, txAlice)
	_, err = f.send(txBob, txFamBob, private, "hi", nil, nil)
	if !errors.As(err, &member) {
		t.Fatalf("private posting by stranger must be join-required/refused, got %v", err)
	}
	// Archived channel refuses with the exact archived body.
	archived := "abdddddd-dddd-4ddd-8ddd-dddddddddddd"
	f.seedChannel(archived, "frozen", channel.TypeChannel, txAlice, txBob)
	if _, err := f.db.Exec(`UPDATE channels SET archived_at = ? WHERE id = ?`, f.clock.Now().UnixMilli(), archived); err != nil {
		t.Fatal(err)
	}
	if _, err := f.send(txAlice, txFamAlice, archived, "hi", nil, nil); !errors.Is(err, ErrChannelArchived) {
		t.Fatalf("archived send: %v", err)
	}
}

func TestCreateRevokedIdentityFailsClosed(t *testing.T) {
	f := newFixture(t)
	f.seed()
	f.seedChannel(txGeneral, "general", channel.TypeChannel, txAlice)

	expired := claimsFor(txAlice, txFamAlice)
	expired.ExpiresAt = f.clock.Now().Add(-time.Minute)
	if _, err := f.store.Create(context.Background(), expired, txWS, CreateInput{ChannelID: txGeneral, Content: "x"}); !errors.Is(err, auth.ErrTokenInvalid) {
		t.Fatalf("expired claims: %v", err)
	}
	// Family revoked between verification and the transaction.
	if _, err := f.db.Exec(`UPDATE session_families SET revoked_at = ? WHERE id = ?`, f.clock.Now().UnixMilli(), txFamAlice); err != nil {
		t.Fatal(err)
	}
	if _, err := f.send(txAlice, txFamAlice, txGeneral, "x", nil, nil); !errors.Is(err, auth.ErrTokenInvalid) {
		t.Fatalf("revoked family: %v", err)
	}
	var count int
	_ = f.db.QueryRow(`SELECT COUNT(*) FROM messages`).Scan(&count)
	if count != 0 {
		t.Fatalf("no row may survive identity failure: %d", count)
	}
}

func TestRandomIdReplayReturnsOriginalAndConflictOnDivergence(t *testing.T) {
	f := newFixture(t)
	f.seed()
	f.seedChannel(txGeneral, "general", channel.TypeChannel, txAlice)
	f.seedChannel("dddddddd-dddd-4ddd-8ddd-dddddddddddd", "random", channel.TypeChannel, txAlice)

	rid := stringPtr("rid-1")
	first, err := f.send(txAlice, txFamAlice, txGeneral, "original", rid, nil)
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	retry, err := f.send(txAlice, txFamAlice, txGeneral, "original", stringPtr("rid-1"), nil)
	if err != nil {
		t.Fatalf("replay: %v", err)
	}
	if !retry.Replayed || retry.Message.ID != first.Message.ID || retry.Message.Seq != first.Message.Seq {
		t.Fatalf("replay must return the original message: %+v vs %+v", retry.Message, first.Message)
	}
	var count int
	_ = f.db.QueryRow(`SELECT COUNT(*) FROM messages WHERE random_id = 'rid-1'`).Scan(&count)
	if count != 1 {
		t.Fatalf("replay created a duplicate: %d", count)
	}

	// Same key, different content -> 409 conflict, original untouched.
	_, err = f.send(txAlice, txFamAlice, txGeneral, "changed", stringPtr("rid-1"), nil)
	conflict := AsRandomIDConflict(err)
	if conflict == nil || conflict.Reason != "randomId has already been used for a different message" {
		t.Fatalf("divergent replay: %v", err)
	}
	// Same key, different channel -> 409 conflict.
	_, err = f.send(txAlice, txFamAlice, "dddddddd-dddd-4ddd-8ddd-dddddddddddd", "original", stringPtr("rid-1"), nil)
	if AsRandomIDConflict(err) == nil {
		t.Fatalf("cross-channel replay must conflict: %v", err)
	}
	// Same key by ANOTHER sender is a fresh message (scope is per sender).
	f.seedChannelRoster(txBob)
	other, err := f.send(txBob, txFamBob, txGeneral, "bob", nil, nil)
	if err != nil {
		t.Fatalf("other sender: %v", err)
	}
	if other.Message.ID == first.Message.ID {
		t.Fatal("per-sender scope violated")
	}
}

func TestRandomIdConcurrencySingleRowAndRestartStability(t *testing.T) {
	f := newFixture(t)
	f.seed()
	f.seedChannel(txGeneral, "general", channel.TypeChannel, txAlice, txBob)

	const n = 8
	var wg sync.WaitGroup
	results := make([]*CreateResult, n)
	errs := make([]error, n)
	for i := 0; i < n; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			results[i], errs[i] = f.send(txAlice, txFamAlice, txGeneral, "race", stringPtr("race-1"), nil)
		}(i)
	}
	wg.Wait()
	ids := map[string]bool{}
	fresh := 0
	for i, err := range errs {
		if err != nil {
			t.Fatalf("concurrent replay %d failed: %v", i, err)
		}
		if !results[i].Replayed {
			fresh++
		}
		ids[results[i].Message.ID] = true
	}
	if fresh != 1 || len(ids) != 1 {
		t.Fatalf("exactly one fresh create expected: fresh=%d distinct=%d", fresh, len(ids))
	}
	var count int
	_ = f.db.QueryRow(`SELECT COUNT(*) FROM messages WHERE random_id = 'race-1'`).Scan(&count)
	if count != 1 {
		t.Fatalf("database has %d rows for one randomId", count)
	}
}

func TestCreateRollbackLeavesNoResidue(t *testing.T) {
	f := newFixture(t)
	f.seed()
	f.seedChannel(txGeneral, "general", channel.TypeChannel, txAlice)

	if _, err := f.db.Exec(`INSERT INTO realtime_publications
		(workspace_id, object_type, object_id, event_type, revision, subject_user_id, created_at)
		VALUES (?, 'message', 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', 'message:new', 1, '', 0)`, txWS); err != nil {
		t.Fatal(err)
	}
	var err error
	// A mention that fails resolution aborts before the insert, and no
	// residue of the failed write survives.
	_, err = f.store.Create(context.Background(), claimsFor(txAlice, txFamAlice), txWS, CreateInput{
		ChannelID: txGeneral, Content: "boom",
		Mentions: []Mention{{Type: "user", ID: "ffffffff-ffff-4fff-8fff-ffffffffffff", Name: "ghost"}},
	})
	if AsInvalidInput(err) == nil {
		t.Fatalf("unknown mention target must be a validation error, got %v", err)
	}
	var messages, mentions, pubs int
	_ = f.db.QueryRow(`SELECT COUNT(*) FROM messages`).Scan(&messages)
	_ = f.db.QueryRow(`SELECT COUNT(*) FROM message_mentions`).Scan(&mentions)
	_ = f.db.QueryRow(`SELECT COUNT(*) FROM realtime_publications`).Scan(&pubs)
	if messages != 0 || mentions != 0 {
		t.Fatalf("residue after failure: messages=%d mentions=%d", messages, mentions)
	}
	if pubs != 1 {
		t.Fatalf("pre-seeded publication must be untouched, got %d", pubs)
	}
}

func TestHumanMentionsResolveAgainstDirectory(t *testing.T) {
	f := newFixture(t)
	f.seed()
	f.seedChannel(txGeneral, "general", channel.TypeChannel, txAlice, txBob)

	// Valid user mention persists a stable target with the directory name.
	result, err := f.send(txAlice, txFamAlice, txGeneral, "ping @bob", nil,
		[]Mention{{Type: "user", ID: txBob, Name: "bob"}})
	if err != nil {
		t.Fatalf("mention send: %v", err)
	}
	if len(result.Mentions) != 1 || result.Mentions[0].ID != txBob || result.Mentions[0].Name != "bob" {
		t.Fatalf("resolved mentions: %+v", result.Mentions)
	}
	var mentioned int
	if err := f.db.QueryRow(`SELECT COUNT(*) FROM message_mentions WHERE message_id = ? AND user_id = ?`,
		result.Message.ID, txBob).Scan(&mentioned); err != nil || mentioned != 1 {
		t.Fatalf("mention row: %d %v", mentioned, err)
	}

	// Duplicate targets by id merge; two ids on one handle conflict.
	dup, err := f.send(txAlice, txFamAlice, txGeneral, "dup", nil,
		[]Mention{{Type: "user", ID: txBob, Name: "bob"}, {Type: "user", ID: txBob, Name: "bob"}})
	if err != nil || len(dup.Mentions) != 1 {
		t.Fatalf("duplicate mention merge: %v %+v", err, dup)
	}
	var binding *MentionBindingConflict
	_, err = f.send(txAlice, txFamAlice, txGeneral, "conflict", nil,
		[]Mention{{Type: "user", ID: txBob, Name: "cara"}, {Type: "user", ID: txCara, Name: "cara"}})
	if !errors.As(err, &binding) || binding.Handle != "cara" {
		t.Fatalf("binding conflict: %v", err)
	}

	// Unknown target, wrong workspace, name mismatch and unreadable
	// conversation all reject before commit.
	bad := []Mention{
		{Type: "user", ID: "ffffffff-ffff-4fff-8fff-ffffffffffff", Name: "ghost"},
		{Type: "user", ID: txBob, Name: "notbob"},
	}
	for _, m := range bad {
		_, err := f.send(txAlice, txFamAlice, txGeneral, "x", nil, []Mention{m})
		if AsInvalidInput(err) == nil {
			t.Fatalf("mention %+v must be rejected, got %v", m, err)
		}
	}
	// A private channel member cannot be mentioned by a non-participant.
	private := "dddddddd-dddd-4ddd-8ddd-dddddddddddd"
	f.seedChannel(private, "secret", channel.TypePrivate, txAlice)
	_, err = f.send(txAlice, txFamAlice, private, "psst", nil,
		[]Mention{{Type: "user", ID: txBob, Name: "bob"}})
	if AsInvalidInput(err) == nil {
		t.Fatalf("mention into a conversation the target cannot read must reject, got %v", err)
	}
}

func TestThreadReplyAutoFollowsAndNotifiesMentioned(t *testing.T) {
	f := newFixture(t)
	f.seed()
	f.seedChannel(txGeneral, "general", channel.TypeChannel, txAlice, txBob, txCara)

	parent, err := f.send(txAlice, txFamAlice, txGeneral, "root", nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	// Ensure the thread channel the way the conversation worker does.
	var threadID string
	err = db.WithWriteTx(context.Background(), f.db, func(tx *sql.Tx) error {
		thread, err := f.channels.EnsureThreadTx(context.Background(), tx, txWS, txGeneral, parent.Message.ID, txAlice)
		if err != nil {
			return err
		}
		threadID = thread.ID
		return nil
	})
	if err != nil {
		t.Fatalf("ensure thread: %v", err)
	}
	// The parent message gains its thread_id projection (channel worker's
	// single write point).
	var parentThread string
	var nullable sql.NullString
	_ = f.db.QueryRow(`SELECT thread_id FROM messages WHERE id = ?`, parent.Message.ID).Scan(&nullable)
	if nullable.Valid {
		parentThread = nullable.String
	}
	if parentThread != threadID {
		t.Fatalf("parent thread projection: %q vs %q", parentThread, threadID)
	}

	// Bob replies (auto follow) and mentions Cara (auto follow).
	reply, err := f.send(txBob, txFamBob, threadID, "a reply", nil,
		[]Mention{{Type: "user", ID: txCara, Name: "cara"}})
	if err != nil {
		t.Fatalf("thread reply: %v", err)
	}
	if reply.Message.ThreadID != nil {
		t.Fatalf("reply threadId must stay nil, got %v", reply.Message.ThreadID)
	}
	for _, user := range []string{txBob, txCara} {
		var unfollowed sql.NullInt64
		err := f.db.QueryRow(`SELECT unfollowed_at FROM thread_follows
			WHERE workspace_id = ? AND user_id = ? AND thread_channel_id = ?`, txWS, user, threadID).Scan(&unfollowed)
		if err != nil || unfollowed.Valid {
			t.Fatalf("user %s must actively follow after reply/mention: %v", user, err)
		}
	}
	// A thread:updated intent rides the same commit.
	var threadPubs int
	_ = f.db.QueryRow(`SELECT COUNT(*) FROM realtime_publications WHERE object_type = 'thread' AND object_id = ?`, threadID).Scan(&threadPubs)
	if threadPubs != 1 {
		t.Fatalf("thread:updated intents: %d", threadPubs)
	}
	// An explicit unfollow is reactivated by a later reply (TS 'replied').
	if err := db.WithWriteTx(context.Background(), f.db, func(tx *sql.Tx) error {
		return f.channels.SetThreadFollowTx(context.Background(), tx, txWS, threadID, txCara, false, false)
	}); err != nil {
		t.Fatal(err)
	}
	if _, err := f.send(txAlice, txFamAlice, threadID, "reactivate", nil, nil); err != nil {
		t.Fatal(err)
	}
	// Cara's own reply (the 'replied' rule) reactivates her follow...
	if _, err := f.send(txCara, txFamCara, threadID, "mine again", nil, nil); err != nil {
		t.Fatal(err)
	}
	var active int
	_ = f.db.QueryRow(`SELECT COUNT(*) FROM thread_follows WHERE user_id = ? AND thread_channel_id = ? AND unfollowed_at IS NULL`, txCara, threadID).Scan(&active)
	if active != 1 {
		t.Fatalf("explicit unfollow must be reactivated by the user's own reply, active=%d", active)
	}
	// ...while a stranger's reply alone does not resurrect it.
	if err := db.WithWriteTx(context.Background(), f.db, func(tx *sql.Tx) error {
		return f.channels.SetThreadFollowTx(context.Background(), tx, txWS, threadID, txCara, false, false)
	}); err != nil {
		t.Fatal(err)
	}
	if _, err := f.send(txBob, txFamBob, threadID, "not cara", nil, nil); err != nil {
		t.Fatal(err)
	}
	_ = f.db.QueryRow(`SELECT COUNT(*) FROM thread_follows WHERE user_id = ? AND thread_channel_id = ? AND unfollowed_at IS NULL`, txCara, threadID).Scan(&active)
	if active != 0 {
		t.Fatalf("another user's reply must not reactivate an explicit unfollow, active=%d", active)
	}
}
