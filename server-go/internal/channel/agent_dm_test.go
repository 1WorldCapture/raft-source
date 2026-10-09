// M5 canonical human-Agent DM tests: typed pair facts, idempotent ensure,
// soft-delete revive with a fresh dm:new intent, honest list projection and
// the agent-side peer resolution.
package channel

import (
	"database/sql"
	"testing"
)

func (f *fixture) ensureAgentDM(workspaceID, userID, agentID string) *Channel {
	f.t.Helper()
	var out *Channel
	f.writeTx(func(tx *sql.Tx) error {
		ensured, err := f.store.EnsureAgentDMTx(f.ctx(), tx, workspaceID, userID, agentID)
		out = ensured
		return err
	})
	return out
}

func (f *fixture) countPublications(eventType, channelID string) int {
	f.t.Helper()
	var n int
	if err := f.db.QueryRow(`SELECT COUNT(*) FROM realtime_publications
		WHERE event_type = ? AND scope_id = ?`, eventType, channelID).Scan(&n); err != nil {
		f.t.Fatal(err)
	}
	return n
}

func TestEnsureAgentDMCreatesCanonicalTypedPair(t *testing.T) {
	f := newFixture(t)

	dm := f.ensureAgentDM(fxWS, fxMember, fxAgent)
	if dm == nil || dm.Type != TypeDM || dm.WorkspaceID != fxWS {
		t.Fatalf("dm channel: %+v", dm)
	}
	if dm.Name != "cindy" {
		t.Fatalf("dm name = %q, want the agent directory handle", dm.Name)
	}

	// Typed pair fact, exactly-once shape: one human row, one agent row, no
	// human direct_messages pollution.
	var pairs int
	if err := f.db.QueryRow(`SELECT COUNT(*) FROM agent_direct_messages
		WHERE workspace_id = ? AND user_id = ? AND agent_id = ?`, fxWS, fxMember, fxAgent).Scan(&pairs); err != nil {
		t.Fatal(err)
	}
	if pairs != 1 {
		t.Fatalf("typed pairs = %d, want 1", pairs)
	}
	var humanRows, agentRows int
	if err := f.db.QueryRow(`SELECT COUNT(*) FROM channel_humans WHERE channel_id = ?`, dm.ID).Scan(&humanRows); err != nil {
		t.Fatal(err)
	}
	if err := f.db.QueryRow(`SELECT COUNT(*) FROM channel_agents WHERE channel_id = ?`, dm.ID).Scan(&agentRows); err != nil {
		t.Fatal(err)
	}
	if humanRows != 1 || agentRows != 1 {
		t.Fatalf("roster rows human=%d agent=%d, want 1/1", humanRows, agentRows)
	}
	var humanPairs int
	if err := f.db.QueryRow(`SELECT COUNT(*) FROM direct_messages WHERE channel_id = ?`, dm.ID).Scan(&humanPairs); err != nil {
		t.Fatal(err)
	}
	if humanPairs != 0 {
		t.Fatalf("human direct_messages pollution: %d rows", humanPairs)
	}
	if got := f.countPublications(PublicationEventDMNew, dm.ID); got != 1 {
		t.Fatalf("dm:new intents = %d, want 1 on real creation", got)
	}

	// Idempotent re-open returns the SAME canonical channel, silently.
	again := f.ensureAgentDM(fxWS, fxMember, fxAgent)
	if again == nil || again.ID != dm.ID {
		t.Fatalf("re-ensure returned %+v, want %s", again, dm.ID)
	}
	if got := f.countPublications(PublicationEventDMNew, dm.ID); got != 1 {
		t.Fatalf("dm:new intents after re-ensure = %d, want 1", got)
	}

	// A different human gets a DIFFERENT canonical channel for the same
	// agent — the pair is (workspace, user, agent), never agent-global.
	other := f.ensureAgentDM(fxWS, fxOwner, fxAgent)
	if other == nil || other.ID == dm.ID {
		t.Fatalf("second pair must be a distinct channel: %+v", other)
	}
	var totalPairs int
	if err := f.db.QueryRow(`SELECT COUNT(*) FROM agent_direct_messages`).Scan(&totalPairs); err != nil {
		t.Fatal(err)
	}
	if totalPairs != 2 {
		t.Fatalf("typed pairs = %d, want 2", totalPairs)
	}
}

