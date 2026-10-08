package message

import (
	"bufio"
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"strings"
	"testing"
	"time"

	"raft.local/server-go/internal/channel"
	"raft.local/server-go/internal/platform/clock"
	"raft.local/server-go/internal/platform/db"
	"raft.local/server-go/internal/realtime"
)

const crashNoticePrefix = "RAFT_M4_CRASH_READY "

// Only stable, non-secret references cross the child-process barrier.
type crashNotice struct {
	MessageID     string `json:"messageId"`
	MessageSeq    int64  `json:"messageSeq"`
	PublicationID int64  `json:"publicationId"`
}

func crashInput() CreateInput {
	return CreateInput{ChannelID: txGeneral, Content: "durable crash fixture", RandomID: stringPtr("m4-crash-idempotency")}
}

// TestM4CrashProcessHelper runs only in a subprocess pointed at a database
// created by the parent test. No server listener, app runtime, live directory
// or production identity is involved. The parent KILLS (not shuts down) this
// process after a deterministic commit/publication barrier.
func TestM4CrashProcessHelper(t *testing.T) {
	mode := os.Getenv("RAFT_M4_CRASH_TEST_MODE")
	if mode == "" {
		return
	}
	path := os.Getenv("RAFT_M4_CRASH_TEST_DATABASE")
	if path == "" {
		t.Fatal("missing disposable crash-test database")
	}
	handle, err := db.Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer handle.Close()
	fixed := &clock.Fixed{T: time.Date(2026, 10, 8, 12, 0, 0, 0, time.UTC)}
	channels := channel.NewStoreWithOptions(handle, channel.Options{Clock: fixed})
	store := NewStoreWithOptionsForTest(handle, channels, fixed)
	ctx := context.Background()
	claims := claimsFor(txAlice, txFamAlice)
	barrier := func(result *CreateResult, publicationID int64) {
		body, err := json.Marshal(crashNotice{result.Message.ID, result.Message.Seq, publicationID})
		if err != nil {
			t.Fatal(err)
		}
		if _, err := fmt.Fprintln(os.Stdout, crashNoticePrefix+string(body)); err != nil {
			t.Fatal(err)
		}
		// The independent test timeout is a safety net; under normal
		// execution the parent forcefully terminates us at this barrier.
		time.Sleep(time.Minute)
		t.Fatal("crash-test parent did not terminate the helper")
	}
	if mode == "pre-commit" {
		err := db.WithWriteTx(ctx, handle, func(tx *sql.Tx) error {
			created, err := store.CreateTx(ctx, tx, claims, txWS, crashInput())
			if err == nil {
				barrier(created, 0)
			}
			return err
		})
		t.Fatalf("pre-commit barrier unexpectedly returned: %v", err)
	}
	created, err := store.Create(ctx, claims, txWS, crashInput())
	if err != nil {
		t.Fatal(err)
	}
	if mode == "post-commit" {
		barrier(created, 0)
	}
	if mode != "post-publish" {
		t.Fatalf("unknown crash mode %q", mode)
	}
	_, err = realtime.NewStore(handle).DrainOnce(ctx, func(_ context.Context, ref realtime.Publication) error {
		// Simulate transport accepting the reference, then stop BEFORE
		// returning to DrainOnce's durable published_at transaction.
		barrier(created, ref.ID)
		return nil
	})
	t.Fatalf("post-publish barrier unexpectedly returned: %v", err)
}

func killAtCrashBarrier(t *testing.T, mode, path string) crashNotice {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, os.Args[0], "-test.run=^TestM4CrashProcessHelper$", "-test.timeout=25s")
	cmd.Env = append(os.Environ(), "RAFT_M4_CRASH_TEST_MODE="+mode, "RAFT_M4_CRASH_TEST_DATABASE="+path)
	cmd.Stderr = os.Stderr
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		t.Fatal(err)
	}
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	defer func() {
		if cmd.ProcessState == nil {
			_ = cmd.Process.Kill()
			_ = cmd.Wait()
		}
	}()
	notices := make(chan crashNotice, 1)
	failures := make(chan error, 1)
	go func() {
		scanner := bufio.NewScanner(stdout)
		for scanner.Scan() {
			body, ok := strings.CutPrefix(scanner.Text(), crashNoticePrefix)
			if !ok {
				continue
			}
			var notice crashNotice
			if err := json.Unmarshal([]byte(body), &notice); err != nil {
				failures <- err
				return
			}
			notices <- notice
			return
		}
		failures <- fmt.Errorf("helper exited before the crash barrier: %v", scanner.Err())
	}()
	var notice crashNotice
	select {
	case notice = <-notices:
	case err := <-failures:
		t.Fatal(err)
	case <-ctx.Done():
		t.Fatal("crash helper did not reach its bounded barrier")
	}
	if notice.MessageID == "" || notice.MessageSeq < 1 {
		t.Fatalf("invalid crash notice: %+v", notice)
	}
	if err := cmd.Process.Kill(); err != nil {
		t.Fatal(err)
	}
	if err := cmd.Wait(); err == nil {
		t.Fatal("helper exited normally instead of being forcefully terminated")
	}
	if ctx.Err() != nil {
		t.Fatal("helper termination was a timeout, not the requested fault injection")
	}
	return notice
}

