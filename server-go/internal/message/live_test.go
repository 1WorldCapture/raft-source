package message

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"strings"
	"testing"

	"raft.local/server-go/internal/channel"
	"raft.local/server-go/internal/platform/db"
)

// TestLiveEligibilityDistinctFromSyncAudience freezes the two interest
// rules: sync/resume requires an active follow on EVERY thread; live admits
// base-authorized explicit viewers on PUBLIC-root threads, while private/DM
// roots stay follower-only.
func TestLiveEligibilityDistinctFromSyncAudience(t *testing.T) {
	f := newFixture(t)
	f.seed()
	f.seedChannel(txGeneral, "general", channel.TypeChannel, txAlice, txBob)
	private := "dddddddd-dddd-4ddd-8ddd-dddddddddddd"
	f.seedChannel(private, "secret", channel.TypePrivate, txAlice)

	bob := NewClaims(claimsFor(txBob, txFamBob))

	pubParent := f.sendMsg(t, txGeneral, "public root")
	privParent := f.sendMsg(t, private, "private root")

	ensureThread := func(parentID string) string {
		var threadID string
		if err := db.WithWriteTx(context.Background(), f.db, func(tx *sql.Tx) error {
			thread, err := f.channels.EnsureThreadTx(context.Background(), tx, txWS, channelOf(f, parentID), parentID, txAlice)
			if err != nil {
				return err
			}
			threadID = thread.ID
			return nil
		}); err != nil {
			t.Fatal(err)
		}
		return threadID
	}
	pubThread := ensureThread(pubParent.ID)
	privThread := ensureThread(privParent.ID)

	// Bob (base-authorized, NOT following) on the public-root thread.
	live, err := f.store.LiveEligibilityForChannel(context.Background(), txWS, pubThread, txBob)
	if err != nil {
		t.Fatal(err)
	}
	if !live.Eligible || live.ViaFollow {
		t.Fatalf("public-root thread live must admit explicit viewers: %+v", live)
	}
	// ...but the sync/resume audience still excludes him.
	syncOK, err := f.store.AudienceForChannel(context.Background(), txWS, pubThread, txBob)
	if err != nil {
		t.Fatal(err)
	}
	if syncOK {
		t.Fatal("unfollowed thread must stay out of the sync audience")
	}

	// Private-root thread: bob is base-authorized (root member? no — private
	// roster is alice-only, so bob has NO base read) -> not eligible at all.
	live, err = f.store.LiveEligibilityForChannel(context.Background(), txWS, privThread, txBob)
	if err != nil {
		t.Fatal(err)
	}
	if live.Eligible {
		t.Fatalf("private-root thread must refuse non-readers: %+v", live)
	}

	// Add bob to the private root roster: base read ok, still not following
	// -> live refuses (follower-only), sync refuses.
	if _, err := f.db.Exec(`INSERT INTO channel_humans (channel_id, user_id, role, joined_at) VALUES (?,?,'member',1)`, private, txBob); err != nil {
		t.Fatal(err)
	}
	live, err = f.store.LiveEligibilityForChannel(context.Background(), txWS, privThread, txBob)
	if err != nil {
		t.Fatal(err)
	}
	if live.Eligible || live.ViaFollow {
		t.Fatalf("private-root thread live is follower-only: %+v", live)
	}
	if err := db.WithWriteTx(context.Background(), f.db, func(tx *sql.Tx) error {
		return f.channels.SetThreadFollowTx(context.Background(), tx, txWS, privThread, txBob, true, false)
	}); err != nil {
		t.Fatal(err)
	}
	live, err = f.store.LiveEligibilityForChannel(context.Background(), txWS, privThread, txBob)
	if err != nil {
		t.Fatal(err)
	}
	if !live.Eligible || !live.ViaFollow {
		t.Fatalf("active follower must be live-eligible: %+v", live)
	}
	syncOK, _ = f.store.AudienceForChannel(context.Background(), txWS, privThread, txBob)
	if !syncOK {
		t.Fatal("active follower joins the sync audience")
	}
	// Unfollow drops both live and sync; base content read survives.
	if err := db.WithWriteTx(context.Background(), f.db, func(tx *sql.Tx) error {
		return f.channels.SetThreadFollowTx(context.Background(), tx, txWS, privThread, txBob, false, false)
	}); err != nil {
		t.Fatal(err)
	}
	live, _ = f.store.LiveEligibilityForChannel(context.Background(), txWS, privThread, txBob)
	syncOK, _ = f.store.AudienceForChannel(context.Background(), txWS, privThread, txBob)
	if live.Eligible || syncOK {
		t.Fatalf("unfollow drops live and sync: %+v sync=%v", live, syncOK)
	}
	if _, err := f.store.ListChannelPage(context.Background(), bob, txWS, privThread, PageQuery{Limit: 10}); err != nil {
		t.Fatalf("history read must survive unfollow: %v", err)
	}
	// Non-thread conversations: live equals base read.
	live, err = f.store.LiveEligibilityForChannel(context.Background(), txWS, txGeneral, txBob)
	if err != nil || !live.Eligible || live.ViaFollow {
		t.Fatalf("public channel live: %+v %v", live, err)
	}
	live, err = f.store.LiveEligibilityForChannel(context.Background(), txWS, "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee", txBob)
	if err != nil || live.Eligible {
		t.Fatalf("missing channel: %+v %v", live, err)
	}
}

