package mail_test

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"testing"

	"raft.local/server-go/internal/platform/mail"
)

func TestExistingOutboxIsPrivateAndCancelledSendWritesNothing(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "outbox")
	if err := os.Mkdir(dir, 0755); err != nil {
		t.Fatal(err)
	}
	mailer, err := mail.NewOutboxMailer(dir)
	if err != nil {
		t.Fatal(err)
	}
	info, err := os.Stat(dir)
	if err != nil {
		t.Fatal(err)
	}
	if runtime.GOOS != "windows" && info.Mode().Perm() != 0700 {
		t.Error("existing outbox directory must be private")
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if err := mailer.Send(ctx, mail.Message{To: "test@example.test", Token: "private-test-token"}); !errors.Is(err, context.Canceled) {
		t.Errorf("cancelled send result: %v", err)
	}
	files, err := os.ReadDir(dir)
	if err != nil || len(files) != 0 {
		t.Fatal("cancelled send wrote a mailbox entry")
	}
}
