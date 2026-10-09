package humanapi_test

import (
	"encoding/json"
	"net/http"
	"testing"

	"raft.local/server-go/tests/testkit"
)

// Reproduce the UI regression through the real mux: a fresh workspace lists
// implicit channels as joined, so neither user ever calls POST /join. Sending
// must work without fabricated roster rows, including after an HTTP replay.
func TestFreshWorkspaceSystemChannelsCanPostWithoutJoining(t *testing.T) {
	e := testkit.NewTestEnv(t)
	_, owner, _ := e.FullAccount("system-owner@example.test", "systemowner")
	memberID, member, _ := e.FullAccount("system-member@example.test", "systemmember")
	_, outsider, _ := e.FullAccount("system-outsider@example.test", "systemoutsider")
	ws := e.CreateServer(t, owner, "System channels", "system-posting")
	e.AddMember(t, ws, memberID, "member")

	listed := e.Serve(http.MethodGet, "/api/channels", nil, testkit.Scoped(member, ws))
	if listed.Status != http.StatusOK {
		t.Fatalf("list: %d %s", listed.Status, listed.Raw)
	}
	var channels []struct {
		ID     string `json:"id"`
		Name   string `json:"name"`
		Joined bool   `json:"joined"`
	}
	if err := json.Unmarshal(listed.Raw, &channels); err != nil {
		t.Fatal(err)
	}
	found := map[string]bool{}
	for _, ch := range channels {
		if ch.Name != "all" && ch.Name != "announcement" {
			continue
		}
		found[ch.Name] = true
		if !ch.Joined {
			t.Fatalf("system channel must remain implicitly joined: %+v", ch)
		}
		for _, actor := range []struct{ name, token string }{{"owner", owner}, {"member", member}} {
			body := map[string]any{"channelId": ch.ID, "content": actor.name + " in " + ch.Name, "randomId": actor.name + "-" + ch.ID}
			sent := e.Serve(http.MethodPost, "/api/messages", body, testkit.Scoped(actor.token, ws))
			if sent.Status != http.StatusCreated && sent.Status != http.StatusOK {
				t.Fatalf("%s post to #%s: %d %s", actor.name, ch.Name, sent.Status, sent.Raw)
			}
			replayed := e.Serve(http.MethodPost, "/api/messages", body, testkit.Scoped(actor.token, ws))
			if replayed.Status != http.StatusOK || replayed.Body["id"] != sent.Body["id"] {
				t.Fatalf("system-channel retry must replay one message: %d %s; first %s", replayed.Status, replayed.Raw, sent.Raw)
			}
		}
		var roster, messages int
		if err := e.App.DB.QueryRow(`SELECT COUNT(*) FROM channel_humans WHERE channel_id = ?`, ch.ID).Scan(&roster); err != nil || roster != 0 {
			t.Fatalf("must not synthesize roster rows: count=%d err=%v", roster, err)
		}
		if err := e.App.DB.QueryRow(`SELECT COUNT(*) FROM messages WHERE channel_id = ? AND message_type = 'chat'`, ch.ID).Scan(&messages); err != nil || messages != 2 {
			t.Fatalf("two actors, no replay duplicates: count=%d err=%v", messages, err)
		}
		denied := e.Serve(http.MethodPost, "/api/messages", map[string]any{"channelId": ch.ID, "content": "not a workspace member"}, testkit.Scoped(outsider, ws))
		if denied.Status != http.StatusForbidden {
			t.Fatalf("implicit membership must not admit outsiders: %d %s", denied.Status, denied.Raw)
		}
		if _, err := e.App.DB.Exec(`UPDATE channels SET archived_at = 1 WHERE id = ?`, ch.ID); err != nil {
			t.Fatal(err)
		}
		archived := e.Serve(http.MethodPost, "/api/messages", map[string]any{"channelId": ch.ID, "content": "archived"}, testkit.Scoped(member, ws))
		if archived.Status != http.StatusConflict {
			t.Fatalf("archive guard: %d %s", archived.Status, archived.Raw)
		}
	}
	if !found["all"] || !found["announcement"] {
		t.Fatalf("fresh workspace must exercise both default channels, found=%v, response=%s", found, listed.Raw)
	}
}