func channelOf(f *fixture, messageID string) string {
	var channelID string
	if err := f.db.QueryRow(`SELECT channel_id FROM messages WHERE id = ?`, messageID).Scan(&channelID); err != nil {
		f.t.Fatal(err)
	}
	return channelID
}

// TestSyncHTTPReadsSparseDatasetBehindAdversarialBulk covers the two shapes
// that a fixed scan quota used to exclude forever: >20000 invisible rows and
// >512 invisible distinct channels. The HTTP scan pre-filters through the
// channel worker's subscription SQL, so the invisible bulk never reaches the
// LIMIT and the authorized rows come back through the original bare-array
// cursor protocol.
func TestSyncHTTPReadsSparseDatasetBehindAdversarialBulk(t *testing.T) {
	f := newFixture(t)
	f.seed()

	// Shape 1: >20000 invisible rows (private channel the member cannot
	// stream) before the visible message.
	flood := "dddddddd-dddd-4ddd-8ddd-dddddddddddd"
	f.seedChannel(flood, "flood", channel.TypePrivate, txAlice)
	f.seedChannel(txGeneral, "general", channel.TypeChannel, txBob, txAlice)
	const floodRows = syncScanRowBudget + 1
	for chunk := 0; chunk < floodRows; chunk += 1000 {
		end := chunk + 1000
		if end > floodRows {
			end = floodRows
		}
		var b strings.Builder
		b.WriteString(`INSERT INTO messages (id, workspace_id, channel_id, sender_type, sender_id, content, message_type, request_digest, revision, created_at) VALUES `)
		args := make([]any, 0, (end-chunk)*5)
		for i := chunk; i < end; i++ {
			if i > chunk {
				b.WriteString(",")
			}
			b.WriteString("(?,?,'dddddddd-dddd-4ddd-8ddd-dddddddddddd','user',?,?, 'chat', ?, 1, 1)")
			args = append(args, bulkUUID(i), txWS, txAlice, contentOf(i), digestOf(i))
		}
		if _, err := f.db.Exec(b.String(), args...); err != nil {
			t.Fatalf("bulk seed chunk %d: %v", chunk, err)
		}
	}
	visible := f.sendMsg(t, txGeneral, "for bob")
	bob := NewClaims(claimsFor(txBob, txFamBob))

	res, err := f.store.SyncHTTP(context.Background(), bob, txWS, 0, "", 200)
	if err != nil {
		t.Fatalf("hidden bulk must not break the HTTP scan: %v", err)
	}
	if len(res.Messages) != 1 || res.Messages[0].ID != visible.ID {
		t.Fatalf("authorized row must come through: %+v", res.Messages)
	}
	if res.BudgetExhausted || res.HasMore {
		t.Fatalf("no quota failure on the HTTP path: %+v", res)
	}

	// Shape 2: more invisible distinct channels than the old channel budget,
	// visible channels at the tail.
	var floodChannels int
	for i := 0; floodChannels < 600; i++ {
		id := bulkUUID(100000 + i)
		if _, err := f.db.Exec(`INSERT INTO channels (id, workspace_id, name, type, created_at) VALUES (?,?,?,?,1)`,
			id, txWS, "c"+pad8(i), "private"); err != nil {
			t.Fatal(err)
		}
		floodChannels++
		if _, err := f.db.Exec(`INSERT INTO messages (id, workspace_id, channel_id, sender_type, sender_id, content, message_type, request_digest, revision, created_at)
			VALUES (?,?,?, 'user', ?, ?, 'chat', ?, 1, 1)`, bulkUUID(200000+i), txWS, id, txAlice, "x", digestOf(200000+i)); err != nil {
			t.Fatal(err)
		}
	}
	tail := f.sendMsg(t, txGeneral, "tail visible")

	res, err = f.store.SyncHTTP(context.Background(), bob, txWS, 0, "", 200)
	if err != nil {
		t.Fatalf("channel flood must not break the HTTP scan: %v", err)
	}
	found := map[string]bool{}
	for _, m := range res.Messages {
		found[m.ID] = true
	}
	if !found[visible.ID] || !found[tail.ID] {
		t.Fatalf("authorized rows must come through: %+v", res.Messages)
	}
	for _, m := range res.Messages {
		if m.ChannelID != txGeneral {
			t.Fatalf("invisible channel leaked into the stream: %+v", m)
		}
	}

	// The resume path pages through the same adversarial data to completion
	// with an always-advanceable cursor.
	seen := map[string]bool{}
	cursor := int64(0)
	for {
		page, err := f.store.ResumePage(context.Background(), bob, txWS, cursor, ResumeOptions{})
		if err != nil {
			t.Fatalf("resume through adversarial data: %v", err)
		}
		for _, m := range page.Messages {
			if seen[m.ID] {
				t.Fatalf("duplicate delivery: %s", m.ID)
			}
			seen[m.ID] = true
		}
		if page.CurrentSeq <= cursor && len(page.Messages) > 0 {
			t.Fatalf("cursor must advance: %d -> %d", cursor, page.CurrentSeq)
		}
		cursor = page.CurrentSeq
		if !page.HasMore {
			break
		}
	}
	if !seen[visible.ID] || !seen[tail.ID] {
		t.Fatalf("resume lost authorized rows: %d seen", len(seen))
	}
}

