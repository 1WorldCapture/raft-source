package presenter

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"raft.local/server-go/internal/auth"
	"raft.local/server-go/internal/channel"
	"raft.local/server-go/internal/message"
	platformdb "raft.local/server-go/internal/platform/db"
	"raft.local/server-go/internal/readstate"
)

// The presenter owns the client wire for the message family. These tests pin
// the sealed socket payloads, the #632 frontier union bytes, the creation
// surface subset and the canonical presence semantics of the full DTO.

type penv struct {
	t        *testing.T
	db       *sql.DB
	channels *channel.Store
	messages *message.Store
}

func newPenv(t *testing.T) *penv {
	t.Helper()
	handle, err := platformdb.Open(filepath.Join(t.TempDir(), "raft.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = handle.Close() })
	channels := channel.NewStore(handle)
	return &penv{t: t, db: handle, channels: channels, messages: message.NewStore(handle, channels)}
}

const (
	pWS      = "aaaaaaa2-0000-4000-8000-000000000001"
	pGeneral = "aaaaaaa2-0000-4000-8000-000000000002"
	pAlice   = "aaaaaaa2-0000-4000-8000-000000000003"
	pBob     = "aaaaaaa2-0000-4000-8000-000000000004"
)

func (e *penv) exec(query string, args ...any) {
	e.t.Helper()
	if _, err := e.db.Exec(query, args...); err != nil {
		e.t.Fatal(err)
	}
}

func (e *penv) seed() {
	e.t.Helper()
	e.exec(`INSERT INTO users (id, email, name, password_hash, email_verified, profile_setup_completed_at, created_at, updated_at)
		VALUES (?, 'alice@t', 'alice', 'x', 1, 1, 0, 0), (?, 'bob@t', 'bob', 'x', 1, 1, 0, 0)`, pAlice, pBob)
	e.exec(`INSERT INTO session_families (id, user_id, created_at) VALUES ('fam-a', ?, 0), ('fam-b', ?, 0)`, pAlice, pBob)
	e.exec(`INSERT INTO workspaces (id, name, slug, owner_id, created_at) VALUES (?, 'w', 'w', ?, 0)`, pWS, pAlice)
	e.exec(`INSERT INTO workspace_memberships (workspace_id, user_id, role, joined_at) VALUES (?, ?, 'owner', 0), (?, ?, 'member', 0)`, pWS, pAlice, pWS, pBob)
	e.exec(`INSERT INTO channels (id, workspace_id, name, type, created_at) VALUES (?, ?, 'general', 'channel', 0)`, pGeneral, pWS)
	e.exec(`INSERT INTO channel_humans (channel_id, user_id, role, joined_at) VALUES (?, ?, 'member', 0), (?, ?, 'member', 0)`, pGeneral, pAlice, pGeneral, pBob)
}

func (e *penv) claims(user string) message.Claims {
	return message.NewClaims(claimsOf(user))
}

func (e *penv) send(user, content string) *message.CreateResult {
	e.t.Helper()
	var result *message.CreateResult
	err := platformdb.WithWriteTx(context.Background(), e.db, func(tx *sql.Tx) error {
		created, err := e.messages.CreateMessageTx(context.Background(), tx, claimsOf(user), pWS, message.CreateInput{
			ChannelID: pGeneral, Content: content,
		})
		if err != nil {
			return err
		}
		if err := e.messages.RecordSendPublicationsTx(context.Background(), tx, pWS, created); err != nil {
			return err
		}
		result = created
		return nil
	})
	if err != nil {
		e.t.Fatal(err)
	}
	return result
}

// claimsOf builds one user's verified access-token claims (the family ids
// match the seeded session families).
func claimsOf(user string) auth.AccessTokenClaims {
	now := time.Now()
	family := "fam-a"
	if user == pBob {
		family = "fam-b"
	}
	return auth.AccessTokenClaims{
		Subject: user, Type: "access", FamilyID: family,
		IssuedAt: now.Add(-time.Minute), ExpiresAt: now.Add(time.Hour),
	}
}

func TestSocketUpdatedInContextSealsAndCarriesContext(t *testing.T) {
	e := newPenv(t)
	e.seed()
	created := e.send(pAlice, "seal")
	projection, err := e.messages.ProjectPublication(context.Background(), message.PublicationRef{
		WorkspaceID: pWS, ObjectType: "message", ObjectID: created.Message.ID,
		EventType: "message:updated", Revision: 1,
	})
	if err != nil || projection == nil {
		t.Fatalf("projection: %v %v", projection, err)
	}

	payload := SocketMessageUpdatedInContext(MessageWire(projection.Message), ConversationContextWire(projection.ConversationContext))
	if _, ok := payload["conversationContext"]; !ok {
		t.Fatalf("message:updated socket payload must carry the conversation context")
	}
	for _, sealed := range []string{"searchText", "searchVector", "agentSendKey", "senderHandle"} {
		if _, ok := payload[sealed]; ok {
			t.Fatalf("sealed storage column %q present on message:updated payload", sealed)
		}
	}
	for _, viewerPrivate := range []string{"reactionViewer", "readState", "maxReadSeq", "activityMuted", "collapseLongMessages"} {
		if _, ok := payload[viewerPrivate]; ok {
			t.Fatalf("viewer-private field %q leaked onto the shared payload", viewerPrivate)
		}
	}
	// A nil context must not fabricate one (omitempty anchors stay absent).
	bare := SocketMessageUpdatedInContext(MessageWire(projection.Message), nil)
	if _, ok := bare["conversationContext"]; ok {
		t.Fatalf("nil context must stay nil, never fabricated")
	}
}

// The full wire DTO keeps the canonical presence semantics: reactions,
// mentions and attachments ALWAYS render as arrays; the ISO timestamps use
// the legacy millisecond shape; the M4-disabled facts stay present with
// their honest null values.
func TestMessageWirePresenceSemantics(t *testing.T) {
	e := newPenv(t)
	e.seed()
	created := e.send(pAlice, "presence")
	projections, err := e.messages.ProjectSnapshot(context.Background(), pWS, []*message.Message{created.Message})
	if err != nil || len(projections) != 1 {
		t.Fatalf("projection: %v %v", projections, err)
	}
	raw, err := json.Marshal(MessageWire(projections[0]))
	if err != nil {
		t.Fatal(err)
	}
	var decoded map[string]any
	if err := json.Unmarshal(raw, &decoded); err != nil {
		t.Fatal(err)
	}
	for _, key := range []string{"reactions", "mentions", "attachments", "agentSendKey", "searchText", "threadId", "actionMetadata"} {
		if _, ok := decoded[key]; !ok {
			t.Fatalf("canonical field %q missing: %s", key, raw)
		}
	}
	if reactions, ok := decoded["reactions"].([]any); !ok || len(reactions) != 0 {
		t.Fatalf("reactions must render as an empty array: %s", raw)
	}
	if _, ok := decoded["createdAt"].(string); !ok || !strings.HasSuffix(decoded["createdAt"].(string), "Z") {
		t.Fatalf("createdAt must be the legacy ISO millisecond string: %s", raw)
	}

	// The send surface subset: same row facts, no reactions/handle fields.
	send := SendResponseWire(projections[0])
	sendRaw, _ := json.Marshal(send)
	var sendDecoded map[string]any
	_ = json.Unmarshal(sendRaw, &sendDecoded)
	if _, ok := sendDecoded["reactions"]; ok {
		t.Fatalf("send surface must not carry reactions: %s", sendRaw)
	}
	if sendDecoded["senderMembershipStatus"] != "active" {
		t.Fatalf("send surface membership status = %v, want active: %s", sendDecoded["senderMembershipStatus"], sendRaw)
	}
}

// The #632 InboxScopeReadFrontier union renders byte-exact from the typed
// facts: absent, present with the decimal-string cursor and the same-source
// activity pair, present with a null pair.
func TestReadFrontierUnionRendersExactWire(t *testing.T) {
	absent := &readstate.ReadFrontier{Kind: "absent"}
	if string(ReadFrontierUnion(absent)) != `{"kind":"absent"}` {
		t.Fatalf("absent wire = %s", ReadFrontierUnion(absent))
	}
	present := &readstate.ReadFrontier{Kind: "present", Version: 3, MaxReadSeq: 42,
		LatestID: "m_1", LatestSeq: 42, LatestValid: true}
	raw := string(ReadFrontierUnion(present))
	var decoded map[string]any
	if err := json.Unmarshal([]byte(raw), &decoded); err != nil {
		t.Fatal(err)
	}
	if decoded["kind"] != "present" || decoded["maxReadSeq"] != "42" || decoded["readStateVersion"] != float64(3) {
		t.Fatalf("present wire = %s", raw)
	}
	activity := decoded["latestActivity"].(map[string]any)
	if activity["seq"] != "42" || activity["messageId"] != "m_1" {
		t.Fatalf("latestActivity pair = %s", raw)
	}
	nullPair := &readstate.ReadFrontier{Kind: "present", Version: 1, MaxReadSeq: 7}
	raw = string(ReadFrontierUnion(nullPair))
	if !strings.Contains(raw, `"latestActivity":null`) {
		t.Fatalf("null pair wire = %s", raw)
	}
}

// TestReferenceVerifierRunsOriginalManifestAndViewerReducer feeds REAL
// Go-produced wire JSON (message DTOs rendered by the presenter and ordered
// viewer snapshots from the actual reaction mutations) through the original
// TS/Web sources via the owned Node runner in the message testdata. The
// runner imports the frozen modules directly (packages/shared manifest +
// packages/web reactionReadModels reducer); nothing is re-implemented here.
//
// A missing node/tsx toolchain is a FAILURE, not a skip: this check is part
// of the M4 contract-freeze evidence.
func TestReferenceVerifierRunsOriginalManifestAndViewerReducer(t *testing.T) {
	repoRoot := findRepoRoot(t)
	bundled := buildReferenceVerifier(t, repoRoot)

	e := newPenv(t)
	e.seed()
	msg := e.send(pAlice, "reference verify")

	type snap struct {
		ServerID      string   `json:"serverId"`
		MessageID     string   `json:"messageId"`
		ViewerVersion int64    `json:"viewerVersion"`
		ReactedEmojis []string `json:"reactedEmojis"`
	}
	var snapshots []snap
	collect := func() {
		t.Helper()
		state, _, err := e.messages.ViewerSnapshot(context.Background(), e.claims(pAlice), pWS, msg.Message.ID)
		if err != nil {
			t.Fatal(err)
		}
		snapshots = append(snapshots, snap{
			ServerID: pWS, MessageID: msg.Message.ID,
			ViewerVersion: state.ViewerVersion,
			ReactedEmojis: state.ReactedEmojis,
		})
	}
	for _, step := range []struct {
		add   bool
		emoji string
	}{
		{true, "a"}, {true, "b"}, {false, "b"}, {true, "b"},
	} {
		var err error
		if step.add {
			_, err = e.messages.AddReaction(context.Background(), e.claims(pAlice), pWS, msg.Message.ID, step.emoji)
		} else {
			_, err = e.messages.RemoveReaction(context.Background(), e.claims(pAlice), pWS, msg.Message.ID, step.emoji)
		}
		if err != nil {
			t.Fatal(err)
		}
		collect()
	}
	seq := map[string]any{
		"principalId": pAlice,
		"snapshots":   append(snapshots, snapshots[1], snapshots[len(snapshots)-1]),
		"expected":    []string{"applied", "applied", "applied", "applied", "stale", "duplicate"},
	}

	page, err := e.messages.ListChannelPage(context.Background(), e.claims(pAlice), pWS, pGeneral, message.PageQuery{Limit: 10})
	if err != nil {
		t.Fatal(err)
	}
	wire := MessageWireList(page.Projections)

	dir := t.TempDir()
	seqRaw, err := json.Marshal(seq)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "viewer_sequence.json"), seqRaw, 0o644); err != nil {
		t.Fatal(err)
	}
	for i, dto := range wire {
		raw, err := json.Marshal(dto)
		if err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(dir, fmt.Sprintf("message_%03d.json", i)), raw, 0o644); err != nil {
			t.Fatal(err)
		}
	}

	out, err := exec.Command("node", bundled, dir).CombinedOutput()
	if err != nil {
		t.Fatalf("reference verifier failed: %v\n%s", err, out)
	}
	if !strings.Contains(string(out), "REFERENCE-VERIFY-OK") {
		t.Fatalf("reference verifier did not confirm: %s", out)
	}
}

