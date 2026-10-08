package machinews

import (
	"context"
	"errors"
	"net/http"
	"strings"
	"testing"

	"github.com/coder/websocket"

	"raft.local/server-go/internal/computer"
)

// denyAuthenticator replays a fixed decision; used only to exercise the
// 401/500 mapping and header bytes. Success-path tests always use the real
// computer.Store.
type denyAuthenticator struct {
	err error
}

func (a denyAuthenticator) Authenticate(ctx context.Context, key string) (computer.Principal, error) {
	return computer.Principal{}, a.err
}

func (a denyAuthenticator) ValidatePrincipal(context.Context, computer.Principal) error {
	if a.err != nil {
		return a.err
	}
	return errors.New("machinews test: principal revalidation unavailable")
}

func httpDo(t *testing.T, env *testEnv, apiKey, origin string) *http.Response {
	t.Helper()
	req, err := http.NewRequest(http.MethodGet, baseURL+ConnectPath, nil)
	if err != nil {
		t.Fatal(err)
	}
	if apiKey != "" {
		req.Header.Set("Authorization", "Bearer "+apiKey)
	}
	if origin != "" {
		req.Header.Set("Origin", origin)
	}
	resp, err := env.client.Do(req)
	if err != nil {
		t.Fatalf("plain GET: %v", err)
	}
	t.Cleanup(func() { _ = resp.Body.Close() })
	return resp
}

func TestHandshakeReasonMatrix(t *testing.T) {
	env := newTestEnv(t, nil)
	env.seedUser("u1")
	env.seedWorkspace("w1", "alpha", "u1")
	env.seedMembership("w1", "u1", "owner")
	machineID, legacyKey := env.seedLegacyMachine("w1", "u1", "legacy-one")

	cases := []struct {
		name       string
		apiKey     string
		wantStatus int
		wantReason string // "" = header absent
	}{
		{name: "missing key", apiKey: "", wantStatus: 401, wantReason: computer.ReasonMissingKey},
		{name: "invalid format", apiKey: "whargarble", wantStatus: 401, wantReason: computer.ReasonInvalidKeyFormat},
		{name: "unknown machine key", apiKey: "sk_machine_" + strings.Repeat("ab", 32), wantStatus: 401, wantReason: computer.ReasonMachineKeyInvalid},
		{name: "unknown computer key", apiKey: "sk_computer_" + strings.Repeat("cd", 32), wantStatus: 401, wantReason: computer.ReasonComputerNotFound},
		{name: "migrated legacy key", apiKey: legacyKey, wantStatus: 401, wantReason: computer.ReasonLegacyKeyMigrated},
	}
	// Mark the legacy key migrated for the last case.
	mustExec(t, env.db, `UPDATE machines SET legacy_key_migrated_at = ? WHERE id = ?`,
		env.clock.Now().UnixMilli(), machineID)

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			resp := httpDo(t, env, tc.apiKey, "")
			if resp.StatusCode != tc.wantStatus {
				t.Fatalf("status = %d, want %d", resp.StatusCode, tc.wantStatus)
			}
			if got := resp.Header.Get("Slock-Reason"); got != tc.wantReason {
				t.Fatalf("Slock-Reason = %q, want %q", got, tc.wantReason)
			}
			// The deny must never leak the credential.
			body := make([]byte, 512)
			n, _ := resp.Body.Read(body)
			if strings.Contains(string(body[:n]), tc.apiKey) && tc.apiKey != "" {
				t.Fatal("deny body echoed the api key")
			}
		})
	}
}

func TestHandshakeInfrastructureFailureIs500(t *testing.T) {
	env := newTestEnv(t, func(cfg *Config) {
		cfg.Authenticator = denyAuthenticator{err: errors.New("disk exploded")}
	})
	resp := httpDo(t, env, "sk_computer_whatever", "")
	if resp.StatusCode != http.StatusInternalServerError {
		t.Fatalf("status = %d, want 500", resp.StatusCode)
	}
	if got := resp.Header.Get("Slock-Reason"); got != "" {
		t.Fatalf("Slock-Reason = %q, want absent for infrastructure failure", got)
	}
}

func TestHandshakeRevokedComputerDenied(t *testing.T) {
	env := newTestEnv(t, nil)
	env.seedUser("u1")
	env.seedWorkspace("w1", "alpha", "u1")
	env.seedMembership("w1", "u1", "owner")
	computerID, _, apiKey := env.seedComputer("u1", "alpha", "Maria-laptop")
	ctx, cancel := context.WithTimeout(context.Background(), dialWait)
	defer cancel()
	if err := env.store.RevokeComputer(ctx, computerID, "u1", "rotated"); err != nil {
		t.Fatalf("revoke: %v", err)
	}
	resp := httpDo(t, env, apiKey, "")
	if resp.StatusCode != http.StatusUnauthorized {
		t.Fatalf("status = %d, want 401", resp.StatusCode)
	}
	if got := resp.Header.Get("Slock-Reason"); got != computer.ReasonComputerRevoked {
		t.Fatalf("Slock-Reason = %q, want %q", got, computer.ReasonComputerRevoked)
	}
}

