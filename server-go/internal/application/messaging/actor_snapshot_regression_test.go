package messaging_test

import (
	"context"
	"errors"
	"testing"
	"time"

	"raft.local/server-go/internal/auth"
)

func TestConversationUseCasesBindActorToAuthenticatedClaims(t *testing.T) {
	cases := []string{"list dms", "create dm", "create thread", "thread summaries", "thread info", "followed threads", "follow", "unfollow"}
	for _, operation := range cases {
		t.Run(operation, func(t *testing.T) {
			e := newAdvanceEnv(t)
			e.openThread()
			var parentID string
			if err := e.db.QueryRowContext(t.Context(), `SELECT parent_message_id FROM channels WHERE id=?`, e.threadID).Scan(&parentID); err != nil {
				t.Fatal(err)
			}
			if _, err := e.svc.FollowThread(t.Context(), e.claims("bob"), e.ws, "bob", parentID); err != nil {
				t.Fatalf("legitimate Bob follow failed: %v", err)
			}
			before := atomicDatabaseFacts(t, e.db)
			var err error
			switch operation {
			case "list dms":
				_, err = e.svc.ListDMs(t.Context(), e.claims("alice"), e.ws, "bob")
			case "create dm":
				_, err = e.svc.CreateDM(t.Context(), e.claims("alice"), e.ws, "bob", "alice", "", false, true)
			case "create thread":
				_, err = e.svc.CreateThread(t.Context(), e.claims("alice"), e.ws, "bob", e.generalID, parentID, false, "")
			case "thread summaries":
				_, err = e.svc.ThreadSummaries(t.Context(), e.claims("alice"), e.ws, "bob", e.generalID, nil)
			case "thread info":
				_, err = e.svc.ThreadInfo(t.Context(), e.claims("alice"), e.ws, "bob", e.generalID, parentID)
			case "followed threads":
				_, err = e.svc.FollowedThreads(t.Context(), e.claims("alice"), e.ws, "bob")
			case "follow":
				_, err = e.svc.FollowThread(t.Context(), e.claims("alice"), e.ws, "bob", parentID)
			case "unfollow":
				err = e.svc.UnfollowThread(t.Context(), e.claims("alice"), e.ws, "bob", e.threadID)
			}
			if !errors.Is(err, auth.ErrTokenInvalid) {
				t.Fatalf("A's valid proof with B as actor must fail identity binding before business work, got %v", err)
			}
			assertAtomicFactsUnchanged(t, before, atomicDatabaseFacts(t, e.db))
		})
	}
}

// A transaction-bound channel read cannot acquire a second pooled connection.
// A one-connection pool makes that misuse deterministically fail instead of
// relying on load or a carefully timed concurrent permission mutation.
func TestConversationMutationsReuseTheirTransactionConnection(t *testing.T) {
	for _, operation := range []string{"create", "unfollow"} {
		t.Run(operation, func(t *testing.T) {
			e := newAdvanceEnv(t)
			parent, err := e.send("alice", e.generalID, "parent for bounded-connection workflow", nil)
			if err != nil {
				t.Fatal(err)
			}
			threadID := ""
			if operation == "unfollow" {
				created, err := e.svc.CreateThread(t.Context(), e.claims("alice"), e.ws, "alice", e.generalID, parent.Message.ID, false, "")
				if err != nil {
					t.Fatal(err)
				}
				threadID = created.ThreadID
			}
			e.db.SetMaxOpenConns(1)
			e.db.SetMaxIdleConns(1)
			ctx, cancel := context.WithTimeout(t.Context(), 2*time.Second)
			defer cancel()
			if operation == "create" {
				_, err = e.svc.CreateThread(ctx, e.claims("alice"), e.ws, "alice", e.generalID, parent.Message.ID, true, "reply on the same connection")
			} else {
				err = e.svc.UnfollowThread(ctx, e.claims("alice"), e.ws, "alice", threadID)
			}
			if err != nil {
				t.Fatalf("single-connection transaction workflow failed: %v", err)
			}
		})
	}
}