// TestSyncHTTPRequiresMembershipEvenForEmptyStream pins that an empty answer
// is never indistinguishable from "not a member": a valid, verified human
// without current membership of the workspace is refused outright.
func TestSyncHTTPRequiresMembershipEvenForEmptyStream(t *testing.T) {
	f := newFixture(t)
	f.seed()
	f.seedChannel(txGeneral, "general", channel.TypeChannel, txAlice)
	// Empty workspace the caller does NOT belong to.
	empty := "efefefef-0000-4000-8000-0000000000ef"
	if _, err := f.db.Exec(`INSERT INTO workspaces (id, name, slug, owner_id, created_at) VALUES (?,?,?,?,1)`,
		empty, "Empty", "empty-ws", txAlice); err != nil {
		t.Fatal(err)
	}
	if _, err := f.db.Exec(`INSERT INTO workspace_memberships (workspace_id, user_id, role, server_push_muted, joined_at) VALUES (?,?,'owner',0,1)`, empty, txAlice); err != nil {
		t.Fatal(err)
	}
	bob := NewClaims(claimsFor(txBob, txFamBob))
	_, err := f.store.SyncHTTP(context.Background(), bob, empty, 0, "", 200)
	if !errors.Is(err, ErrNotServerMember) {
		t.Fatalf("non-member sync of an empty workspace must refuse: %v", err)
	}
	// A real member of an empty workspace gets the honest empty page.
	alice := NewClaims(claimsFor(txAlice, txFamAlice))
	res, err := f.store.SyncHTTP(context.Background(), alice, empty, 0, "", 200)
	if err != nil || len(res.Messages) != 0 || res.HasMore {
		t.Fatalf("member of empty workspace: %+v %v", res, err)
	}
}

