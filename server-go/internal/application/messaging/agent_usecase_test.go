// M5 agent messaging use-case tests: SendAgent revalidates the real agent
// credential inside the send transaction, human sends plan durable receipt
// intents on the real delivery store, Agent DMs carry their true peer, and
// a planning failure rolls the whole send back.
package messaging_test

import (
	"context"
	"database/sql"
	"errors"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"raft.local/server-go/internal/agent"
	"raft.local/server-go/internal/application/messaging"
	"raft.local/server-go/internal/auth"
	"raft.local/server-go/internal/channel"
	"raft.local/server-go/internal/message"
	platformdb "raft.local/server-go/internal/platform/db"
	"raft.local/server-go/internal/readstate"
)

// The real migration set (0001–0014) is applied by platformdb.Open. Receipt
// intents are the delivery worker's agent_deliveries rows, written by the
// store NewService constructs on this same database.

type agentEnv struct {
	t         *testing.T
	db        *sql.DB
	channels  *channel.Store
	messages  *message.Store
	readstate *readstate.Store
	svc       *messaging.Service

	ws, agentID, agent2ID string
	alice, bob            string
}

func newAgentEnv(t *testing.T) *agentEnv {
	t.Helper()
	handle, err := platformdb.Open(filepath.Join(t.TempDir(), "raft.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = handle.Close() })
	channels := channel.NewStore(handle)
	msgs := message.NewStore(handle, channels)
	states := readstate.NewStore(handle, channels)
	svc, err := messaging.NewService(channels, msgs, states)
	if err != nil {
		t.Fatal(err)
	}
	env := &agentEnv{
		t: t, db: handle, channels: channels, messages: msgs, readstate: states, svc: svc,
		ws: "aaaaaaa1-0000-4000-8000-000000000001", agentID: "aaaaaaa1-0000-4000-8000-0000000000a1",
		agent2ID: "aaaaaaa1-0000-4000-8000-0000000000a2",
		alice:    "aaaaaaa1-0000-4000-8000-0000000000b1", bob: "aaaaaaa1-0000-4000-8000-0000000000b2",
	}
	env.seed()
	return env
}

func (e *agentEnv) exec(query string, args ...any) {
	e.t.Helper()
	if _, err := e.db.Exec(query, args...); err != nil {
		e.t.Fatal(err)
	}
}

func (e *agentEnv) seed() {
	e.t.Helper()
	now := time.Now().UnixMilli()
	e.exec(`INSERT INTO users (id, email, name, password_hash, email_verified, profile_setup_completed_at, created_at, updated_at)
		VALUES (?, 'a@t', 'alice', 'x', 1, 1, 0, 0), (?, 'b@t', 'bob', 'x', 1, 1, 0, 0)`, e.alice, e.bob)
	e.exec(`INSERT INTO session_families (id, user_id, created_at) VALUES ('fam-alice', ?, 0), ('fam-bob', ?, 0)`, e.alice, e.bob)
	e.exec(`INSERT INTO workspaces (id, name, slug, owner_id, created_at) VALUES (?, 'w', 'w', ?, 0)`, e.ws, e.alice)
	e.exec(`INSERT INTO workspace_memberships (workspace_id, user_id, role, joined_at) VALUES (?, ?, 'owner', 0), (?, ?, 'member', 0)`, e.ws, e.alice, e.ws, e.bob)
	e.exec(`INSERT INTO agents (id, workspace_id, name, status, runtime, created_at, updated_at)
		VALUES (?, ?, 'cindy', 'active', 'claude', ?, ?)`, e.agentID, e.ws, now, now)
	e.exec(`INSERT INTO agents (id, workspace_id, name, status, runtime, created_at, updated_at)
		VALUES (?, ?, 'bravo', 'active', 'claude', ?, ?)`, e.agent2ID, e.ws, now, now)
	e.exec(`INSERT INTO agent_credentials (id, agent_id, api_key_hash, api_key_prefix, scopes, created_at)
		VALUES (?, ?, 'not-a-hash', 'sk_ag', '["send"]', ?),
		       (?, ?, 'not-a-hash', 'sk_ag', '["send"]', ?)`,
		"cred-"+e.agentID, e.agentID, now, "cred-"+e.agent2ID, e.agent2ID, now)
	e.exec(`INSERT INTO channels (id, workspace_id, name, type, system_kind, created_at)
		VALUES ('aaaaaaa1-0000-4000-8000-0000000000c1', ?, 'all', 'channel', 'all', ?)`, e.ws, now)
	e.exec(`INSERT INTO channels (id, workspace_id, name, type, created_at)
		VALUES ('aaaaaaa1-0000-4000-8000-0000000000c2', ?, 'town', 'channel', ?)`, e.ws, now)
	e.exec(`INSERT INTO channel_humans (channel_id, user_id, role, authority_revision, joined_at)
		VALUES ('aaaaaaa1-0000-4000-8000-0000000000c2', ?, 'member', 1, ?)`, e.alice, now)
}

func (e *agentEnv) claims(user string) auth.AccessTokenClaims {
	now := time.Now()
	family := "fam-alice"
	if user == e.bob {
		family = "fam-bob"
	}
	return auth.AccessTokenClaims{Subject: user, Type: "access", FamilyID: family, IssuedAt: now.Add(-time.Minute), ExpiresAt: now.Add(time.Hour)}
}

func (e *agentEnv) principal(agentID string) agent.CredentialLookup {
	return agent.CredentialLookup{
		CredentialID: "cred-" + agentID, AgentID: agentID, WorkspaceID: e.ws,
		Scopes: []string{"send"},
	}
}

func (e *agentEnv) humanSend(user, channelID, content string, randomID *string, mentions []message.Mention) (*message.CreateResult, error) {
	return e.svc.SendHuman(context.Background(), e.claims(user), e.ws, message.CreateInput{
		ChannelID: channelID, Content: content, RandomID: randomID, Mentions: mentions,
	})
}

func (e *agentEnv) count(query string, args ...any) int {
	e.t.Helper()
	var n int
	if err := e.db.QueryRow(query, args...).Scan(&n); err != nil {
		e.t.Fatal(err)
	}
	return n
}

func (e *agentEnv) deliveries(messageID string) int {
	return e.count(`SELECT COUNT(*) FROM agent_deliveries WHERE message_id = ?`, messageID)
}

func TestNewServicePlansRealAgentReceipts(t *testing.T) {
	e := newAgentEnv(t)
	all := "aaaaaaa1-0000-4000-8000-0000000000c1"

	plain, err := e.humanSend(e.alice, all, "no mention", nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	if e.deliveries(plain.Message.ID) != 0 {
		t.Fatal("a message with no agent target planned a receipt")
	}

	created, err := e.humanSend(e.alice, all, "hello @cindy @bravo", nil, []message.Mention{
		{Type: "agent", ID: e.agentID, Name: "cindy"},
		{Type: "agent", ID: e.agent2ID, Name: "bravo"},
		{Type: "agent", ID: e.agentID, Name: "cindy"},
	})
	if err != nil {
		t.Fatal(err)
	}
	if e.deliveries(created.Message.ID) != 2 {
		t.Fatalf("deduplicated recipients = %d, want 2", e.deliveries(created.Message.ID))
	}
	if e.count(`SELECT COUNT(*) FROM agent_deliveries WHERE message_id = ? AND agent_id = ? AND scheduling_state = 'pending'`, created.Message.ID, e.agentID) != 1 {
		t.Fatal("cindy receipt missing")
	}
	if e.count(`SELECT COUNT(*) FROM realtime_publications WHERE event_type = 'message:new' AND object_id = ?`, created.Message.ID) != 1 {
		t.Fatal("message:new intent missing")
	}

	rid := "plan-replay-1"
	first, err := e.humanSend(e.alice, all, "replay me @cindy", &rid,
		[]message.Mention{{Type: "agent", ID: e.agentID, Name: "cindy"}})
	if err != nil {
		t.Fatal(err)
	}
	if e.deliveries(first.Message.ID) != 1 {
		t.Fatalf("first plan count = %d", e.deliveries(first.Message.ID))
	}
	replayed, err := e.humanSend(e.alice, all, "replay me @cindy", &rid,
		[]message.Mention{{Type: "agent", ID: e.agentID, Name: "cindy"}})
	if err != nil || !replayed.Replayed || replayed.Message.ID != first.Message.ID {
		t.Fatalf("replay: %+v %v", replayed, err)
	}
	if e.deliveries(first.Message.ID) != 1 {
		t.Fatal("replay created another receipt")
	}

	// A missing agent target is not found. A live agent opens a real DM
	// whose peer type is agent, and the pair is not a human direct_messages row.
	if _, err := e.svc.CreateDM(context.Background(), e.claims(e.alice), e.ws, e.alice, "", "missing-agent", true, false); !errors.Is(err, messaging.ErrAgentDMTargetNotFound) {
		t.Fatalf("missing agent DM target: %v", err)
	}
}

func TestSendHumanPlanningFailureRollsBackEverything(t *testing.T) {
	e := newAgentEnv(t)
	all := "aaaaaaa1-0000-4000-8000-0000000000c1"

	before := e.snapshotFacts()
	e.exec(`CREATE TRIGGER fail_delivery_plan BEFORE INSERT ON agent_deliveries
		BEGIN SELECT RAISE(ABORT, 'injected delivery planning failure'); END`)
	_, err := e.humanSend(e.alice, all, "will roll back", nil,
		[]message.Mention{{Type: "agent", ID: e.agentID, Name: "cindy"}})
	if err == nil || !strings.Contains(err.Error(), "injected delivery planning failure") {
		t.Fatalf("expected planning failure, got %v", err)
	}
	if after := e.snapshotFacts(); before != after {
		t.Fatal("failed planned send changed persisted facts (message orphan or ghost intent)")
	}

	e.exec(`DROP TRIGGER fail_delivery_plan`)
	created, err := e.humanSend(e.alice, all, "will roll back", nil,
		[]message.Mention{{Type: "agent", ID: e.agentID, Name: "cindy"}})
	if err != nil {
		t.Fatalf("recovery send failed: %v", err)
	}
	if e.deliveries(created.Message.ID) != 1 {
		t.Fatal("recovery send did not plan the receipt")
	}
}

func TestAgentDMImplicitReceiptAndTruePeer(t *testing.T) {
	e := newAgentEnv(t)

	dm, err := e.svc.CreateDM(context.Background(), e.claims(e.alice), e.ws, e.alice, "", e.agentID, true, false)
	if err != nil {
		t.Fatal(err)
	}
	if dm.View.PeerType != "agent" || dm.View.PeerID != e.agentID || dm.View.PeerName != "cindy" {
		t.Fatalf("agent dm view: %+v", dm.View)
	}
	if e.count(`SELECT COUNT(*) FROM direct_messages WHERE channel_id = ?`, dm.View.Channel.ID) != 0 {
		t.Fatal("agent identity landed in the human pair table")
	}
	again, err := e.svc.CreateDM(context.Background(), e.claims(e.alice), e.ws, e.alice, "", e.agentID, true, false)
	if err != nil || again.View.Channel.ID != dm.View.Channel.ID {
		t.Fatalf("agent dm must be canonical: %+v %v", again, err)
	}

	sent, err := e.humanSend(e.alice, dm.View.Channel.ID, "plain dm body", nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	if e.deliveries(sent.Message.ID) != 1 || e.count(`SELECT COUNT(*) FROM agent_deliveries WHERE message_id = ? AND agent_id = ?`, sent.Message.ID, e.agentID) != 1 {
		t.Fatal("implicit dm receipt missing")
	}

	explicit, err := e.humanSend(e.alice, dm.View.Channel.ID, "explicit @cindy", nil,
		[]message.Mention{{Type: "agent", ID: e.agentID, Name: "cindy"}})
	if err != nil {
		t.Fatal(err)
	}
	if e.deliveries(explicit.Message.ID) != 1 {
		t.Fatalf("merged dm receipt count = %d", e.deliveries(explicit.Message.ID))
	}

	reply, err := e.svc.SendAgent(context.Background(), e.principal(e.agentID), message.CreateInput{
		ChannelID: dm.View.Channel.ID, Content: "agent answer",
	})
	if err != nil {
		t.Fatal(err)
	}
	if reply.Message.SenderType != "agent" || e.deliveries(reply.Message.ID) != 0 {
		t.Fatalf("agent dm reply planned a cascade: %+v deliveries=%d", reply.Message, e.deliveries(reply.Message.ID))
	}
	rows, err := e.svc.ListDMs(context.Background(), e.claims(e.alice), e.ws, e.alice)
	if err != nil {
		t.Fatal(err)
	}
	if len(rows) != 1 || rows[0].View.PeerType != "agent" || rows[0].View.PeerID != e.agentID {
		t.Fatalf("dm list: %+v", rows)
	}
}

func TestSendAgentRevalidatesStoredCredential(t *testing.T) {
	e := newAgentEnv(t)
	all := "aaaaaaa1-0000-4000-8000-0000000000c1"

	e.exec(`UPDATE agent_credentials SET revoked_at = 1 WHERE id = ?`, "cred-"+e.agentID)
	if _, err := e.svc.SendAgent(context.Background(), e.principal(e.agentID), message.CreateInput{ChannelID: all, Content: "x"}); !errors.Is(err, agent.ErrCredentialRevoked) {
		t.Fatalf("revoked principal accepted: %v", err)
	}
	if e.count(`SELECT COUNT(*) FROM messages WHERE sender_type = 'agent'`) != 0 {
		t.Fatal("revoked principal left messages")
	}
	e.exec(`UPDATE agent_credentials SET revoked_at = NULL WHERE id = ?`, "cred-"+e.agentID)

	// The lookup's scopes are not a standing grant. The stored row is.
	e.exec(`UPDATE agent_credentials SET scopes = '["read"]' WHERE id = ?`, "cred-"+e.agentID)
	claimed := e.principal(e.agentID)
	claimed.Scopes = []string{"send"}
	if _, err := e.svc.SendAgent(context.Background(), claimed, message.CreateInput{ChannelID: all, Content: "x"}); err == nil || !strings.Contains(err.Error(), "send") {
		t.Fatalf("stored scopes ignored: %v", err)
	}
	e.exec(`UPDATE agent_credentials SET scopes = '["send"]' WHERE id = ?`, "cred-"+e.agentID)

	drifted := e.principal(e.agentID)
	drifted.AgentID = e.agent2ID
	if _, err := e.svc.SendAgent(context.Background(), drifted, message.CreateInput{ChannelID: all, Content: "x"}); err == nil || !strings.Contains(err.Error(), "Invalid agent credential") {
		t.Fatalf("binding drift accepted: %v", err)
	}

	town := "aaaaaaa1-0000-4000-8000-0000000000c2"
	if _, err := e.svc.SendAgent(context.Background(), e.principal(e.agentID), message.CreateInput{ChannelID: town, Content: "x"}); err == nil || !strings.Contains(err.Error(), "You must join this channel") {
		t.Fatalf("roster-less agent post accepted: %v", err)
	}

	target, err := e.svc.ResolveAgentTarget(context.Background(), e.principal(e.agentID), "#all")
	if err != nil || target.ChannelType != channel.TypeChannel {
		t.Fatalf("resolve #all: %+v %v", target, err)
	}
	rid := "agent-usecase-1"
	first, err := e.svc.SendAgent(context.Background(), e.principal(e.agentID), message.CreateInput{
		ChannelID: target.ChannelID, Content: "agent says hi", RandomID: &rid,
		Mentions: []message.Mention{{Type: "user", ID: e.bob, Name: "bob"}},
	})
	if err != nil {
		t.Fatal(err)
	}
	if first.Message.SenderType != "agent" || first.Message.SenderID != e.agentID || e.deliveries(first.Message.ID) != 0 {
		t.Fatalf("agent message: %+v deliveries=%d", first.Message, e.deliveries(first.Message.ID))
	}
	pubsBefore := e.count(`SELECT COUNT(*) FROM realtime_publications`)
	replayed, err := e.svc.SendAgent(context.Background(), e.principal(e.agentID), message.CreateInput{
		ChannelID: target.ChannelID, Content: "agent says hi", RandomID: &rid,
		Mentions: []message.Mention{{Type: "user", ID: e.bob, Name: "bob"}},
	})
	if err != nil || !replayed.Replayed || replayed.Message.ID != first.Message.ID {
		t.Fatalf("agent replay: %+v %v", replayed, err)
	}
	if e.count(`SELECT COUNT(*) FROM realtime_publications`) != pubsBefore {
		t.Fatal("agent replay emitted publications")
	}

	if _, err := e.svc.ResolveAgentTarget(context.Background(), e.principal(e.agentID), "#missing"); !isAgentTargetError[*messaging.AgentTargetNotFound](err) {
		t.Fatalf("missing target: %v", err)
	}
	if _, err := e.svc.ResolveAgentTarget(context.Background(), e.principal(e.agentID), "  "); !errors.Is(err, messaging.ErrAgentTargetShape) {
		t.Fatalf("shape target: %v", err)
	}
	dmTarget, err := e.svc.ResolveAgentTarget(context.Background(), e.principal(e.agentID), "dm:@bob")
	if err != nil || dmTarget.ChannelType != channel.TypeDM {
		t.Fatalf("dm create-on-target: %+v %v", dmTarget, err)
	}
	again, err := e.svc.ResolveAgentTarget(context.Background(), e.principal(e.agentID), "dm:@bob")
	if err != nil || again.ChannelID != dmTarget.ChannelID {
		t.Fatalf("dm re-resolve must converge: %+v %v", again, err)
	}
	if _, err := e.svc.ResolveAgentTarget(context.Background(), e.principal(e.agentID), "dm:@nobody"); !isAgentTargetError[*messaging.AgentTargetPeerNotFound](err) {
		t.Fatalf("peer not found: %v", err)
	}
	if _, err := e.svc.ResolveAgentTarget(context.Background(), e.principal(e.agentID), "dm:@cindy"); !isAgentTargetError[*messaging.AgentTargetSelfDM](err) {
		t.Fatalf("self dm: %v", err)
	}
	if _, err := e.svc.ResolveAgentTarget(context.Background(), e.principal(e.agentID), "dm:@bravo"); !isAgentTargetError[*messaging.AgentTargetUnsupported](err) {
		t.Fatalf("agent-agent dm must be honestly unsupported: %v", err)
	}
	if _, err := e.svc.ResolveAgentTarget(context.Background(), e.principal(e.agentID), "#town"); !isAgentTargetError[*messaging.AgentTargetForbidden](err) {
		t.Fatalf("roster-less #town: %v", err)
	}
	// Tasks stay refused. A 256-unit agent idempotency key is legal.
	asTask := true
	longKey := strings.Repeat("k", 256)
	if _, err := e.svc.SendAgent(context.Background(), e.principal(e.agentID), message.CreateInput{
		ChannelID: all, Content: "x", AsTask: &asTask,
	}); message.AsUnsupportedEffect(err) == nil {
		t.Fatalf("agent task must stay refused: %v", err)
	}
	if _, err := e.svc.SendAgent(context.Background(), e.principal(e.agentID), message.CreateInput{
		ChannelID: all, Content: "long key", RandomID: &longKey,
	}); err != nil {
		t.Fatalf("256-unit agent key rejected: %v", err)
	}
}

func TestResolveAgentTargetThreadCreateAndExisting(t *testing.T) {
	e := newAgentEnv(t)
	all := "aaaaaaa1-0000-4000-8000-0000000000c1"

	parent, err := e.humanSend(e.alice, all, "thread root", nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	short := parent.Message.ID[0:8]
	ref := "#all:" + short

	thread, err := e.svc.ResolveAgentTarget(context.Background(), e.principal(e.agentID), ref)
	if err != nil || thread.ChannelType != channel.TypeThread {
		t.Fatalf("thread create-on-target: %+v %v", thread, err)
	}
	again, err := e.svc.ResolveAgentTarget(context.Background(), e.principal(e.agentID), ref)
	if err != nil || again.ChannelID != thread.ChannelID {
		t.Fatalf("thread re-resolve must converge: %+v %v", again, err)
	}
	var attached string
	if err := e.db.QueryRow(`SELECT thread_id FROM messages WHERE id = ?`, parent.Message.ID).Scan(&attached); err != nil || attached != thread.ChannelID {
		t.Fatalf("parent thread_id projection: %q (%v)", attached, err)
	}

	reply, err := e.svc.SendAgent(context.Background(), e.principal(e.agentID), message.CreateInput{
		ChannelID: thread.ChannelID, Content: "threaded answer",
	})
	if err != nil || !reply.ThreadReply || e.deliveries(reply.Message.ID) != 0 {
		t.Fatalf("thread reply: %+v deliveries=%d err=%v", reply, e.deliveries(reply.Message.ID), err)
	}

	if _, err := e.svc.ResolveAgentTarget(context.Background(), e.principal(e.agentID), "#all:00000000"); !isAgentTargetError[*messaging.AgentTargetNotFound](err) {
		t.Fatalf("unknown short id: %v", err)
	}

	readOnly, err := channel.NewStore(e.db).ResolveAgentTargetRefTx(context.Background(), e.db, e.ws, e.agentID, ref)
	if err != nil || readOnly == nil || readOnly.ChannelID != thread.ChannelID || readOnly.ChannelType != channel.TypeThread {
		t.Fatalf("read-only thread target: %+v %v", readOnly, err)
	}
}

func (e *agentEnv) snapshotFacts() string {
	e.t.Helper()
	rows, err := e.db.Query(`SELECT 'msg:' || id FROM messages
		UNION ALL SELECT 'um:' || message_id || ':' || user_id FROM message_mentions
		UNION ALL SELECT 'am:' || message_id || ':' || agent_id FROM message_agent_mentions
		UNION ALL SELECT 'adm:' || workspace_id || ':' || user_id || ':' || agent_id FROM agent_direct_messages
		UNION ALL SELECT 'del:' || COALESCE(message_id, '') || ':' || agent_id FROM agent_deliveries
		UNION ALL SELECT 'pub:' || id FROM realtime_publications ORDER BY 1`)
	if err != nil {
		e.t.Fatal(err)
	}
	defer rows.Close()
	var out strings.Builder
	for rows.Next() {
		var s string
		if err := rows.Scan(&s); err != nil {
			e.t.Fatal(err)
		}
		out.WriteString(s + "\n")
	}
	if err := rows.Err(); err != nil {
		e.t.Fatal(err)
	}
	return out.String()
}

func isAgentTargetError[T error](err error) bool {
	var want T
	return errors.As(err, &want)
}