func TestM4RealProcessCrashPreservesAtomicFactsAndPublicationReplay(t *testing.T) {
	for _, mode := range []string{"pre-commit", "post-commit", "post-publish"} {
		t.Run(mode, func(t *testing.T) {
			f := newFixture(t)
			f.seed()
			f.seedChannel(txGeneral, "general", channel.TypeChannel, txAlice)
			var databaseIndex int
			var databaseName, databasePath string
			if err := f.db.QueryRow(`PRAGMA database_list`).Scan(&databaseIndex, &databaseName, &databasePath); err != nil {
				t.Fatal(err)
			}
			if err := f.db.Close(); err != nil {
				t.Fatal(err)
			}
			db.ReleaseAuthorityFence(f.db)
			notice := killAtCrashBarrier(t, mode, databasePath)
			handle, err := db.Open(databasePath)
			if err != nil {
				t.Fatal(err)
			}
			t.Cleanup(func() {
				_ = handle.Close()
				db.ReleaseAuthorityFence(handle)
			})
			f.db = handle
			f.channels = channel.NewStoreWithOptions(handle, channel.Options{Clock: f.clock})
			f.store = NewStoreWithOptionsForTest(handle, f.channels, f.clock)
			var integrity string
			if err := handle.QueryRow(`PRAGMA integrity_check`).Scan(&integrity); err != nil || integrity != "ok" {
				t.Fatalf("post-crash integrity: %q, %v", integrity, err)
			}
			var messageCount, pending, processed int
			if err := handle.QueryRow(`SELECT COUNT(*) FROM messages`).Scan(&messageCount); err != nil {
				t.Fatal(err)
			}
			if err := handle.QueryRow(`SELECT COUNT(*) FROM realtime_publications WHERE published_at IS NULL`).Scan(&pending); err != nil {
				t.Fatal(err)
			}
			if err := handle.QueryRow(`SELECT COUNT(*) FROM realtime_publications WHERE published_at IS NOT NULL`).Scan(&processed); err != nil {
				t.Fatal(err)
			}
			committed := mode != "pre-commit"
			if !committed && (messageCount != 0 || pending != 0 || processed != 0) {
				t.Fatalf("uncommitted fact/intent survived: messages=%d pending=%d processed=%d", messageCount, pending, processed)
			}
			if committed && (messageCount != 1 || pending == 0 || processed != 0) {
				t.Fatalf("committed fact/intent lost or prematurely marked: messages=%d pending=%d processed=%d", messageCount, pending, processed)
			}
			retry, err := f.store.Create(context.Background(), claimsFor(txAlice, txFamAlice), txWS, crashInput())
			if err != nil {
				t.Fatal(err)
			}
			if retry.Replayed != committed {
				t.Fatalf("retry replay=%v, want %v", retry.Replayed, committed)
			}
			if committed && (retry.Message.ID != notice.MessageID || retry.Message.Seq != notice.MessageSeq) {
				t.Fatalf("retry changed committed identity/seq: %+v vs %+v", retry.Message, notice)
			}
			if err := handle.QueryRow(`SELECT COUNT(*) FROM messages`).Scan(&messageCount); err != nil || messageCount != 1 {
				t.Fatalf("retry must leave exactly one message: %d, %v", messageCount, err)
			}
			if committed {
				var afterRetry int
				if err := handle.QueryRow(`SELECT COUNT(*) FROM realtime_publications`).Scan(&afterRetry); err != nil || afterRetry != pending {
					t.Fatalf("idempotent retry duplicated publication intents: %d vs %d, %v", afterRetry, pending, err)
				}
			}
			seen := map[int64]bool{}
			publications := realtime.NewStore(handle)
			if _, err := publications.DrainOnce(context.Background(), func(_ context.Context, ref realtime.Publication) error {
				seen[ref.ID] = true
				return nil
			}); err != nil {
				t.Fatal(err)
			}
			if mode == "post-publish" && !seen[notice.PublicationID] {
				t.Fatalf("accepted-but-unmarked publication %d was not replayed", notice.PublicationID)
			}
			if len(seen) == 0 {
				t.Fatal("restarted publisher found no durable intents")
			}
			if _, err := publications.DrainOnce(context.Background(), func(context.Context, realtime.Publication) error {
				t.Error("durably marked publication replayed again")
				return nil
			}); err != nil {
				t.Fatal(err)
			}
		})
	}
}
