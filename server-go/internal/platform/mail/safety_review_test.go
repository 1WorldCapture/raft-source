package mail_test

import (
	"context"
	"net"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"testing"
	"time"

	mail "raft.local/server-go/internal/platform/mail"
)

func TestReviewOutboxRoundTripPreservesEscapedLinks(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "private-mail")
	m, err := mail.NewOutboxMailer(dir)
	if err != nil {
		t.Fatal(err)
	}
	msg := mail.Message{From: "Raft <no-reply@example.test>", To: "test@example.test", Subject: `Verify "SQLite" 中文`, HTML: `<a href="http://127.0.0.1:5175/?verify=test-only-token">Verify "中文"</a>`, Text: "line one\nline two\\path"}
	if err := m.Send(context.Background(), msg); err != nil {
		t.Fatal(err)
	}
	entries, err := mail.ReadOutbox(dir, 10)
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 1 {
		t.Fatalf("outbox count = %d", len(entries))
	}
	got := entries[0]
	if got.From != msg.From || got.To != msg.To || got.Subject != msg.Subject || got.HTML != msg.HTML || got.Text != msg.Text {
		t.Fatal("mailbox must preserve strings and escaped HTML exactly")
	}
	links := got.Links()
	if len(links) != 1 || links[0] != "http://127.0.0.1:5175/?verify=test-only-token" {
		t.Fatal("CLI must recover usable verification links")
	}
	info, err := os.Stat(filepath.Join(dir, got.File))
	if err != nil {
		t.Fatal(err)
	}
	if runtime.GOOS != "windows" && info.Mode().Perm()&0o077 != 0 {
		t.Fatal("token-bearing mail must be mode 0600")
	}
}

func TestReviewSMTPHonorsCancellationDuringGreeting(t *testing.T) {
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer l.Close()
	done := make(chan struct{})
	go func() {
		defer close(done)
		c, err := l.Accept()
		if err != nil {
			return
		}
		defer c.Close()
		// A malicious/broken SMTP server accepts TCP but never sends its greeting.
		_ = c.SetReadDeadline(time.Now().Add(2 * time.Second))
		var b [1]byte
		_, _ = c.Read(b[:])
	}()
	host, portText, _ := net.SplitHostPort(l.Addr().String())
	port, _ := strconv.Atoi(portText)
	m := mail.NewSMTPMailer(host, port, "", "")
	ctx, cancel := context.WithTimeout(context.Background(), 120*time.Millisecond)
	defer cancel()
	start := time.Now()
	if err := m.Send(ctx, mail.Message{From: "a@example.test", To: "b@example.test", Text: "test"}); err == nil {
		t.Fatal("silent SMTP server must not succeed")
	}
	if time.Since(start) > time.Second {
		t.Fatal("SMTP did not honor request cancellation")
	}
	<-done
}