func TestEnsureAgentDMReviveAndRefusals(t *testing.T) {
	f := newFixture(t)

	if _, err := f.db.Exec(`INSERT INTO agents (id, workspace_id, name, status, runtime, created_at, updated_at)
		VALUES (?, ?, 'ghost', 'active', 'claude', ?, ?)`, fxM5Peer, fxWS2, f.clock.T.UnixMilli(), f.clock.T.UnixMilli()); err != nil {
		t.Fatal(err)
	}

	// Target agent of another workspace: honest target refusal, nothing created.
	var refused *DomainError
	f.writeTx(func(tx *sql.Tx) error {
		_, err := f.store.EnsureAgentDMTx(f.ctx(), tx, fxWS, fxMember, fxM5Peer)
		refused = AsDomainError(err)
		return nil
	})
	if refused == nil || refused.Message != AgentDMTargetNotMemberMessage {
		t.Fatalf("cross-workspace target: %+v", refused)
	}
	if f.countChannels(`type = 'dm'`) != 0 {
		t.Fatal("refused ensure must not create channels")
	}

	// Guests cannot open agent DMs (frozen policy parity).
	var guestRefused *DomainError
	f.writeTx(func(tx *sql.Tx) error {
		_, err := f.store.EnsureAgentDMTx(f.ctx(), tx, fxWS, fxGuest, fxAgent)
		guestRefused = AsDomainError(err)
		return nil
	})
	if guestRefused == nil || guestRefused.Code != CodeForbidden || guestRefused.Message != DMGuestCreateMessage {
		t.Fatalf("guest create: %+v", guestRefused)
	}

	dm := f.ensureAgentDM(fxWS, fxMember, fxAgent)
	if _, err := f.db.Exec(`UPDATE channels SET deleted_at = ? WHERE id = ?`, f.clock.T.UnixMilli(), dm.ID); err != nil {
		t.Fatal(err)
	}
	revived := f.ensureAgentDM(fxWS, fxMember, fxAgent)
	if revived == nil || revived.ID != dm.ID || revived.DeletedAt != nil {
		t.Fatalf("revive: %+v", revived)
	}
	if got := f.countPublications(PublicationEventDMNew, dm.ID); got != 2 {
		t.Fatalf("dm:new intents after revive = %d, want 2", got)
	}
}

func TestListDMsWithAgentsKeepsHonestPeerTypes(t *testing.T) {
	f := newFixture(t)
	f.seedAgent(fxM5Peer, fxWS, "peerbot")

	var humanDM *Channel
	f.writeTx(func(tx *sql.Tx) error {
		ensured, err := f.store.EnsureDMTx(f.ctx(), tx, fxWS, fxOwner, fxMember)
		humanDM = ensured
		return err
	})
	agentDM := f.ensureAgentDM(fxWS, fxOwner, fxAgent)

	views, err := f.store.ListDMsWithAgentsTx(f.ctx(), f.db, fxWS, fxOwner)
	if err != nil {
		t.Fatal(err)
	}
	byID := map[string]DMView{}
	for _, v := range views {
		byID[v.Channel.ID] = v
	}
	if len(views) != 2 {
		t.Fatalf("unified list rows = %d, want 2", len(views))
	}
	if v := byID[humanDM.ID]; v.PeerType != "user" || v.PeerName != "member" || v.PeerGravatarHash == "" {
		t.Fatalf("human peer row: %+v", v)
	}
	agent := byID[agentDM.ID]
	if agent.PeerType != "agent" || agent.PeerID != fxAgent || agent.PeerName != "cindy" || agent.PeerGravatarHash != "" {
		t.Fatalf("agent peer row: %+v", agent)
	}

	// The M4-only projection stays byte-stable: no agent rows leak into it.
	legacy, err := f.store.ListDMsTx(f.ctx(), f.db, fxWS, fxOwner)
	if err != nil {
		t.Fatal(err)
	}
	if len(legacy) != 1 || legacy[0].Channel.ID != humanDM.ID {
		t.Fatalf("legacy list rows = %+v", legacy)
	}

	// The DM participant fact answers the implicit-receipt question.
	if id, ok, err := f.store.AgentDMParticipantTx(f.ctx(), f.db, fxWS, agentDM.ID); err != nil || !ok || id != fxAgent {
		t.Fatalf("participant fact: %s %v %v", id, ok, err)
	}
	if _, ok, err := f.store.AgentDMParticipantTx(f.ctx(), f.db, fxWS, humanDM.ID); err != nil || ok {
		t.Fatalf("human dm participant must be absent: %v %v", ok, err)
	}
}

