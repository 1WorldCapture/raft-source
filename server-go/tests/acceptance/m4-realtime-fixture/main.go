// m4-realtime-fixture is an explicitly TEST-ONLY, in-process bulk message
// seeder for the M4 realtime acceptance suite (tests/acceptance/m4-
// realtime.mjs). It exists because the frozen production send path shares
// one 60-writes/60s rate bucket per user: seeding the >500-message
// recovery corpus over HTTP would take twenty minutes or require disabling
// a production limit, and neither is acceptable.
//
// It inserts through the REAL domain fact/publication primitives inside
// platform/db.WithWriteTx — so every row carries the full record/source
// metadata, transaction-allocated seq, request digest and the SAME-commit
// realtime_publications outbox intents a production write produces. It
// never speaks HTTP, never disables anything, touches only the disposable
// acceptance data directory handed to it, and prints only counts (no
// bodies, no credentials).
//
// Usage (single JSON object on stdout; exit 0 on success):
//
//	m4-realtime-fixture -db <data>/raft.db -workspace <id> -channel <id> \
//	    -user <uuid> [-count 1200] [-prefix bulk] [-cjk-units 0] [-batch 25]
//
// The server may be running (WAL) or stopped; the suite stops it for the
// big seed to avoid write contention.
package main

import (
	"context"
	"database/sql"
	"encoding/json"
	"flag"
	"fmt"
	"log"
	"time"

	"raft.local/server-go/internal/auth"
	"raft.local/server-go/internal/channel"
	"raft.local/server-go/internal/message"
	"raft.local/server-go/internal/platform/clock"
	platformdb "raft.local/server-go/internal/platform/db"
)

