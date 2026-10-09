// M5 agent conversation authorization tests: the fail-closed matrix over
// real agent/workspace/conversation facts, mirroring the original TS
// canAgentAccessChannel / canAgentPostToChannel semantics.
package channel

import (
	"database/sql"
	"testing"

	platformdb "raft.local/server-go/internal/platform/db"
)

// writeTx runs fn in one write transaction on the fixture handle.
func (f *fixture) writeTx(fn func(tx *sql.Tx) error) {
	f.t.Helper()
	if err := platformdb.WithWriteTx(f.ctx(), f.db, fn); err != nil {
		f.t.Fatal(err)
	}
}

// The real migration chain (0001–0014) is applied by platformdb.Open; the
// M5 tables the channel domain writes (agent_direct_messages) come from the
// delivery worker's frozen 0014_delivery.sql (docs/m5-delivery-worker-contract.md §1).
func (f *fixture) seedAgent(id, workspace, name string) {
	f.t.Helper()
	if _, err := f.db.Exec(`INSERT INTO agents (id, workspace_id, name, status, runtime, created_at, updated_at)
		VALUES (?, ?, ?, 'active', 'claude', ?, ?)`, id, workspace, name, f.clock.T.UnixMilli(), f.clock.T.UnixMilli()); err != nil {
		f.t.Fatal(err)
	}
}

// fxM5CrossWS is an agent of the SECOND workspace; fxM5Peer is a second
// live agent of the fixture workspace.
const (
	fxM5CrossWS = "dddddddd-dddd-4ddd-8ddd-ddddddddda01"
	fxM5Peer    = "dddddddd-dddd-4ddd-8ddd-ddddddddda02"
)

func (f *fixture) authorizeAgentErr(workspaceID, channelID, agentID string, posting bool) *DomainError {
	_, err := f.store.AuthorizeAgentConversationTx(f.ctx(), f.db, workspaceID, channelID, agentID, posting)
	return AsDomainError(err)
}

