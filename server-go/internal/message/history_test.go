package message

import (
	"context"
	"database/sql"
	"errors"
	"testing"

	"raft.local/server-go/internal/channel"
	"raft.local/server-go/internal/platform/db"
)

// seedConversation sends n messages and returns them in seq order.
func (f *fixture) seedConversation(t *testing.T, channelID string, n int) []*Message {
	t.Helper()
	out := make([]*Message, 0, n)
	for i := 0; i < n; i++ {
		result, err := f.send(txAlice, txFamAlice, channelID, bodyN(i), nil, nil)
		if err != nil {
			t.Fatalf("seed message %d: %v", i, err)
		}
		out = append(out, result.Message)
	}
	return out
}

func bodyN(i int) string { return "m" + string(rune('0'+i%10)) + "-" + itoa(i) }

func itoa(i int) string {
	if i == 0 {
		return "0"
	}
	digits := ""
	for ; i > 0; i /= 10 {
		digits = string(rune('0'+i%10)) + digits
	}
	return digits
}

func TestHistoryLatestPageCoverage(t *testing.T) {
	f := newFixture(t)
	f.seed()
	f.seedChannel(txGeneral, "general", channel.TypeChannel, txAlice)
	// Another channel interleaves seq numbers so global holes exist.
	f.seedChannel("dddddddd-dddd-4ddd-8ddd-dddddddddddd", "other", channel.TypeChannel, txAlice)
	other := "dddddddd-dddd-4ddd-8ddd-dddddddddddd"

	msgs := f.seedConversation(t, txGeneral, 3)
	if _, err := f.send(txAlice, txFamAlice, other, "elsewhere", nil, nil); err != nil {
		t.Fatal(err)
	}
	more := f.seedConversation(t, txGeneral, 2)
	all := append(msgs, more...)

	page, err := f.store.ListChannelPage(context.Background(), NewClaims(claimsFor(txAlice, txFamAlice)), txWS, txGeneral,
		PageQuery{Limit: 3})
	if err != nil {
		t.Fatalf("latest page: %v", err)
	}
	if len(page.Messages) != 3 || page.Messages[0].ID != all[2].ID || page.Messages[2].ID != all[4].ID {
		t.Fatalf("latest page must be the newest rows in ascending order: %+v", page.Messages)
	}
	cov := page.Coverage
	if cov.CoveredThroughSeq != all[4].Seq || cov.CoveredFromSeq != all[2].Seq {
		t.Fatalf("covered window: %+v", cov)
	}
	// coveredAfter is the exact in-channel predecessor of the first row.
	if cov.CoveredAfterSeq != all[1].Seq {
		t.Fatalf("coveredAfter: %d want %d", cov.CoveredAfterSeq, all[1].Seq)
	}
	// The channel high-water excludes the interleaved other-channel message.
	if cov.RemoteHighWaterSeq != all[4].Seq {
		t.Fatalf("high water: %d want %d", cov.RemoteHighWaterSeq, all[4].Seq)
	}
	if !cov.CompleteThroughLatest || cov.HasGap || cov.HasNewer {
		t.Fatalf("latest tail flags: %+v", cov)
	}

	// before continues strictly lower and renders ascending.
	before := page.Messages[0].Seq // all[2].Seq
	page, err = f.store.ListChannelPage(context.Background(), NewClaims(claimsFor(txAlice, txFamAlice)), txWS, txGeneral,
		PageQuery{Limit: 2, Before: &before})
	if err != nil {
		t.Fatal(err)
	}
	if len(page.Messages) != 2 || page.Messages[0].ID != all[0].ID || page.Messages[1].ID != all[1].ID {
		t.Fatalf("before page: %+v", page.Messages)
	}
	if !page.Coverage.HasGap || !page.Coverage.HasNewer || page.Coverage.CompleteThroughLatest {
		t.Fatalf("non-latest flags: %+v", page.Coverage)
	}
	if page.Coverage.CoveredAfterSeq != 0 {
		t.Fatalf("before-page coveredAfter is the in-channel predecessor of the oldest row: %+v", page.Coverage)
	}
}