// buildReferenceVerifier bundles the runner plus the ORIGINAL TS modules
// with the workspace's own esbuild, so plain node executes it without any
// TS service or daemon (the sandbox forbids local socket listeners).
func buildReferenceVerifier(t *testing.T, repoRoot string) string {
	t.Helper()
	if _, err := exec.LookPath("node"); err != nil {
		t.Fatalf("node is required for the reference verifier: %v", err)
	}
	esbuild := findEsbuild(t, repoRoot)
	bundled := filepath.Join(t.TempDir(), "reference_verify.bundle.mjs")
	cmd := exec.Command(esbuild,
		filepath.Join("internal", "message", "testdata", "reference_verify.mjs"),
		"--bundle", "--platform=node", "--format=esm",
		"--outfile="+bundled)
	cmd.Dir = filepath.Join(repoRoot, "server-go")
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("esbuild bundle failed: %v\n%s", err, out)
	}
	return bundled
}

// findEsbuild locates the workspace's esbuild CLI under .pnpm.
func findEsbuild(t *testing.T, repoRoot string) string {
	t.Helper()
	matches, err := filepath.Glob(filepath.Join(repoRoot, "node_modules", ".pnpm", "esbuild@*", "node_modules", "esbuild", "bin", "esbuild"))
	if err != nil || len(matches) == 0 {
		t.Fatalf("workspace esbuild not found: %v", err)
	}
	return matches[len(matches)-1]
}

// findRepoRoot walks up from the working directory to the pnpm workspace root.
func findRepoRoot(t *testing.T) string {
	t.Helper()
	dir, err := os.Getwd()
	if err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 8; i++ {
		if _, err := os.Stat(filepath.Join(dir, "pnpm-workspace.yaml")); err == nil {
			return dir
		}
		dir = filepath.Dir(dir)
	}
	t.Fatal("pnpm workspace root not found")
	return ""
}