func TestHandshakeSuccessMachineContextFirstFrame(t *testing.T) {
	env := newTestEnv(t, nil)
	env.seedUser("u1")
	env.seedWorkspace("w1", "alpha", "u1")
	env.seedMembership("w1", "u1", "owner")
	machineID, apiKey := env.seedLegacyMachine("w1", "u1", "legacy-one")

	ws := env.dial(apiKey)
	defer func() { _ = ws.Close(websocket.StatusNormalClosure, "") }()

	frame := readFrameExpect(t, ws, "machine:context")
	if frame["machineId"] != machineID {
		t.Fatalf("machineId = %v, want %q", frame["machineId"], machineID)
	}
	if frame["serverId"] != "w1" {
		t.Fatalf("serverId = %v, want w1", frame["serverId"])
	}
	// The context frame is written before publish, so online follows the read.
	env.waitCond("online after context", func() bool { return env.hub.IsOnline(machineID) })
	if got := env.hub.Status(machineID); got != "online" {
		t.Fatalf("Status = %q, want online", got)
	}
	// Registration records the online transition.
	env.waitCond("online transition", func() bool {
		row := env.machineRow(machineID)
		return row.lastStatus.Valid && row.lastStatus.String == "online"
	})
}

func TestHandshakeLegacyQueryKeyAccepted(t *testing.T) {
	env := newTestEnv(t, nil)
	env.seedUser("u1")
	env.seedWorkspace("w1", "alpha", "u1")
	env.seedMembership("w1", "u1", "owner")
	machineID, apiKey := env.seedLegacyMachine("w1", "u1", "legacy-two")

	ws := env.dialQuery(apiKey)
	defer func() { _ = ws.Close(websocket.StatusNormalClosure, "") }()
	frame := readFrameExpect(t, ws, "machine:context")
	if frame["machineId"] != machineID {
		t.Fatalf("machineId = %v, want %q", frame["machineId"], machineID)
	}
}

func TestHandshakeComputerPrincipalAccepted(t *testing.T) {
	env := newTestEnv(t, nil)
	env.seedUser("u1")
	env.seedWorkspace("w1", "alpha", "u1")
	env.seedMembership("w1", "u1", "owner")
	_, machineID, apiKey := env.seedComputer("u1", "alpha", "Maria-laptop")

	ws := env.dial(apiKey)
	defer func() { _ = ws.Close(websocket.StatusNormalClosure, "") }()
	frame := readFrameExpect(t, ws, "machine:context")
	if frame["machineId"] != machineID {
		t.Fatalf("machineId = %v, want %q", frame["machineId"], machineID)
	}
	if frame["serverId"] != "w1" {
		t.Fatalf("serverId = %v, want w1", frame["serverId"])
	}
}

func TestHandshakeWrongPath404(t *testing.T) {
	env := newTestEnv(t, nil)
	// The hub is mounted only at /daemon/connect by the mux; a request for
	// any other path must 404 rather than upgrade.
	req, err := http.NewRequest(http.MethodGet, baseURL+"/daemon/other", nil)
	if err != nil {
		t.Fatal(err)
	}
	resp2, err := env.client.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = resp2.Body.Close() }()
	if resp2.StatusCode != http.StatusNotFound {
		t.Fatalf("status = %d, want 404", resp2.StatusCode)
	}
}

func TestHandshakeBrowserOriginMismatchRejected(t *testing.T) {
	env := newTestEnv(t, nil)
	env.seedUser("u1")
	env.seedWorkspace("w1", "alpha", "u1")
	env.seedMembership("w1", "u1", "owner")
	_, apiKey := env.seedLegacyMachine("w1", "u1", "legacy-three")

	// A browser-shaped upgrade with a foreign Origin must not reach the
	// authenticated machine transport.
	req, err := http.NewRequest(http.MethodGet, baseURL+ConnectPath, nil)
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Authorization", "Bearer "+apiKey)
	req.Header.Set("Origin", "http://evil.example")
	req.Header.Set("Connection", "Upgrade")
	req.Header.Set("Upgrade", "websocket")
	req.Header.Set("Sec-WebSocket-Version", "13")
	req.Header.Set("Sec-WebSocket-Key", "dGhlIHNhbXBsZSBub25jZQ==")
	resp, err := env.client.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode != http.StatusForbidden {
		t.Fatalf("status = %d, want 403 for foreign Origin", resp.StatusCode)
	}
}

func TestHandshakeAfterCloseRefused(t *testing.T) {
	env := newTestEnv(t, nil)
	env.seedUser("u1")
	env.seedWorkspace("w1", "alpha", "u1")
	env.seedMembership("w1", "u1", "owner")
	_, apiKey := env.seedLegacyMachine("w1", "u1", "legacy-four")
	if err := env.hub.Close(); err != nil {
		t.Fatalf("close: %v", err)
	}
	resp := httpDo(t, env, apiKey, "")
	if resp.StatusCode != http.StatusServiceUnavailable {
		t.Fatalf("status = %d, want 503 after Close", resp.StatusCode)
	}
}

func TestNewHubValidatesConfig(t *testing.T) {
	if _, err := NewHub(Config{}); err == nil {
		t.Fatal("empty config must fail")
	}
	if _, err := NewHub(Config{DB: nil, Clock: nil, Authenticator: denyAuthenticator{}}); err == nil {
		t.Fatal("missing DB/Clock must fail")
	}
}
