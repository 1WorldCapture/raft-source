package legacyweb_test

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"
)

// Exercise the production Socket.IO binding THROUGH the application's HTTP
// middleware, not just the gateway or an unwrapped standalone spike. Gorilla
// (used by Engine.IO) requires http.Hijacker directly; Unwrap alone is not
// sufficient even though the M3 machine WebSocket client supports it.
func TestM4SocketIOUpgradeReachesNamespaceAuthentication(t *testing.T) {
	env := newTestEnv(t)
	server := httptest.NewServer(env.app.Handler)
	defer server.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	url := "ws" + strings.TrimPrefix(server.URL, "http") + "/socket.io/?EIO=4&transport=websocket"
	conn, response, err := websocket.Dial(ctx, url, nil)
	if err != nil {
		t.Fatalf("production Socket.IO upgrade failed: %v", err)
	}
	defer conn.CloseNow()
	if response.StatusCode != http.StatusSwitchingProtocols || response.Header.Get("X-Request-Id") == "" {
		t.Fatal("Socket.IO upgrade lost the handshake or request metadata")
	}
	kind, open, err := conn.Read(ctx)
	if err != nil || kind != websocket.MessageText || !strings.HasPrefix(string(open), "0{") {
		t.Fatalf("Engine.IO open packet not received: %v", err)
	}
	// EIO MESSAGE (4), Socket.IO CONNECT (0), empty auth object. The
	// namespace must reject this explicitly instead of a transport 500.
	if err := conn.Write(ctx, websocket.MessageText, []byte(`40{}`)); err != nil {
		t.Fatal(err)
	}
	kind, rejected, err := conn.Read(ctx)
	if err != nil || kind != websocket.MessageText || !strings.HasPrefix(string(rejected), "44{") {
		t.Fatalf("Socket.IO CONNECT_ERROR not received: %v", err)
	}
	var body struct {
		Message string `json:"message"`
	}
	if err := json.Unmarshal(rejected[2:], &body); err != nil {
		t.Fatal(err)
	}
	if body.Message != "Authentication required" {
		t.Fatalf("namespace rejection = %q, want Authentication required", body.Message)
	}
}