func TestHistoryBeforeAndAfterPagination(t *testing.T) {
	f := newFixture(t)
	f.seed()
	f.seedChannel(txGeneral, "general", channel.TypeChannel, txAlice)
	all := f.seedConversation(t, txGeneral, 5)

	// after the first message returns the rest.
	after := all[0].Seq
	page, err := f.store.ListChannelPage(context.Background(), NewClaims(claimsFor(txAlice, txFamAlice)), txWS, txGeneral,
		PageQuery{Limit: 2, After: &after})
	if err != nil {
		t.Fatal(err)
	}
	if len(page.Messages) != 2 || page.Messages[0].ID != all[1].ID || page.Messages[1].ID != all[2].ID {
		t.Fatalf("after page: %+v", page.Messages)
	}
	// coveredAfter is the exact in-channel predecessor of the first row.
	if page.Coverage.CoveredAfterSeq != all[0].Seq {
		t.Fatalf("after coveredAfter: %d want %d", page.Coverage.CoveredAfterSeq, all[0].Seq)
	}
	// A full after page never claims completeness of the tail.
	if page.Coverage.CompleteThroughLatest || !page.Coverage.HasNewer {
		t.Fatalf("after flags: %+v", page.Coverage)
	}

	// before the newest returns older rows descending-queried, ascending-rendered.
	before := all[4].Seq
	page, err = f.store.ListChannelPage(context.Background(), NewClaims(claimsFor(txAlice, txFamAlice)), txWS, txGeneral,
		PageQuery{Limit: 2, Before: &before})
	if err != nil {
		t.Fatal(err)
	}
	if len(page.Messages) != 2 || page.Messages[0].ID != all[2].ID || page.Messages[1].ID != all[3].ID {
		t.Fatalf("before page: %+v", page.Messages)
	}
}