func main() {
	dbPath := flag.String("db", "", "path to the disposable raft.db")
	workspace := flag.String("workspace", "", "workspace id the channel belongs to")
	channelID := flag.String("channel", "", "existing channel id inside the workspace")
	user := flag.String("user", "", "sender user id (a real, verified, profile-complete account)")
	count := flag.Int("count", 0, "number of bulk messages")
	prefix := flag.String("prefix", "m4bulk", "content prefix; content is '<prefix> <index>'")
	cjkUnits := flag.Int("cjk-units", 0, "additionally insert one long CJK message of this many UTF-16 units")
	batch := flag.Int("batch", 25, "message fact writes per transaction")
	waitPublished := flag.Bool("wait-published", false, "read-only: wait until this channel's message publications are processed")
	flag.Parse()
	if *dbPath == "" || *workspace == "" || *channelID == "" {
		log.Fatal("fixture: -db, -workspace and -channel are required")
	}
	if !*waitPublished && (*user == "" || (*count <= 0 && *cjkUnits <= 0) || *batch <= 0) {
		log.Fatal("fixture: seeding requires -user, one of -count/-cjk-units, and a positive -batch")
	}

	handle, err := platformdb.Open(*dbPath)
	if err != nil {
		log.Fatalf("fixture: open db: %v", err)
	}
	defer func() {
		_ = handle.Close()
		platformdb.ReleaseAuthorityFence(handle)
	}()

	if *waitPublished {
		// Isolate backlog replay from the byte-budget recovery test without
		// disabling the publisher or marking any intent published ourselves.
		// No writes, credentials, message bodies or production endpoints.
		ctx, cancel := context.WithTimeout(context.Background(), 45*time.Second)
		defer cancel()
		if err := waitForMessagePublications(ctx, handle, *workspace, *channelID); err != nil {
			log.Fatalf("fixture: publication drain: %v", err)
		}
		fmt.Println(`{"pendingMessages":0}`)
		return
	}

	// Claims for the REAL ValidateHumanTx predicate: an unrevoked family of
	// the given verified user. Values are evidence-shaped (the predicate
	// checks the family row, not a signature — the signer is not involved
	// in transactional revalidation by design).
	var familyID string
	ctx := context.Background()
	err = handle.QueryRowContext(ctx, `SELECT f.id FROM session_families f
		JOIN users u ON u.id = f.user_id
		WHERE f.user_id = ? AND f.revoked_at IS NULL AND u.email_verified = 1
		ORDER BY f.created_at LIMIT 1`, *user).Scan(&familyID)
	if err != nil {
		log.Fatalf("fixture: no unrevoked verified family for user: %v", err)
	}
	now := time.Now()
	claims := auth.AccessTokenClaims{
		Subject: *user, Type: "access", FamilyID: familyID,
		IssuedAt: now.Add(-time.Minute), ExpiresAt: now.Add(24 * time.Hour),
	}

	channels := channel.NewStoreWithOptions(handle, channel.Options{Clock: clock.Real{}})
	messages := message.NewStore(handle, channels)
	// This private fixture deliberately seeds domain facts in large batches.
	// Keep its bundled helper here, not as a second production send entry.
	// Real human sends use application/messaging.SendHuman, including reads.
	seedMessageTx := func(tx *sql.Tx, input message.CreateInput) (*message.CreateResult, error) {
		created, err := messages.CreateMessageTx(ctx, tx, claims, *workspace, input)
		if err != nil {
			return nil, err
		}
		if err := messages.RecordSendPublicationsTx(ctx, tx, *workspace, created); err != nil {
			return nil, err
		}
		return created, nil
	}

	var firstSeq, lastSeq int64
	inserted := 0
	insert := func(content string, randomID string) error {
		return platformdb.WithWriteTx(ctx, handle, func(tx *sql.Tx) error {
			rid := randomID
			res, err := seedMessageTx(tx, message.CreateInput{
				ChannelID: *channelID, Content: content, RandomID: &rid,
			})
			if err != nil {
				return err
			}
			if firstSeq == 0 || res.Message.Seq < firstSeq {
				firstSeq = res.Message.Seq
			}
			if res.Message.Seq > lastSeq {
				lastSeq = res.Message.Seq
			}
			inserted++
			return nil
		})
	}

	// Optional single long CJK message first (recovery must deliver its
	// full bytes without an endless reconnect loop).
	if *cjkUnits > 0 {
		if err := insert(cjkLine(*cjkUnits), fmt.Sprintf("m4fixture-cjk-%d", now.UnixNano())); err != nil {
			log.Fatalf("fixture: long cjk insert: %v", err)
		}
	}

	for done := 0; done < *count; {
		n := *count - done
		if n > *batch {
			n = *batch
		}
		err := platformdb.WithWriteTx(ctx, handle, func(tx *sql.Tx) error {
			for i := 0; i < n; i++ {
				rid := fmt.Sprintf("m4fixture-%d-%d", now.UnixNano(), done+i)
				content := fmt.Sprintf("%s %d", *prefix, done+i)
				res, err := seedMessageTx(tx, message.CreateInput{
					ChannelID: *channelID, Content: content, RandomID: &rid,
				})
				if err != nil {
					return err
				}
				if firstSeq == 0 || res.Message.Seq < firstSeq {
					firstSeq = res.Message.Seq
				}
				if res.Message.Seq > lastSeq {
					lastSeq = res.Message.Seq
				}
				inserted++
			}
			return nil
		})
		if err != nil {
			log.Fatalf("fixture: bulk batch at %d: %v", done, err)
		}
		done += n
	}

	out, _ := json.Marshal(map[string]any{
		"inserted": inserted, "firstSeq": firstSeq, "lastSeq": lastSeq,
		"workspace": *workspace, "channel": *channelID,
	})
	fmt.Println(string(out))
}

func waitForMessagePublications(ctx context.Context, handle *sql.DB, workspaceID, channelID string) error {
	ticker := time.NewTicker(50 * time.Millisecond)
	defer ticker.Stop()
	for {
		var pending int
		if err := handle.QueryRowContext(ctx, `SELECT COUNT(*) FROM realtime_publications
			WHERE workspace_id = ? AND scope_id = ? AND object_type = 'message' AND published_at IS NULL`,
			workspaceID, channelID).Scan(&pending); err != nil {
			return err
		}
		if pending == 0 {
			return nil
		}
		select {
		case <-ctx.Done():
			return fmt.Errorf("%d message publications still pending: %w", pending, ctx.Err())
		case <-ticker.C:
		}
	}
}

// cjkLine builds a CJK body of exactly n UTF-16 code units (BMP characters:
// one unit each). A 32000-unit body is 96000 UTF-8 bytes — the exact worst
// case the byte-budget resume path must survive.
func cjkLine(n int) string {
	runes := make([]rune, n)
	for i := range runes {
		runes[i] = '界'
	}
	return string(runes)
}