// TestResumePageByteBoundNeverSkipsVisibleMessages uses long CJK content so
// the encoded page exceeds the byte budget long before the message-count
// limit; the cut must be a prefix with an honest cursor.
func TestResumePageByteBoundNeverSkipsVisibleMessages(t *testing.T) {
	f := newFixture(t)
	f.seed()
	f.seedChannel(txGeneral, "general", channel.TypeChannel, txAlice)

	long := strings.Repeat("聊", 32_000) // 32000 UTF-16 units ≈ 96KB UTF-8
	var ids []string
	var seqs []int64
	for i := 0; i < 6; i++ {
		msg, err := f.store.Create(context.Background(), claimsFor(txAlice, txFamAlice), txWS, CreateInput{
			ChannelID: txGeneral, Content: long,
		})
		if err != nil {
			t.Fatalf("long send %d: %v", i, err)
		}
		ids = append(ids, msg.Message.ID)
		seqs = append(seqs, msg.Message.Seq)
	}
	alice := NewClaims(claimsFor(txAlice, txFamAlice))

	page, err := f.store.ResumePage(context.Background(), alice, txWS, 0, ResumeOptions{
		MaxMessages: 500, MaxEncodedBytes: 380 * 1024,
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(page.Messages) >= len(ids) {
		t.Fatalf("byte bound should have cut the page: %d", len(page.Messages))
	}
	if !page.HasMore {
		t.Fatal("a cut page must report hasMore")
	}
	// The kept set is exactly the seq PREFIX.
	for i, m := range page.Messages {
		if m.ID != ids[i] {
			t.Fatalf("kept set must be a prefix: position %d", i)
		}
	}
	if page.CurrentSeq != seqs[len(page.Messages)-1] {
		t.Fatalf("currentSeq must be the last included seq: %d want %d", page.CurrentSeq, seqs[len(page.Messages)-1])
	}
	// Paging through with the returned cursor reaches every message exactly once.
	seen := map[string]bool{}
	cursor := int64(0)
	for {
		page, err := f.store.ResumePage(context.Background(), alice, txWS, cursor, ResumeOptions{
			MaxMessages: 500, MaxEncodedBytes: 380 * 1024,
		})
		if err != nil {
			t.Fatal(err)
		}
		for _, m := range page.Messages {
			if seen[m.ID] {
				t.Fatalf("message %s served twice", m.ID)
			}
			seen[m.ID] = true
		}
		if page.CurrentSeq <= cursor && len(page.Messages) > 0 {
			t.Fatalf("cursor must advance: %d -> %d", cursor, page.CurrentSeq)
		}
		cursor = page.CurrentSeq
		if !page.HasMore {
			break
		}
	}
	if len(seen) != len(ids) {
		t.Fatalf("byte-bounded resume lost messages: %d of %d", len(seen), len(ids))
	}
}

// TestResumeByteBudgetIncludesEnvelopeAndNeverAdmitsOversize pins the
// envelope-inclusive accounting: a single legal 32000-CJK message fits the
// default 1 MiB budget whole; a budget shrunken below one message surfaces
// the typed error (gateway retry/close) instead of silently admitting the
// row or returning an empty page that loops forever.
func TestResumeByteBudgetIncludesEnvelopeAndNeverAdmitsOversize(t *testing.T) {
	f := newFixture(t)
	f.seed()
	f.seedChannel(txGeneral, "general", channel.TypeChannel, txAlice)
	long := strings.Repeat("聊", 32_000) // 32000 UTF-16 units ≈ 96KB UTF-8
	single, err := f.store.Create(context.Background(), claimsFor(txAlice, txFamAlice), txWS, CreateInput{
		ChannelID: txGeneral, Content: long,
	})
	if err != nil {
		t.Fatal(err)
	}
	alice := NewClaims(claimsFor(txAlice, txFamAlice))

	// Default 1 MiB: the whole envelope with one long message fits.
	page, err := f.store.ResumePage(context.Background(), alice, txWS, 0, ResumeOptions{})
	if err != nil {
		t.Fatalf("a single 32000-CJK message must fit the default budget: %v", err)
	}
	if len(page.Messages) != 1 || page.Messages[0].ID != single.Message.ID || page.HasMore {
		t.Fatalf("single long message page: %+v", page)
	}

	// A budget far below one message: the typed error, never a silent
	// admission and never an empty non-advancing page.
	_, err = f.store.ResumePage(context.Background(), alice, txWS, 0, ResumeOptions{MaxEncodedBytes: 1024})
	if !errors.Is(err, ErrResumeMessageExceedsBudget) {
		t.Fatalf("shrunk budget must surface the typed error: %v", err)
	}

	// Envelope-inclusive accounting: every returned page's FULL encoded
	// envelope stays within the configured budget.
	second, err := f.store.Create(context.Background(), claimsFor(txAlice, txFamAlice), txWS, CreateInput{
		ChannelID: txGeneral, Content: strings.Repeat("话", 16_000),
	})
	if err != nil {
		t.Fatal(err)
	}
	_ = second
	budget := int64(120 * 1024) // fits one ~96KB message but not two
	cursor := int64(0)
	pages := 0
	seen := map[string]bool{}
	for {
		page, err := f.store.ResumePage(context.Background(), alice, txWS, cursor, ResumeOptions{MaxEncodedBytes: budget})
		if err != nil {
			t.Fatalf("paging within a tight budget: %v", err)
		}
		raw, err := json.Marshal(page)
		if err != nil {
			t.Fatal(err)
		}
		if int64(len(raw)) > budget {
			t.Fatalf("page %d envelope %d exceeds budget %d", pages, len(raw), budget)
		}
		for _, m := range page.Messages {
			if seen[m.ID] {
				t.Fatalf("duplicate: %s", m.ID)
			}
			seen[m.ID] = true
		}
		pages++
		if !page.HasMore {
			break
		}
		if page.CurrentSeq <= cursor {
			t.Fatalf("cursor stalled at %d", cursor)
		}
		cursor = page.CurrentSeq
	}
	if len(seen) != 2 {
		t.Fatalf("tight-budget paging lost messages: %d", len(seen))
	}
}

var bulkBase = "00000000-0000-4000-8000-000000000000"

func bulkUUID(i int) string {
	return strings.Replace(bulkBase, "00000000", pad8(i), 1)
}

func pad8(i int) string {
	out := []byte("00000000")
	src := []byte{}
	for n := i; n > 0; n /= 16 {
		src = append([]byte{digit(n % 16)}, src...)
	}
	if len(src) == 0 {
		src = []byte{'0'}
	}
	copy(out[8-len(src):], src)
	return string(out)
}

func digit(v int) byte {
	if v < 10 {
		return byte('0' + v)
	}
	return byte('a' + v - 10)
}

func contentOf(i int) string { return "flood message body number " + pad8(i) }

func digestOf(i int) string { return "digest-" + pad8(i) }