func TestHistoryAuthorizationAndThreadSummaries(t *testing.T) {
	f := newFixture(t)
	f.seed()
	f.seedChannel(txGeneral, "general", channel.TypeChannel, txAlice, txBob)
	private := "dddddddd-dddd-4ddd-8ddd-dddddddddddd"
	f.seedChannel(private, "secret", channel.TypePrivate, txAlice)

	msgs := f.seedConversation(t, txGeneral, 3)

	// A stranger with no prior relationship is denied invisibly.
	_, err := f.store.ListChannelPage(context.Background(), NewClaims(claimsFor(txCara, txFamCara)), txWS, private,
		PageQuery{Limit: 50})
	if !errors.Is(err, ErrConversationDenied) {
		t.Fatalf("private history by stranger: %v", err)
	}

	// Thread on message 0 with two replies; summary rides the next page.
	var threadID string
	err = db.WithWriteTx(context.Background(), f.db, func(tx *sql.Tx) error {
		thread, err := f.channels.EnsureThreadTx(context.Background(), tx, txWS, txGeneral, msgs[0].ID, txAlice)
		if err != nil {
			return err
		}
		threadID = thread.ID
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	for _, sender := range []struct{ user, family string }{
		{txAlice, txFamAlice}, {txBob, txFamBob},
	} {
		if _, err := f.send(sender.user, sender.family, threadID, "reply "+sender.user, nil, nil); err != nil {
			t.Fatalf("thread reply by %s: %v", sender.user, err)
		}
	}

	page, err := f.store.ListChannelPage(context.Background(), NewClaims(claimsFor(txAlice, txFamAlice)), txWS, txGeneral,
		PageQuery{Limit: 50})
	if err != nil {
		t.Fatal(err)
	}
	summary, ok := page.ThreadSummaries[msgs[0].ID]
	if !ok {
		t.Fatalf("thread summary missing; have %v", page.ThreadSummaries)
	}
	if summary.ThreadChannelID != threadID || summary.ReplyCount != 2 {
		t.Fatalf("summary: %+v", summary)
	}
	if summary.LastReplyAt == nil || len(summary.ParticipantIDs) != 2 {
		t.Fatalf("summary aggregates: %+v", summary)
	}
	// latestReplies: newest 3 non-system replies ascending.
	if len(summary.LatestReplies) != 2 || summary.LatestReplies[0].Seq > summary.LatestReplies[1].Seq {
		t.Fatalf("latestReplies: %+v", summary.LatestReplies)
	}
	// The viewer follows (authored/replied): unread counts every message
	// because no read cursors exist yet (frozen TS formula).
	if summary.UnreadCount != 2 || summary.FirstUnreadMessageID == nil {
		t.Fatalf("unread projection: %+v", summary)
	}
	// A viewer who never followed sees no unread.
	strangerPage, err := f.store.ListChannelPage(context.Background(), NewClaims(claimsFor(txCara, txFamCara)), txWS, txGeneral,
		PageQuery{Limit: 50})
	if err != nil {
		t.Fatal(err)
	}
	if s := strangerPage.ThreadSummaries[msgs[0].ID]; s.UnreadCount != 0 || s.FirstUnreadMessageID != nil {
		t.Fatalf("non-follower unread must be 0: %+v", s)
	}
}

func TestGetMessageContextWindowAndScopeMismatch(t *testing.T) {
	f := newFixture(t)
	f.seed()
	f.seedChannel(txGeneral, "general", channel.TypeChannel, txAlice)
	f.seedChannel("dddddddd-dddd-4ddd-8ddd-dddddddddddd", "other", channel.TypeChannel, txAlice)
	other := "dddddddd-dddd-4ddd-8ddd-dddddddddddd"

	all := f.seedConversation(t, txGeneral, 35)
	if _, err := f.send(txAlice, txFamAlice, other, "elsewhere", nil, nil); err != nil {
		t.Fatal(err)
	}

	// Middle message: 15 before + target + 15 after, both flags true.
	target := all[17]
	ctxResult, err := f.store.GetMessageContext(context.Background(), NewClaims(claimsFor(txAlice, txFamAlice)), txWS, txGeneral, target.ID, 15, 15)
	if err != nil {
		t.Fatalf("context: %v", err)
	}
	if len(ctxResult.Messages) != 31 || ctxResult.Messages[15].ID != target.ID {
		t.Fatalf("context window: %d messages", len(ctxResult.Messages))
	}
	if !ctxResult.HasOlder || !ctxResult.HasNewer {
		t.Fatalf("context flags: %+v", ctxResult)
	}

	// A message id from another channel is a 404, not a leak.
	foreign := f.sendMsg(t, other, "foreign")
	_, err = f.store.GetMessageContext(context.Background(), NewClaims(claimsFor(txAlice, txFamAlice)), txWS, txGeneral, foreign.ID, 15, 15)
	if !errors.Is(err, ErrMessageNotFound) {
		t.Fatalf("cross-channel context: %v", err)
	}
}

func (f *fixture) sendMsg(t *testing.T, channelID, content string) *Message {
	t.Helper()
	result, err := f.send(txAlice, txFamAlice, channelID, content, nil, nil)
	if err != nil {
		t.Fatalf("send: %v", err)
	}
	return result.Message
}

func TestMessageWindowEmptyChannel(t *testing.T) {
	f := newFixture(t)
	f.seed()
	f.seedChannel(txGeneral, "general", channel.TypeChannel, txAlice)
	// A message exists elsewhere so the workspace seq is nonzero.
	f.seedChannel("dddddddd-dddd-4ddd-8ddd-dddddddddddd", "other", channel.TypeChannel, txAlice)
	f.sendMsg(t, "dddddddd-dddd-4ddd-8ddd-dddddddddddd", "seed")

	page, err := f.store.ListChannelPage(context.Background(), NewClaims(claimsFor(txAlice, txFamAlice)), txWS, txGeneral,
		PageQuery{Limit: 50})
	if err != nil {
		t.Fatal(err)
	}
	if len(page.Messages) != 0 {
		t.Fatalf("expected empty page")
	}
	// Empty page: from=H+1, through=H where H is THIS channel's high water (0).
	if page.Coverage.CoveredFromSeq != 1 || page.Coverage.CoveredThroughSeq != 0 || page.Coverage.RemoteHighWaterSeq != 0 {
		t.Fatalf("empty coverage: %+v", page.Coverage)
	}
	if !page.Coverage.CompleteThroughLatest {
		t.Fatalf("empty latest page is complete through latest: %+v", page.Coverage)
	}
}
