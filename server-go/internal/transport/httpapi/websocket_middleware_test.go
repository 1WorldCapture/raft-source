package httpapi_test

import (
	"bytes"
	"context"
	"fmt"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"
	"raft.local/server-go/internal/transport/httpapi/httpx"
)

func TestM3WebSocketUpgradeSurvivesLoggingAndSecurityMiddleware(t *testing.T) {
	var logs bytes.Buffer
	logger := slog.New(slog.NewJSONHandler(&logs, nil))
	result := make(chan error, 1)
	logged := make(chan struct{})
	mux := http.NewServeMux()
	mux.HandleFunc("GET /daemon/connect", func(w http.ResponseWriter, r *http.Request) {
		conn, err := websocket.Accept(w, r, nil)
		if err != nil {
			result <- err
			return
		}
		defer conn.CloseNow()
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		kind, data, err := conn.Read(ctx)
		if err == nil && (kind != websocket.MessageText || string(data) != "hello") {
			err = fmt.Errorf("unexpected wire message")
		}
		if err == nil {
			err = conn.Write(ctx, websocket.MessageText, []byte("ready"))
		}
		result <- err
	})
	chain := httpx.RequestID(logger)(httpx.SecurityHeaders(mux))
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		defer close(logged)
		chain.ServeHTTP(w, r)
	}))
	defer server.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	conn, rec, err := websocket.Dial(ctx, "ws"+strings.TrimPrefix(server.URL, "http")+"/daemon/connect?key=sk_computer_do_not_log", nil)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.CloseNow()
	if rec.StatusCode != http.StatusSwitchingProtocols || rec.Header.Get("X-Request-Id") == "" {
		t.Fatal("upgrade lost the real handshake or request metadata")
	}
	if err := conn.Write(ctx, websocket.MessageText, []byte("hello")); err != nil {
		t.Fatal(err)
	}
	_, reply, err := conn.Read(ctx)
	if err != nil || string(reply) != "ready" {
		t.Fatalf("wire reply failed: %v", err)
	}
	select {
	case err := <-result:
		if err != nil {
			t.Fatal(err)
		}
	case <-ctx.Done():
		t.Fatal("handler did not finish")
	}
	select {
	case <-logged:
	case <-ctx.Done():
		t.Fatal("request logger did not finish")
	}
	if strings.Contains(logs.String(), "do_not_log") || strings.Contains(logs.String(), "?key=") {
		t.Fatal("query-form machine credential leaked to request log")
	}
	if !strings.Contains(logs.String(), `"status":101`) || !strings.Contains(logs.String(), `"route":"GET /daemon/connect"`) {
		t.Fatalf("missing upgrade status/template in log: %s", logs.String())
	}
}
