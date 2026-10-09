package channelview_test

import (
	"database/sql"
	"path/filepath"
	"testing"
	"time"

	"raft.local/server-go/internal/application/channelview"
	"raft.local/server-go/internal/auth"
	"raft.local/server-go/internal/channel"
	"raft.local/server-go/internal/message"
	platformdb "raft.local/server-go/internal/platform/db"
	"raft.local/server-go/internal/readstate"
)

// A complete authorized query must bind its viewer to the validated claims.
// HTTP currently supplies matching arguments; exporting an application API
// must not introduce a second independently trusted acting-user parameter.
func TestChannelViewCannotSubstituteAnotherViewer(t *testing.T) {
	handle, err := platformdb.Open(filepath.Join(t.TempDir(), "raft.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = handle.Close(); platformdb.ReleaseAuthorityFence(handle) })
	exec := func(query string, args ...any) {
		t.Helper()
		if _, err := handle.ExecContext(t.Context(), query, args...); err != nil {
			t.Fatal(err)
		}
	}
	exec(`INSERT INTO users (id, email, name, password_hash, email_verified, created_at, updated_at)
		VALUES ('viewer-a', 'a@viewer.test', 'viewer_a', 'x', 1, 0, 0),
		('viewer-b', 'b@viewer.test', 'viewer_b', 'x', 1, 0, 0)`)
	exec(`INSERT INTO session_families (id, user_id, created_at)
		VALUES ('family-a', 'viewer-a', 0), ('family-b', 'viewer-b', 0)`)
	exec(`INSERT INTO workspaces (id, name, slug, owner_id, created_at)
		VALUES ('shared-view-space', 'Shared', 'view-shared', 'viewer-b', 0),
		('other-view-space', 'Other', 'view-other', 'viewer-b', 0)`)
	exec(`INSERT INTO workspace_memberships (workspace_id, user_id, role, joined_at)
		VALUES ('shared-view-space', 'viewer-a', 'member', 0),
		('shared-view-space', 'viewer-b', 'owner', 0),
		('other-view-space', 'viewer-b', 'owner', 0)`)
	channels := channel.NewStore(handle)
	states := readstate.NewStore(handle, channels)
	messages := message.NewStore(handle, channels)
	service, err := channelview.NewService(channels, states, messages)
	if err != nil {
		t.Fatal(err)
	}
	signer := auth.NewTokenSigner([]byte("viewer-authority-test-signing-key-0123456789"), time.Hour)
	claimsFor := func(user, family string) auth.AccessTokenClaims {
		t.Helper()
		token, err := signer.SignAccessToken(user, family)
		if err != nil {
			t.Fatal(err)
		}
		claims, err := signer.VerifyAccessToken(token)
		if err != nil {
			t.Fatal(err)
		}
		return *claims
	}
	alice := claimsFor("viewer-a", "family-a")
	bob := claimsFor("viewer-b", "family-b")

	for _, workspaceID := range []string{"shared-view-space", "other-view-space"} {
		t.Run(workspaceID, func(t *testing.T) {
			created, err := channels.CreateChannel(t.Context(), channel.CreateInput{
				WorkspaceID: workspaceID, Name: "b-private", Type: channel.TypePrivate, CreatorUserID: "viewer-b",
			})
			if err != nil {
				t.Fatal(err)
			}
			exec(`INSERT INTO user_channel_read_states
				(workspace_id, user_id, channel_id, last_read_seq, read_state_version, updated_at)
				VALUES (?, 'viewer-b', ?, 0, 7, 0)`, workspaceID, created.ID)
			// Positive control uses an actual signed B proof and the same
			// private channel; a blanket rejection is not a valid fix.
			rows, err := service.List(t.Context(), bob, workspaceID, "viewer-b", channel.ArchivedExclude)
			if err != nil {
				t.Fatalf("owner's legitimate list failed: %v", err)
			}
			found := false
			for _, row := range rows {
				found = found || row.Channel.ID == created.ID
			}
			if !found {
				t.Fatal("owner's private channel absent from positive-control query")
			}
			if _, err := service.Detail(t.Context(), bob, workspaceID, "viewer-b", created.ID); err != nil {
				t.Fatalf("owner's legitimate detail failed: %v", err)
			}
			if _, err := service.CreateResult(t.Context(), bob, workspaceID, "viewer-b", *created); err != nil {
				t.Fatalf("owner's legitimate create-result failed: %v", err)
			}

			t.Run("list", func(t *testing.T) {
				if _, err := service.List(t.Context(), alice, workspaceID, "viewer-b", channel.ArchivedExclude); err == nil {
					t.Fatal("valid A claims were allowed to query B's private channel list")
				}
			})
			t.Run("detail", func(t *testing.T) {
				if _, err := service.Detail(t.Context(), alice, workspaceID, "viewer-b", created.ID); err == nil {
					t.Fatal("valid A claims were allowed to query B's private channel detail")
				}
			})
			t.Run("create result", func(t *testing.T) {
				if _, err := service.CreateResult(t.Context(), alice, workspaceID, "viewer-b", *created); err == nil {
					t.Fatal("valid A claims were allowed to query B's private create-result state")
				}
			})
		})
	}
	// All negative queries are read-only and cannot reset the other viewer's
	// existing state while manufacturing an empty/absent response.
	var unchanged int
	if err := handle.QueryRowContext(t.Context(), `SELECT COUNT(*) FROM user_channel_read_states
		WHERE user_id='viewer-b' AND read_state_version=7`).Scan(&unchanged); err != nil && err != sql.ErrNoRows {
		t.Fatal(err)
	}
	if unchanged != 2 {
		t.Fatalf("private state rows were changed: %d preserved, want 2", unchanged)
	}
}
