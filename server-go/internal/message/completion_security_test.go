package message

import (
	"context"
	"database/sql"
	"errors"
	"testing"

	"raft.local/server-go/internal/channel"
	"raft.local/server-go/internal/platform/db"
)

// Empty streams and already-covered cursors must still authorize the current
// workspace. A successful empty resume must not disclose a foreign workspace's
// high-water mark or make a removed member indistinguishable from a subscriber.
func TestM4CompletionSyncRequiresWorkspaceBeforeEarlyReturns(t *testing.T) {
	for _, scenario := range []string{"empty", "populated", "already-covered", "deleted", "missing"} {
		t.Run(scenario, func(t *testing.T) {
			f := newFixture(t)
			f.seed()
			f.seedChannel(txGeneral, "general", channel.TypeChannel, txAlice, txBob)
			ctx := context.Background()
			workspaceID, since := txWS, int64(0)
			if scenario != "empty" && scenario != "missing" {
				f.sendMsg(t, txGeneral, "not a former member's activity")
			}
			if scenario == "already-covered" {
				since = 999
			}
			if scenario == "missing" {
				workspaceID = "ffffffff-ffff-4fff-8fff-ffffffffffff"
			} else if err := db.WithWriteTx(ctx, f.db, func(tx *sql.Tx) error {
				if scenario == "deleted" {
					_, err := tx.ExecContext(ctx, `UPDATE workspaces SET deleted_at=? WHERE id=?`, f.clock.Now().UnixMilli(), txWS)
					return err
				}
				_, err := tx.ExecContext(ctx, `DELETE FROM workspace_memberships WHERE workspace_id=? AND user_id=?`, txWS, txBob)
				return err
			}); err != nil {
				t.Fatal(err)
			}
			claims := NewClaims(claimsFor(txBob, txFamBob))
			for _, transport := range []string{"http", "visible", "resume"} {
				t.Run(transport, func(t *testing.T) {
					var err error
					switch transport {
					case "http":
						var result *SyncResult
						result, err = f.store.SyncHTTP(ctx, claims, workspaceID, since, "", 200)
						if result != nil {
							t.Errorf("unauthorized HTTP stream returned data: %+v", result)
						}
					case "visible":
						var result *SyncResult
						result, err = f.store.SyncVisibleMessages(ctx, claims, workspaceID, since, "", 200)
						if result != nil {
							t.Errorf("unauthorized stream returned coverage: %+v", result)
						}
					case "resume":
						var result *ResumeEnvelope
						result, err = f.store.ResumePage(ctx, claims, workspaceID, since, ResumeOptions{})
						if result != nil {
							t.Errorf("unauthorized resume returned a high-water mark: %+v", result)
						}
					}
					if !errors.Is(err, ErrNotServerMember) {
						t.Errorf("got %v, want ErrNotServerMember", err)
					}
				})
			}
		})
	}
}

// A malformed nested thread can retain a historical roster/follow row. The
// bulk subscription SQL must not grant what AuthorizeConversationTx denies:
// the original design rejects nested, cyclic and broken thread parent chains.
func TestM4CompletionSyncRejectsNestedThreadWithResidualRoster(t *testing.T) {
	f := newFixture(t)
	f.seed()
	f.seedChannel(txGeneral, "general", channel.TypeChannel, txAlice)
	ctx := context.Background()
	parents := f.seedConversation(t, txGeneral, 2)
	threadIDs := make([]string, 2)
	for i, parent := range parents {
		if err := db.WithWriteTx(ctx, f.db, func(tx *sql.Tx) error {
			thread, err := f.channels.EnsureThreadTx(ctx, tx, txWS, txGeneral, parent.ID, txAlice)
			if err == nil {
				threadIDs[i] = thread.ID
			}
			return err
		}); err != nil {
			t.Fatal(err)
		}
	}
	first := f.sendMsg(t, threadIDs[0], "legitimate first-level reply")
	nested := f.sendMsg(t, threadIDs[1], "must not stream through a broken parent chain")
	if err := db.WithWriteTx(ctx, f.db, func(tx *sql.Tx) error {
		if _, err := tx.ExecContext(ctx, `UPDATE channels SET parent_message_id=? WHERE id=?`, first.ID, threadIDs[1]); err != nil {
			return err
		}
		_, err := tx.ExecContext(ctx, `INSERT INTO channel_humans(channel_id,user_id,role,joined_at) VALUES(?,?,'member',?)`, threadIDs[0], txAlice, f.clock.Now().UnixMilli())
		return err
	}); err != nil {
		t.Fatal(err)
	}
	claims := NewClaims(claimsFor(txAlice, txFamAlice))
	if page, err := f.store.ListChannelPage(ctx, claims, txWS, threadIDs[1], PageQuery{Limit: 50}); err == nil || page != nil {
		t.Fatalf("history must deny the invalid chain: page=%+v err=%v", page, err)
	}
	for _, transport := range []string{"http", "visible", "resume"} {
		t.Run(transport, func(t *testing.T) {
			var dtos []*MessageDTO
			if transport == "resume" {
				result, err := f.store.ResumePage(ctx, claims, txWS, 0, ResumeOptions{})
				if err != nil {
					t.Fatal(err)
				}
				dtos = result.Messages
			} else {
				var result *SyncResult
				var err error
				if transport == "http" {
					result, err = f.store.SyncHTTP(ctx, claims, txWS, 0, "", 200)
				} else {
					result, err = f.store.SyncVisibleMessages(ctx, claims, txWS, 0, "", 200)
				}
				if err != nil {
					t.Fatal(err)
				}
				dtos = result.DTOs
			}
			foundLegitimate := false
			for _, dto := range dtos {
				if dto.ID == nested.ID {
					t.Errorf("nested-thread message bypassed the base content policy")
				}
				if dto.ID == first.ID {
					foundLegitimate = true
				}
			}
			if !foundLegitimate {
				t.Error("valid first-level thread was incorrectly excluded")
			}
		})
	}
}