func TestAuthorizeAgentConversationMatrix(t *testing.T) {
	f := newFixture(t)
	f.seedAgent(fxM5CrossWS, fxWS2, "bravo")
	f.seedAgent(fxM5Peer, fxWS, "peerbot")

	public, err := f.store.CreateChannel(f.ctx(), CreateInput{WorkspaceID: fxWS, Name: "town", Type: TypeChannel, CreatorUserID: fxOwner})
	if err != nil {
		t.Fatal(err)
	}

	t.Run("agent of another workspace is refused before anything else", func(t *testing.T) {
		de := f.authorizeAgentErr(fxWS, public.ID, fxM5CrossWS, false)
		if de == nil || de.Code != CodeForbidden || de.Message != NotServerMemberMessage {
			t.Fatalf("foreign agent: %+v", de)
		}
	})

	t.Run("deleted agent loses every conversation", func(t *testing.T) {
		if _, err := f.db.Exec(`UPDATE agents SET deleted_at = ? WHERE id = ?`, f.clock.T.UnixMilli(), fxAgent); err != nil {
			t.Fatal(err)
		}
		de := f.authorizeAgentErr(fxWS, public.ID, fxAgent, false)
		if de == nil || de.Code != CodeForbidden {
			t.Fatalf("deleted agent: %+v", de)
		}
		if _, err := f.db.Exec(`UPDATE agents SET deleted_at = NULL WHERE id = ?`, fxAgent); err != nil {
			t.Fatal(err)
		}
	})

	t.Run("public channel reads without roster, posts need one", func(t *testing.T) {
		conv, err := f.store.AuthorizeAgentConversationTx(f.ctx(), f.db, fxWS, public.ID, fxAgent, false)
		if err != nil || conv.Root.ID != public.ID || conv.IsMember {
			t.Fatalf("public agent read: %+v %v", conv, err)
		}
		de := f.authorizeAgentErr(fxWS, public.ID, fxAgent, true)
		if de == nil || de.Code != CodeForbidden || de.Message != postJoinRequiredMessage {
			t.Fatalf("public agent post without roster: %+v", de)
		}
		if _, err := f.store.AddAgentTx(f.ctx(), public.ID, fxAgent, ""); err != nil {
			t.Fatal(err)
		}
		conv, err = f.store.AuthorizeAgentConversationTx(f.ctx(), f.db, fxWS, public.ID, fxAgent, true)
		if err != nil || !conv.IsMember {
			t.Fatalf("public agent post with roster: %+v %v", conv, err)
		}
	})

	t.Run("enabled system channels admit every live workspace agent", func(t *testing.T) {
		if _, err := f.db.Exec(`INSERT INTO channels (id, workspace_id, name, type, system_kind, created_at)
			VALUES ('ch-m5-all', ?, 'all', 'channel', 'all', ?)`, fxWS, f.clock.T.UnixMilli()); err != nil {
			t.Fatal(err)
		}
		conv, err := f.store.AuthorizeAgentConversationTx(f.ctx(), f.db, fxWS, "ch-m5-all", fxM5Peer, true)
		if err != nil || conv.Root.ID != "ch-m5-all" {
			t.Fatalf("implicit system post: %+v %v", conv, err)
		}
	})

	t.Run("hidden #all never opens for agents", func(t *testing.T) {
		// One #all row per workspace: hiding flips its type to private.
		if _, err := f.db.Exec(`UPDATE channels SET type = 'private' WHERE id = 'ch-m5-all'`); err != nil {
			t.Fatal(err)
		}
		if de := f.authorizeAgentErr(fxWS, "ch-m5-all", fxAgent, false); de == nil || de.Code != CodeNotFound {
			t.Fatalf("hidden #all agent read: %+v", de)
		}
		if de := f.authorizeAgentErr(fxWS, "ch-m5-all", fxAgent, true); de == nil || de.Code != CodeForbidden {
			t.Fatalf("hidden #all agent post: %+v", de)
		}
		if _, err := f.db.Exec(`UPDATE channels SET type = 'channel' WHERE id = 'ch-m5-all'`); err != nil {
			t.Fatal(err)
		}
	})

	t.Run("private channels stay roster-only", func(t *testing.T) {
		private, err := f.store.CreateChannel(f.ctx(), CreateInput{WorkspaceID: fxWS, Name: "secret", Type: TypePrivate, CreatorUserID: fxOwner})
		if err != nil {
			t.Fatal(err)
		}
		if de := f.authorizeAgentErr(fxWS, private.ID, fxAgent, false); de == nil || de.Code != CodeNotFound {
			t.Fatalf("private agent read without roster: %+v", de)
		}
		if _, err := f.store.AddAgentTx(f.ctx(), private.ID, fxAgent, ""); err != nil {
			t.Fatal(err)
		}
		if _, err := f.store.AuthorizeAgentConversationTx(f.ctx(), f.db, fxWS, private.ID, fxAgent, false); err != nil {
			t.Fatalf("private agent read with roster: %v", err)
		}
	})

	t.Run("threads inherit the root policy and archived roots refuse", func(t *testing.T) {
		parent := f.insertMessage(t, fxWS, public.ID, "user", fxOwner, "thread root")
		var thread *Channel
		f.writeTx(func(tx *sql.Tx) error {
			ensured, err := f.store.EnsureThreadTx(f.ctx(), tx, fxWS, public.ID, parent, fxOwner)
			thread = ensured
			return err
		})
		// fxAgent joined the public root above; the thread inherits that
		// posting authority.
		conv, err := f.store.AuthorizeAgentConversationTx(f.ctx(), f.db, fxWS, thread.ID, fxAgent, true)
		if err != nil || conv.Root.ID != public.ID || conv.ParentMessageID != parent {
			t.Fatalf("thread inheritance: %+v %v", conv, err)
		}
		if _, err := f.db.Exec(`UPDATE channels SET archived_at = ? WHERE id = ?`, f.clock.T.UnixMilli(), public.ID); err != nil {
			t.Fatal(err)
		}
		if de := f.authorizeAgentErr(fxWS, thread.ID, fxAgent, true); de == nil || de.Code != CodeConflict {
			t.Fatalf("archived root thread post: %+v", de)
		}
		if _, err := f.db.Exec(`UPDATE channels SET archived_at = NULL WHERE id = ?`, public.ID); err != nil {
			t.Fatal(err)
		}
	})
}

func TestAuthorizeAgentConversationDMParticipantsOnly(t *testing.T) {
	f := newFixture(t)
	f.seedAgent(fxM5CrossWS, fxWS2, "bravo")
	f.seedAgent(fxM5Peer, fxWS, "peerbot")

	var dm *Channel
	f.writeTx(func(tx *sql.Tx) error {
		ensured, err := f.store.EnsureDMTx(f.ctx(), tx, fxWS, fxOwner, fxMember)
		dm = ensured
		return err
	})
	// A human-human DM has no channel_agents row: agents are strangers.
	if de := f.authorizeAgentErr(fxWS, dm.ID, fxAgent, false); de == nil || de.Code != CodeNotFound {
		t.Fatalf("human dm agent read: %+v", de)
	}

	var agentDM *Channel
	f.writeTx(func(tx *sql.Tx) error {
		ensured, err := f.store.EnsureAgentDMTx(f.ctx(), tx, fxWS, fxMember, fxAgent)
		agentDM = ensured
		return err
	})
	// The participant agent may read and post; every other agent may not.
	if _, err := f.store.AuthorizeAgentConversationTx(f.ctx(), f.db, fxWS, agentDM.ID, fxAgent, true); err != nil {
		t.Fatalf("agent dm participant post: %v", err)
	}
	if de := f.authorizeAgentErr(fxWS, agentDM.ID, fxM5Peer, false); de == nil || de.Code != CodeNotFound {
		t.Fatalf("agent dm stranger read: %+v", de)
	}
}