func TestResolveAgentDMByPeerNameAndTargets(t *testing.T) {
	f := newFixture(t)
	f.seedAgent(fxM5Peer, fxWS, "peerbot")

	dm := f.ensureAgentDM(fxWS, fxMember, fxAgent)

	resolved, err := f.store.ResolveAgentDMByPeerNameTx(f.ctx(), f.db, fxWS, fxAgent, "member")
	if err != nil || resolved == nil || resolved.ID != dm.ID {
		t.Fatalf("dm by peer name: %+v %v", resolved, err)
	}
	// Unknown peers and the agent's own workspace strangers stay unresolved.
	if resolved, err := f.store.ResolveAgentDMByPeerNameTx(f.ctx(), f.db, fxWS, fxAgent, "nobody"); err != nil || resolved != nil {
		t.Fatalf("unknown peer: %+v %v", resolved, err)
	}
	if resolved, err := f.store.ResolveAgentDMByPeerNameTx(f.ctx(), f.db, fxWS, fxM5Peer, "member"); err != nil || resolved != nil {
		t.Fatalf("foreign agent: %+v %v", resolved, err)
	}

	// Target DSL: #name resolution and roster gates.
	public, err := f.store.CreateChannel(f.ctx(), CreateInput{WorkspaceID: fxWS, Name: "town", Type: TypeChannel, CreatorUserID: fxOwner})
	if err != nil {
		t.Fatal(err)
	}
	target, err := f.store.ResolveAgentTargetRefTx(f.ctx(), f.db, fxWS, fxAgent, "#town")
	if err != nil || target == nil || target.ChannelID != public.ID || target.ChannelType != TypeChannel {
		t.Fatalf("#town: %+v %v", target, err)
	}
	private, err := f.store.CreateChannel(f.ctx(), CreateInput{WorkspaceID: fxWS, Name: "vault", Type: TypePrivate, CreatorUserID: fxOwner})
	if err != nil {
		t.Fatal(err)
	}
	if target, err := f.store.ResolveAgentTargetRefTx(f.ctx(), f.db, fxWS, fxAgent, "#vault"); err != nil || target != nil {
		t.Fatalf("#vault without roster: %+v %v", target, err)
	}
	if _, err := f.store.AddAgentTx(f.ctx(), private.ID, fxAgent, ""); err != nil {
		t.Fatal(err)
	}
	if target, err := f.store.ResolveAgentTargetRefTx(f.ctx(), f.db, fxWS, fxAgent, "#vault"); err != nil || target == nil || target.ChannelID != private.ID {
		t.Fatalf("#vault with roster: %+v %v", target, err)
	}
	if target, err := f.store.ResolveAgentTargetRefTx(f.ctx(), f.db, fxWS, fxAgent, "#missing"); err != nil || target != nil {
		t.Fatalf("#missing: %+v %v", target, err)
	}
	if target, err := f.store.ResolveAgentTargetRefTx(f.ctx(), f.db, fxWS, fxAgent, "dm:@member"); err != nil || target == nil || target.ChannelID != dm.ID || target.ChannelType != TypeDM {
		t.Fatalf("dm:@member: %+v %v", target, err)
	}
	if target, err := f.store.ResolveAgentTargetRefTx(f.ctx(), f.db, fxWS, fxAgent, "DM:@member"); err != nil || target == nil || target.ChannelID != dm.ID {
		t.Fatalf("legacy DM:@member: %+v %v", target, err)
	}
	if target, err := f.store.ResolveAgentTargetRefTx(f.ctx(), f.db, fxWS, fxAgent, "bogus"); err != nil || target != nil {
		t.Fatalf("bogus ref: %+v %v", target, err)
	}

	// A thread target resolves through the thread storage name and the agent
	// read policy (root inheritance). The short id is the first 8 hex of the
	// parent message UUID, so seed a UUID-shaped parent.
	parentUUID := "abcdef01-2345-4789-8abc-def012345678"
	if _, err := f.db.Exec(`INSERT INTO messages (id, workspace_id, channel_id, sender_type, sender_id, content, request_digest, created_at)
		VALUES (?, ?, ?, 'user', ?, 'thread root', 'test', ?)`,
		parentUUID, fxWS, public.ID, fxOwner, f.clock.T.UnixMilli()); err != nil {
		t.Fatal(err)
	}
	parent := parentUUID
	var thread *Channel
	f.writeTx(func(tx *sql.Tx) error {
		ensured, err := f.store.EnsureThreadTx(f.ctx(), tx, fxWS, public.ID, parent, fxOwner)
		thread = ensured
		return err
	})
	short := parent[0:8]
	if target, err := f.store.ResolveAgentTargetRefTx(f.ctx(), f.db, fxWS, fxAgent, "#town:"+short); err != nil || target == nil || target.ChannelID != thread.ID || target.ChannelType != TypeThread {
		t.Fatalf("#town:%s: %+v %v", short, target, err)
	}
	// Every live workspace agent may READ a public channel's thread (the
	// original agent read policy), so the peer resolves it too.
	if target, err := f.store.ResolveAgentTargetRefTx(f.ctx(), f.db, fxWS, fxM5Peer, "#town:"+short); err != nil || target == nil || target.ChannelID != thread.ID {
		t.Fatalf("public thread for peer: %+v %v", target, err)
	}

	// A thread rooted at the private channel stays invisible to the
	// roster-less agent even when the storage name is known.
	privateParent := "abcdef99-2345-4789-8abc-def012345678"
	if _, err := f.db.Exec(`INSERT INTO messages (id, workspace_id, channel_id, sender_type, sender_id, content, request_digest, created_at)
		VALUES (?, ?, ?, 'user', ?, 'private root', 'test', ?)`,
		privateParent, fxWS, private.ID, fxOwner, f.clock.T.UnixMilli()); err != nil {
		t.Fatal(err)
	}
	var privateThread *Channel
	f.writeTx(func(tx *sql.Tx) error {
		ensured, err := f.store.EnsureThreadTx(f.ctx(), tx, fxWS, private.ID, privateParent, fxOwner)
		privateThread = ensured
		return err
	})
	if target, err := f.store.ResolveAgentTargetRefTx(f.ctx(), f.db, fxWS, fxM5Peer, "#vault:"+privateParent[0:8]); err != nil || target != nil {
		t.Fatalf("private thread for stranger: %+v %v", target, err)
	}
	if target, err := f.store.ResolveAgentTargetRefTx(f.ctx(), f.db, fxWS, fxAgent, "#vault:"+privateParent[0:8]); err != nil || target == nil || target.ChannelID != privateThread.ID {
		t.Fatalf("private thread for roster member: %+v %v", target, err)
	}
}
