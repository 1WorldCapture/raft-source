package httpapi_test

import (
	"context"
	"net/http"
	"net/http/httptest"
	"raft.local/server-go/tests/testkit"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"
)

// The gateway and the Engine.IO upgrader must use the same configured
// origin policy: the Web origin commonly differs from the backend Host.
func TestM4SocketIOConfiguredOriginSurvivesEngineUpgrade(t *testing.T) {
	env := testkit.NewTestEnv(t)
	server := httptest.NewServer(env.App.Handler)
	defer server.Close()
	for _, tc := range []struct {
		name   string
		origin string
		status int
	}{
		{"configured web origin", "http://127.0.0.1:5175", http.StatusSwitchingProtocols},
		{"non-browser client", "", http.StatusSwitchingProtocols},
		{"foreign origin", "http://evil.example", http.StatusForbidden},
		{"forged suffix", "http://127.0.0.1:5175.evil.example", http.StatusForbidden},
	} {
		t.Run(tc.name, func(t *testing.T) {
			ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			defer cancel()
			header := http.Header{}
			if tc.origin != "" {
				header.Set("Origin", tc.origin)
			}
			conn, resp, err := websocket.Dial(ctx,
				"ws"+strings.TrimPrefix(server.URL, "http")+"/socket.io/?EIO=4&transport=websocket",
				&websocket.DialOptions{HTTPHeader: header})
			if conn != nil {
				defer conn.CloseNow()
			}
			if resp == nil || resp.StatusCode != tc.status {
				t.Fatalf("origin policy returned unexpected status, want %d: %v", tc.status, err)
			}
			if tc.status != http.StatusSwitchingProtocols {
				if err == nil || conn != nil {
					t.Fatal("rejected origin established a transport")
				}
				return
			}
			if err != nil {
				t.Fatalf("configured origin rejected by inner Engine.IO upgrader: %v", err)
			}
			kind, packet, err := conn.Read(ctx)
			if err != nil || kind != websocket.MessageText || !strings.HasPrefix(string(packet), "0{") {
				t.Fatalf("allowed origin did not receive Engine.IO open: %v", err)
			}
		})
	}
}
