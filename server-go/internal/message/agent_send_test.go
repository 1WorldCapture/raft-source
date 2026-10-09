// M5 agent sender tests: CreateAgentMessageTx posting authority, agent-scoped
// idempotency, cascade-free mentions, thread follow facts for mentioned
// humans only, and the agent-facing reads.
package message

import (
	"context"
	"database/sql"
	"strings"
	"testing"

	platformdb "raft.local/server-go/internal/platform/db"
)

// sendAgent commits one agent message inside one transaction.
func (f *fixture) sendAgent(agentID, workspace, channelID, content string, randomID *string, mentions []Mention) (*CreateResult, error) {
	var result *CreateResult
	err := platformdb.WithWriteTx(context.Background(), f.db, func(tx *sql.Tx) error {
		created, err := f.store.CreateAgentMessageTx(context.Background(), tx, agentID, workspace, CreateInput{
			ChannelID: channelID, Content: content, RandomID: randomID, Mentions: mentions,
		})
		if err != nil {
			return err
		}
		if err := f.store.RecordSendPublicationsTx(context.Background(), tx, workspace, created); err != nil {
			return err
		}
		result = created
		return nil
	})
	if err != nil {
		return nil, err
	}
	return result, nil
}

func TestCreateAgentMessageAuthorityAndIdempotency(t *testing.T) {
	f := newFixture(t)
	f.seed()
	f.seedAgent(txAgent, txWS, "cindy")
	f.seedAgent(txAgent2, txWS2, "bravo")

	all := "eeeeeeee-eeee-4eee-8eee-eeeeeeeeee30"
	if _, err := f.db.Exec(`INSERT INTO channels (id, workspace_id, name, type, system_kind, created_at)
		VALUES (?, ?, 'all', 'channel', 'all', ?)`, all, txWS, f.clock.Now().UnixMilli()); err != nil {
		t.Fatal(err)
	}

	// Cross-workspace agent has no authority here.
	if _, err := f.sendAgent(txAgent2, txWS, all, "x", nil, nil); err == nil || !strings.Contains(err.Error(), "Not a member") {
		t.Fatalf("cross-workspace agent accepted: %v", err)
	}
	// The live workspace agent posts to the implicit-membership system channel.
	created, err := f.sendAgent(txAgent, txWS, all, "agent reply", nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	if created.Message.SenderType != "agent" || created.Message.SenderID != txAgent {
		t.Fatalf("sender identity: %+v", created.Message)
	}
	if created.RootChannelID != all {
		t.Fatalf("root = %s", created.RootChannelID)
	}
	// Publication intent recorded for the browser surface.
	var pubs int
	if err := f.db.QueryRow(`SELECT COUNT(*) FROM realtime_publications
		WHERE object_id = ? AND event_type = 'message:new'`, created.Message.ID).Scan(&pubs); err != nil || pubs != 1 {
		t.Fatalf("message:new intents = %d (%v)", pubs, err)
	}

	// Agent-scoped randomId replay: same key returns the original with zero
	// new side effects; a human using the same randomId does NOT collide
	// (the scope includes sender_type).
	rid := stringPtr("agent-send-1")
	first, err := f.sendAgent(txAgent, txWS, all, "idem", rid, nil)
	if err != nil {
		t.Fatal(err)
	}
	before := atomicMessageFacts(t, f.db)
	replay, err := f.sendAgent(txAgent, txWS, all, "idem", rid, nil)
	if err != nil || !replay.Replayed || replay.Message.ID != first.Message.ID {
		t.Fatalf("agent replay: %+v %v", replay, err)
	}
	if after := atomicMessageFacts(t, f.db); before != after {
		t.Fatal("agent replay changed facts")
	}
	if _, err := f.send(txAlice, txFamAlice, all, "human same key", rid, nil); err != nil {
		t.Fatalf("human/agent randomId scopes must be independent: %v", err)
	}
	// Digest conflict within the agent scope stays a typed conflict.
	if _, err := f.sendAgent(txAgent, txWS, all, "different", rid, nil); AsRandomIDConflict(err) == nil {
		t.Fatalf("agent digest conflict accepted: %v", err)
	}
}

func TestCreateAgentMessageMentionsAndThreads(t *testing.T) {
	f := newFixture(t)
	f.seed()
	f.seedAgent(txAgent, txWS, "cindy")

	all := "eeeeeeee-eeee-4eee-8eee-eeeeeeeeee31"
	if _, err := f.db.Exec(`INSERT INTO channels (id, workspace_id, name, type, system_kind, created_at)
		VALUES (?, ?, 'all', 'channel', 'all', ?)`, all, txWS, f.clock.Now().UnixMilli()); err != nil {
		t.Fatal(err)
	}

	// Agent-to-agent mentions (including self) are the cascade-disabled 501.
	if _, err := f.sendAgent(txAgent, txWS, all, "x", nil, []Mention{agentMention(txAgent, "cindy")}); AsUnsupportedEffect(err) == nil {
		t.Fatalf("self mention accepted: %v", err)
	} else if AsUnsupportedEffect(err).Reason != "Agent mentions of other agents are not enabled in this server stage" {
		t.Fatalf("cascade sentence: %v", err)
	}

	// Human mention by an agent follows the human rules.
	created, err := f.sendAgent(txAgent, txWS, all, "cc @bob", nil, []Mention{{Type: "user", ID: txBob, Name: "bob"}})
	if err != nil {
		t.Fatal(err)
	}
	var humanFacts, agentFacts int
	if err := f.db.QueryRow(`SELECT COUNT(*) FROM message_mentions WHERE message_id = ?`, created.Message.ID).Scan(&humanFacts); err != nil {
		t.Fatal(err)
	}
	if err := f.db.QueryRow(`SELECT COUNT(*) FROM message_agent_mentions WHERE message_id = ?`, created.Message.ID).Scan(&agentFacts); err != nil {
		t.Fatal(err)
	}
	if humanFacts != 1 || agentFacts != 0 {
		t.Fatalf("agent send facts human=%d agent=%d", humanFacts, agentFacts)
	}

	// Thread reply: the mentioned human is followed, the agent sender is not
	// (agents have no follow facts), and thread:updated is planned.
	parent, err := f.send(txAlice, txFamAlice, all, "root", nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	threadID := ""
	err = platformdb.WithWriteTx(context.Background(), f.db, func(tx *sql.Tx) error {
		thread, err := f.channels.EnsureThreadTx(context.Background(), tx, txWS, all, parent.Message.ID, txAlice)
		if err != nil {
			return err
		}
		threadID = thread.ID
		return f.store.AttachThreadToParentTx(context.Background(), tx, parent.Message.ID, thread.ID)
	})
	if err != nil {
		t.Fatal(err)
	}
	// Unfollow bob first so the follow effect is observable.
	if err := platformdb.WithWriteTx(context.Background(), f.db, func(tx *sql.Tx) error {
		return f.channels.SetThreadFollowTx(context.Background(), tx, txWS, threadID, txBob, false, false)
	}); err != nil {
		t.Fatal(err)
	}
	reply, err := f.sendAgent(txAgent, txWS, threadID, "thread reply @bob", nil, []Mention{{Type: "user", ID: txBob, Name: "bob"}})
	if err != nil || !reply.ThreadReply || reply.RootChannelID != all {
		t.Fatalf("thread reply: %+v %v", reply, err)
	}
	var bobFollow sql.NullInt64
	if err := f.db.QueryRow(`SELECT unfollowed_at FROM thread_follows WHERE thread_channel_id = ? AND user_id = ?`,
		threadID, txBob).Scan(&bobFollow); err != nil || bobFollow.Valid {
		t.Fatalf("mentioned human not re-followed: %v %v", bobFollow, err)
	}
	var agentFollows int
	if err := f.db.QueryRow(`SELECT COUNT(*) FROM thread_follows WHERE thread_channel_id = ? AND user_id = ?`,
		threadID, txAgent).Scan(&agentFollows); err != nil || agentFollows != 0 {
		t.Fatalf("agent sender must have no follow facts: %d", agentFollows)
	}
	// thread:updated carries the reply's seq as its revision, exactly like a
	// human reply (the thread's creation-time appearance intent is a separate
	// row with revision 1).
	var replyRevision int64
	if err := f.db.QueryRow(`SELECT revision FROM realtime_publications
		WHERE scope_id = ? AND event_type = 'thread:updated' AND revision = ?`,
		threadID, reply.Message.Seq).Scan(&replyRevision); err != nil || replyRevision != reply.Message.Seq {
		t.Fatalf("thread:updated reply intent: %d (%v)", replyRevision, err)
	}
	// The agent has no read frontier of its own anywhere.
	var agentReads int
	if err := f.db.QueryRow(`SELECT COUNT(*) FROM user_channel_read_states WHERE user_id = ?`, txAgent).Scan(&agentReads); err != nil || agentReads != 0 {
		t.Fatalf("agent read states = %d", agentReads)
	}
}

func TestAgentFacingReads(t *testing.T) {
	f := newFixture(t)
	f.seed()
	f.seedAgent(txAgent, txWS, "cindy")

	all := "eeeeeeee-eeee-4eee-8eee-eeeeeeeeee32"
	private := "eeeeeeee-eeee-4eee-8eee-eeeeeeeeee33"
	if _, err := f.db.Exec(`INSERT INTO channels (id, workspace_id, name, type, system_kind, created_at)
		VALUES (?, ?, 'all', 'channel', 'all', ?)`, all, txWS, f.clock.Now().UnixMilli()); err != nil {
		t.Fatal(err)
	}
	if _, err := f.db.Exec(`INSERT INTO channels (id, workspace_id, name, type, created_at)
		VALUES (?, ?, 'vault', 'private', ?)`, private, txWS, f.clock.Now().UnixMilli()); err != nil {
		t.Fatal(err)
	}
	if _, err := f.db.Exec(`INSERT INTO channel_humans (channel_id, user_id, role, authority_revision, joined_at)
		VALUES (?, ?, 'member', 1, ?)`, private, txAlice, f.clock.Now().UnixMilli()); err != nil {
		t.Fatal(err)
	}

	humanMsg, err := f.sendWithAgents(txAlice, txFamAlice, all, "from human", nil, []Mention{agentMention(txAgent, "cindy")})
	if err != nil {
		t.Fatal(err)
	}
	agentMsg, err := f.sendAgent(txAgent, txWS, all, "from agent", nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := f.send(txAlice, txFamAlice, private, "secret", nil, nil); err != nil {
		t.Fatal(err)
	}

	// Page read: rows + projections with the agent sender directory and the
	// typed agent mention fact.
	page, err := f.store.ListAgentChannelPageForAgent(context.Background(), txWS, all, txAgent, PageQuery{Limit: 50})
	if err != nil {
		t.Fatal(err)
	}
	if len(page.Messages) != 2 {
		t.Fatalf("page rows = %d", len(page.Messages))
	}
	bySender := map[string]*Projection{}
	for _, p := range page.Projections {
		bySender[p.SenderID] = p
	}
	if p := bySender[txAgent]; p == nil || !p.SenderDirectoryKnown || p.SenderHandle != "cindy" || p.SenderName != "cindy" {
		t.Fatalf("agent sender projection: %+v", p)
	}
	if p := bySender[txAlice]; p == nil || len(p.Mentions) != 1 || p.Mentions[0].Type != "agent" || p.Mentions[0].ID != txAgent || p.Mentions[0].Name != "cindy" {
		t.Fatalf("agent mention projection: %+v", p)
	}

	// Context read for the agent viewer; a private channel stays invisible.
	ctxResult, err := f.store.GetAgentMessageContextForAgent(context.Background(), txWS, all, humanMsg.Message.ID, txAgent, 1, 1)
	if err != nil || ctxResult.TargetMessageID != humanMsg.Message.ID {
		t.Fatalf("agent context: %+v %v", ctxResult, err)
	}
	if _, err := f.store.ListAgentChannelPageForAgent(context.Background(), txWS, private, txAgent, PageQuery{Limit: 10}); err == nil || !strings.Contains(err.Error(), "not visible") {
		t.Fatalf("private page for agent: %v", err)
	}

	// A stranger agent (other workspace) reads nothing here.
	f.seedAgent(txAgent2, txWS2, "bravo")
	if _, err := f.store.ListAgentChannelPageForAgent(context.Background(), txWS, all, txAgent2, PageQuery{Limit: 10}); err == nil || !strings.Contains(err.Error(), "Not a member") {
		t.Fatalf("cross-workspace agent read: %v", err)
	}
	_ = agentMsg
}
