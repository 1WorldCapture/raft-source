// M5 typed agent mention tests: resolution against the live agent directory,
// the receipt-eligibility policy, the split fact tables, replay semantics
// and whole-write atomicity under an injected late failure.
package message

import (
	"context"
	"database/sql"
	"strings"
	"testing"

	platformdb "raft.local/server-go/internal/platform/db"
)

const (
	txAgent  = "cccccccc-cccc-4ccc-8ccc-cccccccccccc"
	txAgent2 = "dddddddd-dddd-4ddd-8ddd-ddddddddda02"
)

// The real migration chain (0001–0014) is applied by platformdb.Open; the
// M5 fact table message_agent_mentions comes from the delivery worker's
// frozen 0014_delivery.sql.
func (f *fixture) seedAgent(id, workspace, name string) {
	f.t.Helper()
	if _, err := f.db.Exec(`INSERT INTO agents (id, workspace_id, name, status, runtime, created_at, updated_at)
		VALUES (?, ?, ?, 'active', 'claude', ?, ?)`, id, workspace, name, f.clock.Now().UnixMilli(), f.clock.Now().UnixMilli()); err != nil {
		f.t.Fatal(err)
	}
}

// sendWithAgents commits through the M5 human scope inside one transaction.
func (f *fixture) sendWithAgents(user, family, channelID, content string, randomID *string, mentions []Mention) (*CreateResult, error) {
	var result *CreateResult
	err := platformdb.WithWriteTx(context.Background(), f.db, func(tx *sql.Tx) error {
		created, err := f.store.CreateMessageTx(context.Background(), tx, claimsFor(user, family), txWS, CreateInput{
			ChannelID: channelID, Content: content, RandomID: randomID, Mentions: mentions,
		})
		if err != nil {
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

func agentMention(id, handle string) Mention {
	return Mention{Type: "agent", ID: id, Name: handle}
}

func TestAgentMentionResolutionMatrix(t *testing.T) {
	f := newFixture(t)
	f.seed()
	f.seedAgent(txAgent, txWS, "cindy")
	f.seedAgent(txAgent2, txWS2, "cindy") // same handle, other workspace

	enabledAll := "eeeeeeee-eeee-4eee-8eee-eeeeeeeeee01"
	if _, err := f.db.Exec(`INSERT INTO channels (id, workspace_id, name, type, system_kind, created_at)
		VALUES (?, ?, 'all', 'channel', 'all', ?)`, enabledAll, txWS, f.clock.Now().UnixMilli()); err != nil {
		t.Fatal(err)
	}

	t.Run("enabled system channel mention resolves for a live workspace agent", func(t *testing.T) {
		created, err := f.sendWithAgents(txAlice, txFamAlice, enabledAll, "hello @cindy", nil, []Mention{agentMention(txAgent, "cindy")})
		if err != nil {
			t.Fatal(err)
		}
		if got := created.AgentMentionIDs(); len(got) != 1 || got[0] != txAgent {
			t.Fatalf("agent targets = %v", got)
		}
		var handle string
		if err := f.db.QueryRow(`SELECT handle_at_send FROM message_agent_mentions WHERE message_id = ?`, created.Message.ID).Scan(&handle); err != nil || handle != "cindy" {
			t.Fatalf("agent fact: %q %v", handle, err)
		}
		if created.RootChannelID != enabledAll {
			t.Fatalf("root = %s", created.RootChannelID)
		}
	})

	t.Run("unknown, deleted, cross-workspace and handle-mismatched targets reject", func(t *testing.T) {
		missing := "eeeeeeee-eeee-4eee-8eee-eeeeeeeeee02"
		_, err := f.sendWithAgents(txAlice, txFamAlice, enabledAll, "x", nil, []Mention{agentMention(missing, "cindy")})
		if inv := AsInvalidInput(err); inv == nil || !strings.Contains(inv.Reason, "is not an agent of this workspace") {
			t.Fatalf("missing agent: %+v", err)
		}
		if _, err := f.sendWithAgents(txAlice, txFamAlice, enabledAll, "x", nil, []Mention{agentMention(txAgent2, "cindy")}); AsInvalidInput(err) == nil {
			t.Fatalf("cross-workspace agent accepted: %v", err)
		}
		if _, err := f.db.Exec(`UPDATE agents SET deleted_at = 1 WHERE id = ?`, txAgent2); err != nil {
			t.Fatal(err)
		}
		if _, err := f.sendWithAgents(txAlice, txFamAlice, enabledAll, "x", nil, []Mention{agentMention(txAgent2, "cindy")}); AsInvalidInput(err) == nil {
			t.Fatalf("deleted agent accepted: %v", err)
		}
		if _, err := f.sendWithAgents(txAlice, txFamAlice, enabledAll, "x", nil, []Mention{agentMention(txAgent, "notcindy")}); AsInvalidInput(err) == nil {
			t.Fatalf("handle mismatch accepted: %v", err)
		}
	})

	t.Run("ordinary channel requires the agent roster, and rejection leaves zero rows", func(t *testing.T) {
		if _, err := f.db.Exec(`INSERT INTO channels (id, workspace_id, name, type, created_at)
			VALUES ('eeeeeeee-eeee-4eee-8eee-eeeeeeeeee03', ?, 'town', 'channel', ?)`, txWS, f.clock.Now().UnixMilli()); err != nil {
			t.Fatal(err)
		}
		town := "eeeeeeee-eeee-4eee-8eee-eeeeeeeeee03"
		if _, err := f.db.Exec(`INSERT INTO channel_humans (channel_id, user_id, role, authority_revision, joined_at)
			VALUES (?, ?, 'member', 1, ?)`, town, txAlice, f.clock.Now().UnixMilli()); err != nil {
			t.Fatal(err)
		}
		if _, err := f.sendWithAgents(txAlice, txFamAlice, town, "x", nil, []Mention{agentMention(txAgent, "cindy")}); AsInvalidInput(err) == nil {
			t.Fatalf("roster-less agent mention accepted: %v", err)
		}
		var n int
		if err := f.db.QueryRow(`SELECT COUNT(*) FROM messages WHERE channel_id = ?`, town).Scan(&n); err != nil || n != 0 {
			t.Fatalf("rejected send left %d messages", n)
		}
		if err := f.db.QueryRow(`SELECT COUNT(*) FROM message_agent_mentions`).Scan(&n); err != nil || n != 1 {
			t.Fatalf("agent facts = %d, want only the system-channel one", n)
		}
		if _, err := f.db.Exec(`INSERT INTO channel_agents (channel_id, agent_id, role, authority_revision, added_at)
			VALUES (?, ?, 'member', 1, ?)`, town, txAgent, f.clock.Now().UnixMilli()); err != nil {
			t.Fatal(err)
		}
		if _, err := f.sendWithAgents(txAlice, txFamAlice, town, "hi @cindy", nil, []Mention{agentMention(txAgent, "cindy")}); err != nil {
			t.Fatalf("roster mention rejected: %v", err)
		}
	})

	t.Run("same handle bound to a user and an agent is the v2 binding conflict", func(t *testing.T) {
		if _, err := f.sendWithAgents(txAlice, txFamAlice, enabledAll, "x", nil,
			[]Mention{agentMention(txAgent, "bob"), {Type: "user", ID: txBob, Name: "bob"}}); AsMentionBindingConflict(err) == nil {
			t.Fatalf("cross-type binding conflict accepted: %v", err)
		}
	})

	t.Run("the single create path persists the typed agent mention", func(t *testing.T) {
		created, err := f.sendWithAgents(txAlice, txFamAlice, enabledAll, "again @cindy", nil, []Mention{agentMention(txAgent, "cindy")})
		if err != nil {
			t.Fatal(err)
		}
		if got := created.AgentMentionIDs(); len(got) != 1 || got[0] != txAgent {
			t.Fatalf("agent targets = %v", got)
		}
	})
}

func TestAgentMentionReplayAndMixedFacts(t *testing.T) {
	f := newFixture(t)
	f.seed()
	f.seedAgent(txAgent, txWS, "cindy")

	general := "eeeeeeee-eeee-4eee-8eee-eeeeeeeeee10"
	if _, err := f.db.Exec(`INSERT INTO channels (id, workspace_id, name, type, system_kind, created_at)
		VALUES (?, ?, 'all', 'channel', 'all', ?)`, general, txWS, f.clock.Now().UnixMilli()); err != nil {
		t.Fatal(err)
	}
	if _, err := f.db.Exec(`INSERT INTO channel_agents (channel_id, agent_id, role, authority_revision, added_at)
		VALUES (?, ?, 'member', 1, ?)`, general, txAgent, f.clock.Now().UnixMilli()); err != nil {
		t.Fatal(err)
	}

	rid := stringPtr("agent-mixed-1")
	created, err := f.sendWithAgents(txAlice, txFamAlice, general, "hi @bob @cindy", rid,
		[]Mention{{Type: "user", ID: txBob, Name: "bob"}, agentMention(txAgent, "cindy")})
	if err != nil {
		t.Fatal(err)
	}
	var userFacts, agentFacts int
	if err := f.db.QueryRow(`SELECT COUNT(*) FROM message_mentions WHERE message_id = ?`, created.Message.ID).Scan(&userFacts); err != nil {
		t.Fatal(err)
	}
	if err := f.db.QueryRow(`SELECT COUNT(*) FROM message_agent_mentions WHERE message_id = ?`, created.Message.ID).Scan(&agentFacts); err != nil {
		t.Fatal(err)
	}
	if userFacts != 1 || agentFacts != 1 {
		t.Fatalf("facts user=%d agent=%d", userFacts, agentFacts)
	}

	// Same randomId + same digest: original message, zero new facts.
	before := atomicMessageFacts(t, f.db)
	replayed, err := f.sendWithAgents(txAlice, txFamAlice, general, "hi @bob @cindy", rid,
		[]Mention{{Type: "user", ID: txBob, Name: "bob"}, agentMention(txAgent, "cindy")})
	if err != nil || !replayed.Replayed || replayed.Message.ID != created.Message.ID {
		t.Fatalf("replay: %+v %v", replayed, err)
	}
	if got := replayed.AgentMentionIDs(); len(got) != 1 || got[0] != txAgent {
		t.Fatalf("replay agent targets = %v", got)
	}
	if after := atomicMessageFacts(t, f.db); before != after {
		t.Fatal("replay changed persisted facts")
	}

	// Same randomId, different digest: conflict, original not leaked.
	if _, err := f.sendWithAgents(txAlice, txFamAlice, general, "different", rid,
		[]Mention{agentMention(txAgent, "cindy")}); AsRandomIDConflict(err) == nil {
		t.Fatalf("digest conflict accepted: %v", err)
	}
}

func TestAgentMentionPlanFailureRollsBackWholeSend(t *testing.T) {
	f := newFixture(t)
	f.seed()
	f.seedAgent(txAgent, txWS, "cindy")

	all := "eeeeeeee-eeee-4eee-8eee-eeeeeeeeee20"
	if _, err := f.db.Exec(`INSERT INTO channels (id, workspace_id, name, type, system_kind, created_at)
		VALUES (?, ?, 'all', 'channel', 'all', ?)`, all, txWS, f.clock.Now().UnixMilli()); err != nil {
		t.Fatal(err)
	}
	before := atomicMessageFacts(t, f.db)

	// Fail the agent fact write AFTER the message insert: the whole send
	// must roll back (no message orphan, no ghost receipt fact).
	if _, err := f.db.Exec(`CREATE TRIGGER fail_agent_mention
		BEFORE INSERT ON message_agent_mentions
		BEGIN SELECT RAISE(ABORT, 'injected agent mention storage failure'); END`); err != nil {
		t.Fatal(err)
	}
	_, err := f.sendWithAgents(txAlice, txFamAlice, all, "x", nil, []Mention{agentMention(txAgent, "cindy")})
	if err == nil || !strings.Contains(err.Error(), "injected agent mention storage failure") {
		t.Fatalf("expected injected failure, got %v", err)
	}
	if after := atomicMessageFacts(t, f.db); before != after {
		t.Fatal("failed send changed persisted facts")
	}

	if _, err := f.db.Exec(`DROP TRIGGER fail_agent_mention`); err != nil {
		t.Fatal(err)
	}
	if _, err := f.sendWithAgents(txAlice, txFamAlice, all, "x", nil, []Mention{agentMention(txAgent, "cindy")}); err != nil {
		t.Fatalf("recovery send failed: %v", err)
	}
}

func atomicMessageFacts(t *testing.T, handle *sql.DB) string {
	t.Helper()
	rows, err := handle.Query(`SELECT 'msg:' || id FROM messages
		UNION ALL SELECT 'um:' || message_id || ':' || user_id FROM message_mentions
		UNION ALL SELECT 'am:' || message_id || ':' || agent_id FROM message_agent_mentions
		UNION ALL SELECT 'pub:' || id FROM realtime_publications ORDER BY 1`)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	var out strings.Builder
	for rows.Next() {
		var s string
		if err := rows.Scan(&s); err != nil {
			t.Fatal(err)
		}
		out.WriteString(s + "\n")
	}
	if err := rows.Err(); err != nil {
		t.Fatal(err)
	}
	return out.String()
}
