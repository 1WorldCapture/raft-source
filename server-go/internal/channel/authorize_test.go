package channel

import (
	"context"
	"database/sql"
	"testing"
)

// duringTx demotes or rebinds rows on the write transaction before the
// mutation re-reads them. A passing test is one where that change is rolled
// back with the refused write.
func (f *fixture) duringTx(t *testing.T, fn func(context.Context, *sql.Tx)) {
	t.Helper()
	f.store.beforeAuthorize = func(ctx context.Context, tx *sql.Tx) {
		fn(ctx, tx)
	}
	t.Cleanup(func() { f.store.beforeAuthorize = nil })
}

func (f *fixture) execTx(t *testing.T, tx *sql.Tx, ctx context.Context, query string, args ...any) {
	t.Helper()
	if _, err := tx.ExecContext(ctx, query, args...); err != nil {
		t.Fatal(err)
	}
}

func (f *fixture) channelSnapshot(t *testing.T, id string) (name, channelType, workspaceID string, archived, deleted sql.NullInt64) {
	t.Helper()
	err := f.db.QueryRow(`SELECT name, type, workspace_id, archived_at, deleted_at FROM channels WHERE id = ?`, id).
		Scan(&name, &channelType, &workspaceID, &archived, &deleted)
	if err != nil {
		t.Fatal(err)
	}
	return name, channelType, workspaceID, archived, deleted
}

func (f *fixture) membershipRole(t *testing.T, workspaceID, userID string) string {
	t.Helper()
	var role string
	if err := f.db.QueryRow(`SELECT role FROM workspace_memberships WHERE workspace_id = ? AND user_id = ?`, workspaceID, userID).Scan(&role); err != nil {
		t.Fatal(err)
	}
	return role
}

func (f *fixture) channelHumanRole(t *testing.T, channelID, userID string) string {
	t.Helper()
	var role string
	err := f.db.QueryRow(`SELECT role FROM channel_humans WHERE channel_id = ? AND user_id = ?`, channelID, userID).Scan(&role)
	if err == sql.ErrNoRows {
		return ""
	}
	if err != nil {
		t.Fatal(err)
	}
	return role
}

func (f *fixture) humanCount(t *testing.T, channelID, userID string) int {
	t.Helper()
	var n int
	if err := f.db.QueryRow(`SELECT COUNT(*) FROM channel_humans WHERE channel_id = ? AND user_id = ?`, channelID, userID).Scan(&n); err != nil {
		t.Fatal(err)
	}
	return n
}

func mustChannel(t *testing.T, channelType, creator string) (*fixture, *Channel) {
	t.Helper()
	f := newFixture(t)
	created, err := f.store.CreateChannel(f.ctx(), CreateInput{
		WorkspaceID: fxWS, Name: "ops", Type: channelType, CreatorUserID: creator,
	})
	if err != nil {
		t.Fatal(err)
	}
	return f, created
}

func TestAuthorizedChannelAdminStillRenames(t *testing.T) {
	f, created := mustChannel(t, TypeChannel, fxMember)
	name := "renamed"
	updated, err := f.store.UpdateChannel(f.ctx(), fxWS, fxMember, created.ID, ChannelUpdates{Name: &name})
	if err != nil || updated.Name != "renamed" {
		t.Fatalf("channel admin rename: %+v %v", updated, err)
	}
}

func TestStaleAuthorizationCannotCommit(t *testing.T) {
	t.Run("rename rolls back when channel admin is demoted", func(t *testing.T) {
		f, created := mustChannel(t, TypeChannel, fxMember)
		f.duringTx(t, func(ctx context.Context, tx *sql.Tx) {
			f.execTx(t, tx, ctx, `UPDATE channel_humans SET role = 'member' WHERE channel_id = ? AND user_id = ?`, created.ID, fxMember)
		})
		name := "renamed"
		_, err := f.store.UpdateChannel(f.ctx(), fxWS, fxMember, created.ID, ChannelUpdates{Name: &name})
		if AsDomainError(err) == nil || AsDomainError(err).Message != CapabilityRequiredMessage {
			t.Fatalf("demoted rename: %v", err)
		}
		got, _, ws, _, _ := f.channelSnapshot(t, created.ID)
		if got != "ops" || ws != fxWS {
			t.Fatalf("rename committed: name=%s ws=%s", got, ws)
		}
		if f.channelHumanRole(t, created.ID, fxMember) != ChannelRoleAdmin {
			t.Fatal("demotion committed")
		}
	})

	t.Run("visibility rolls back when the owner loses the membership row", func(t *testing.T) {
		f, created := mustChannel(t, TypeChannel, fxMember)
		if _, err := f.store.AddHumanTx(f.ctx(), created.ID, fxOwner, ""); err != nil {
			t.Fatal(err)
		}
		f.duringTx(t, func(ctx context.Context, tx *sql.Tx) {
			f.execTx(t, tx, ctx, `DELETE FROM channel_humans WHERE channel_id = ? AND user_id = ?`, created.ID, fxOwner)
		})
		next := TypePrivate
		_, err := f.store.UpdateChannel(f.ctx(), fxWS, fxOwner, created.ID, ChannelUpdates{Type: &next})
		if AsDomainError(err) == nil || AsDomainError(err).Message != VisibilityMembershipRequiredMessage {
			t.Fatalf("visibility without row: %v", err)
		}
		_, typ, _, _, _ := f.channelSnapshot(t, created.ID)
		if typ != TypeChannel || f.humanCount(t, created.ID, fxOwner) != 1 {
			t.Fatalf("visibility committed type=%s ownerRows=%d", typ, f.humanCount(t, created.ID, fxOwner))
		}
	})

	t.Run("visibility rolls back when the owner is demoted to member", func(t *testing.T) {
		f, created := mustChannel(t, TypeChannel, fxMember)
		if _, err := f.store.AddHumanTx(f.ctx(), created.ID, fxOwner, ""); err != nil {
			t.Fatal(err)
		}
		f.duringTx(t, func(ctx context.Context, tx *sql.Tx) {
			f.execTx(t, tx, ctx, `UPDATE workspace_memberships SET role = 'member' WHERE workspace_id = ? AND user_id = ?`, fxWS, fxOwner)
		})
		next := TypePrivate
		_, err := f.store.UpdateChannel(f.ctx(), fxWS, fxOwner, created.ID, ChannelUpdates{Type: &next})
		if AsDomainError(err) == nil || AsDomainError(err).Message != CapabilityRequiredMessage {
			t.Fatalf("demoted visibility: %v", err)
		}
		_, typ, _, _, _ := f.channelSnapshot(t, created.ID)
		if typ != TypeChannel || f.membershipRole(t, fxWS, fxOwner) != RoleOwner {
			t.Fatalf("demoted visibility committed type=%s role=%s", typ, f.membershipRole(t, fxWS, fxOwner))
		}
	})

	t.Run("patch rolls back when the workspace becomes joint storage", func(t *testing.T) {
		f, created := mustChannel(t, TypeChannel, fxMember)
		f.duringTx(t, func(ctx context.Context, tx *sql.Tx) {
			f.execTx(t, tx, ctx, `UPDATE workspaces SET kind = 'joint_storage' WHERE id = ?`, fxWS)
		})
		name := "renamed"
		_, err := f.store.UpdateChannel(f.ctx(), fxWS, fxMember, created.ID, ChannelUpdates{Name: &name})
		if AsDomainError(err) == nil || AsDomainError(err).Message != CapabilityRequiredMessage {
			t.Fatalf("joint_storage rename: %v", err)
		}
		got, _, _, _, _ := f.channelSnapshot(t, created.ID)
		var kind string
		if err := f.db.QueryRow(`SELECT kind FROM workspaces WHERE id = ?`, fxWS).Scan(&kind); err != nil {
			t.Fatal(err)
		}
		if got != "ops" || kind != "normal" {
			t.Fatalf("joint_storage rename committed name=%s kind=%s", got, kind)
		}
	})

	t.Run("patch rolls back when the channel moves to another workspace", func(t *testing.T) {
		f, created := mustChannel(t, TypeChannel, fxMember)
		f.duringTx(t, func(ctx context.Context, tx *sql.Tx) {
			f.execTx(t, tx, ctx, `UPDATE channels SET workspace_id = ? WHERE id = ?`, fxWS2, created.ID)
		})
		name := "renamed"
		_, err := f.store.UpdateChannel(f.ctx(), fxWS, fxMember, created.ID, ChannelUpdates{Name: &name})
		if AsDomainError(err) == nil || AsDomainError(err).Message != "Channel not found" {
			t.Fatalf("cross-workspace rename: %v", err)
		}
		got, _, ws, _, _ := f.channelSnapshot(t, created.ID)
		if got != "ops" || ws != fxWS {
			t.Fatalf("cross-workspace rename committed name=%s ws=%s", got, ws)
		}
	})

	t.Run("archive rolls back when the channel admin is demoted", func(t *testing.T) {
		f, created := mustChannel(t, TypeChannel, fxMember)
		f.duringTx(t, func(ctx context.Context, tx *sql.Tx) {
			f.execTx(t, tx, ctx, `UPDATE channel_humans SET role = 'member' WHERE channel_id = ? AND user_id = ?`, created.ID, fxMember)
		})
		_, err := f.store.ArchiveChannel(f.ctx(), fxWS, created.ID, fxMember)
		if AsDomainError(err) == nil || AsDomainError(err).Message != CapabilityRequiredMessage {
			t.Fatalf("demoted archive: %v", err)
		}
		_, _, _, archived, _ := f.channelSnapshot(t, created.ID)
		if archived.Valid || f.channelHumanRole(t, created.ID, fxMember) != ChannelRoleAdmin {
			t.Fatal("demoted archive committed")
		}
	})

	t.Run("unarchive rolls back when the owner loses archive authority", func(t *testing.T) {
		f, created := mustChannel(t, TypeChannel, fxOwner)
		if _, err := f.store.ArchiveChannel(f.ctx(), fxWS, created.ID, fxOwner); err != nil {
			t.Fatal(err)
		}
		f.duringTx(t, func(ctx context.Context, tx *sql.Tx) {
			f.execTx(t, tx, ctx, `UPDATE workspace_memberships SET role = 'member' WHERE workspace_id = ? AND user_id = ?`, fxWS, fxOwner)
			f.execTx(t, tx, ctx, `UPDATE channel_humans SET role = 'member' WHERE channel_id = ? AND user_id = ?`, created.ID, fxOwner)
		})
		_, err := f.store.UnarchiveChannel(f.ctx(), fxWS, created.ID, fxOwner)
		if AsDomainError(err) == nil || AsDomainError(err).Message != CapabilityRequiredMessage {
			t.Fatalf("demoted unarchive: %v", err)
		}
		_, _, _, archived, _ := f.channelSnapshot(t, created.ID)
		if !archived.Valid || f.membershipRole(t, fxWS, fxOwner) != RoleOwner || f.channelHumanRole(t, created.ID, fxOwner) != ChannelRoleAdmin {
			t.Fatal("demoted unarchive committed")
		}
	})

	t.Run("delete rolls back when the owner is demoted", func(t *testing.T) {
		f, created := mustChannel(t, TypeChannel, fxMember)
		f.duringTx(t, func(ctx context.Context, tx *sql.Tx) {
			f.execTx(t, tx, ctx, `UPDATE workspace_memberships SET role = 'member' WHERE workspace_id = ? AND user_id = ?`, fxWS, fxOwner)
		})
		err := f.store.DeleteChannel(f.ctx(), fxWS, created.ID, fxOwner)
		if AsDomainError(err) == nil || AsDomainError(err).Message != "Only admins can delete channels" {
			t.Fatalf("demoted delete: %v", err)
		}
		_, _, _, _, deleted := f.channelSnapshot(t, created.ID)
		if deleted.Valid || f.membershipRole(t, fxWS, fxOwner) != RoleOwner {
			t.Fatal("demoted delete committed")
		}
	})

	t.Run("private delete rolls back when the owner loses the channel row", func(t *testing.T) {
		f, created := mustChannel(t, TypePrivate, fxMember)
		if _, err := f.store.AddHumanTx(f.ctx(), created.ID, fxOwner, ""); err != nil {
			t.Fatal(err)
		}
		f.duringTx(t, func(ctx context.Context, tx *sql.Tx) {
			f.execTx(t, tx, ctx, `DELETE FROM channel_humans WHERE channel_id = ? AND user_id = ?`, created.ID, fxOwner)
		})
		err := f.store.DeleteChannel(f.ctx(), fxWS, created.ID, fxOwner)
		if AsDomainError(err) == nil || AsDomainError(err).Message != "Channel not found" {
			t.Fatalf("private delete after removal: %v", err)
		}
		_, _, _, _, deleted := f.channelSnapshot(t, created.ID)
		if deleted.Valid || f.humanCount(t, created.ID, fxOwner) != 1 {
			t.Fatal("private delete committed")
		}
	})

	t.Run("delete rolls back when the channel moves to another workspace", func(t *testing.T) {
		f, created := mustChannel(t, TypeChannel, fxMember)
		f.duringTx(t, func(ctx context.Context, tx *sql.Tx) {
			f.execTx(t, tx, ctx, `UPDATE channels SET workspace_id = ? WHERE id = ?`, fxWS2, created.ID)
		})
		err := f.store.DeleteChannel(f.ctx(), fxWS, created.ID, fxOwner)
		if AsDomainError(err) == nil || AsDomainError(err).Message != "Channel not found" {
			t.Fatalf("cross-workspace delete: %v", err)
		}
		_, _, ws, _, deleted := f.channelSnapshot(t, created.ID)
		if deleted.Valid || ws != fxWS {
			t.Fatalf("cross-workspace delete committed ws=%s deleted=%v", ws, deleted.Valid)
		}
	})

	t.Run("create rolls back when the creator is demoted to guest", func(t *testing.T) {
		f := newFixture(t)
		f.duringTx(t, func(ctx context.Context, tx *sql.Tx) {
			f.execTx(t, tx, ctx, `UPDATE workspace_memberships SET role = 'guest' WHERE workspace_id = ? AND user_id = ?`, fxWS, fxMember)
		})
		_, err := f.store.CreateChannel(f.ctx(), CreateInput{
			WorkspaceID: fxWS, Name: "fresh", Type: TypeChannel, CreatorUserID: fxMember,
		})
		if AsDomainError(err) == nil || AsDomainError(err).Message != "You do not have permission to create channels" {
			t.Fatalf("demoted create: %v", err)
		}
		if f.countChannels("name = 'fresh'") != 0 || f.membershipRole(t, fxWS, fxMember) != RoleMember {
			t.Fatal("demoted create committed")
		}
	})

	t.Run("create rolls back when the creator loses membership", func(t *testing.T) {
		f := newFixture(t)
		f.duringTx(t, func(ctx context.Context, tx *sql.Tx) {
			f.execTx(t, tx, ctx, `DELETE FROM workspace_memberships WHERE workspace_id = ? AND user_id = ?`, fxWS, fxMember)
		})
		_, err := f.store.CreateChannel(f.ctx(), CreateInput{
			WorkspaceID: fxWS, Name: "fresh", Type: TypeChannel, CreatorUserID: fxMember,
		})
		if AsDomainError(err) == nil || AsDomainError(err).Message != "You do not have permission to create channels" {
			t.Fatalf("create after removal: %v", err)
		}
		var members int
		if err := f.db.QueryRow(`SELECT COUNT(*) FROM workspace_memberships WHERE workspace_id = ? AND user_id = ?`, fxWS, fxMember).Scan(&members); err != nil {
			t.Fatal(err)
		}
		if f.countChannels("name = 'fresh'") != 0 || members != 1 {
			t.Fatal("create after removal committed")
		}
	})

	t.Run("join rolls back when the member is demoted to guest", func(t *testing.T) {
		f, created := mustChannel(t, TypeChannel, fxOwner)
		f.duringTx(t, func(ctx context.Context, tx *sql.Tx) {
			f.execTx(t, tx, ctx, `UPDATE workspace_memberships SET role = 'guest' WHERE workspace_id = ? AND user_id = ?`, fxWS, fxMember)
		})
		err := f.store.JoinChannel(f.ctx(), fxWS, created.ID, fxMember)
		if AsDomainError(err) == nil || AsDomainError(err).Message != "Guest policy does not allow joining this channel" {
			t.Fatalf("guest join: %v", err)
		}
		if f.humanCount(t, created.ID, fxMember) != 0 || f.membershipRole(t, fxWS, fxMember) != RoleMember {
			t.Fatal("guest join committed")
		}
	})

	t.Run("join rolls back when workspace membership disappears", func(t *testing.T) {
		f, created := mustChannel(t, TypeChannel, fxOwner)
		f.duringTx(t, func(ctx context.Context, tx *sql.Tx) {
			f.execTx(t, tx, ctx, `DELETE FROM workspace_memberships WHERE workspace_id = ? AND user_id = ?`, fxWS, fxMember)
		})
		err := f.store.JoinChannel(f.ctx(), fxWS, created.ID, fxMember)
		if AsDomainError(err) == nil || AsDomainError(err).Message != NotServerMemberMessage {
			t.Fatalf("join after removal: %v", err)
		}
		var members int
		if err := f.db.QueryRow(`SELECT COUNT(*) FROM workspace_memberships WHERE workspace_id = ? AND user_id = ?`, fxWS, fxMember).Scan(&members); err != nil {
			t.Fatal(err)
		}
		if f.humanCount(t, created.ID, fxMember) != 0 || members != 1 {
			t.Fatal("join after removal committed")
		}
	})

	t.Run("join rolls back when the channel moves to another workspace", func(t *testing.T) {
		f, created := mustChannel(t, TypeChannel, fxOwner)
		f.duringTx(t, func(ctx context.Context, tx *sql.Tx) {
			f.execTx(t, tx, ctx, `UPDATE channels SET workspace_id = ? WHERE id = ?`, fxWS2, created.ID)
		})
		err := f.store.JoinChannel(f.ctx(), fxWS, created.ID, fxMember)
		if AsDomainError(err) == nil || AsDomainError(err).Message != "Channel not found" {
			t.Fatalf("cross-workspace join: %v", err)
		}
		_, _, ws, _, _ := f.channelSnapshot(t, created.ID)
		if ws != fxWS || f.humanCount(t, created.ID, fxMember) != 0 {
			t.Fatal("cross-workspace join committed")
		}
	})

	t.Run("leave does not drop the last private member after membership loss", func(t *testing.T) {
		f, created := mustChannel(t, TypePrivate, fxMember)
		f.duringTx(t, func(ctx context.Context, tx *sql.Tx) {
			f.execTx(t, tx, ctx, `DELETE FROM workspace_memberships WHERE workspace_id = ? AND user_id = ?`, fxWS, fxMember)
		})
		err := f.store.LeaveChannel(f.ctx(), fxWS, created.ID, fxMember)
		if AsDomainError(err) == nil || AsDomainError(err).Message != NotServerMemberMessage {
			t.Fatalf("leave after removal: %v", err)
		}
		_, _, _, _, deleted := f.channelSnapshot(t, created.ID)
		var members int
		if err := f.db.QueryRow(`SELECT COUNT(*) FROM workspace_memberships WHERE workspace_id = ? AND user_id = ?`, fxWS, fxMember).Scan(&members); err != nil {
			t.Fatal(err)
		}
		if deleted.Valid || f.humanCount(t, created.ID, fxMember) != 1 || members != 1 {
			t.Fatal("leave after removal committed")
		}
	})

	t.Run("leave rolls back when the channel moves to another workspace", func(t *testing.T) {
		f, created := mustChannel(t, TypeChannel, fxMember)
		f.duringTx(t, func(ctx context.Context, tx *sql.Tx) {
			f.execTx(t, tx, ctx, `UPDATE channels SET workspace_id = ? WHERE id = ?`, fxWS2, created.ID)
		})
		err := f.store.LeaveChannel(f.ctx(), fxWS, created.ID, fxMember)
		if AsDomainError(err) == nil || AsDomainError(err).Message != "Channel not found" {
			t.Fatalf("cross-workspace leave: %v", err)
		}
		_, _, ws, _, _ := f.channelSnapshot(t, created.ID)
		if ws != fxWS || f.humanCount(t, created.ID, fxMember) != 1 {
			t.Fatal("cross-workspace leave committed")
		}
	})

	t.Run("remove rolls back when the channel admin is demoted", func(t *testing.T) {
		f, created := mustChannel(t, TypeChannel, fxMember)
		if _, err := f.store.AddHumanTx(f.ctx(), created.ID, fxGuest, ""); err != nil {
			t.Fatal(err)
		}
		f.duringTx(t, func(ctx context.Context, tx *sql.Tx) {
			f.execTx(t, tx, ctx, `UPDATE channel_humans SET role = 'member' WHERE channel_id = ? AND user_id = ?`, created.ID, fxMember)
		})
		err := f.store.CommitAuthorized(f.ctx(), fxWS, created.ID, fxMember, []string{CapRemoveChannelMembers}, func(tx Executor) error {
			return f.store.RemoveHuman(f.ctx(), created.ID, fxGuest, tx)
		})
		if AsDomainError(err) == nil || AsDomainError(err).Message != CapabilityRequiredMessage {
			t.Fatalf("demoted remove: %v", err)
		}
		if f.humanCount(t, created.ID, fxGuest) != 1 || f.channelHumanRole(t, created.ID, fxMember) != ChannelRoleAdmin {
			t.Fatal("demoted remove committed")
		}
	})

	t.Run("batch add rolls back when the actor loses channel membership", func(t *testing.T) {
		f, created := mustChannel(t, TypeChannel, fxMember)
		f.duringTx(t, func(ctx context.Context, tx *sql.Tx) {
			f.execTx(t, tx, ctx, `DELETE FROM channel_humans WHERE channel_id = ? AND user_id = ?`, created.ID, fxMember)
		})
		err := f.store.CommitAuthorized(f.ctx(), fxWS, created.ID, fxMember, []string{CapAddChannelMembers}, func(tx Executor) error {
			_, err := f.store.AddHuman(f.ctx(), created.ID, fxGuest, "", tx)
			return err
		})
		if AsDomainError(err) == nil || AsDomainError(err).Message != CapabilityRequiredMessage {
			t.Fatalf("batch after leaving: %v", err)
		}
		if f.humanCount(t, created.ID, fxGuest) != 0 || f.humanCount(t, created.ID, fxMember) != 1 {
			t.Fatal("batch after leaving committed")
		}
	})

	t.Run("add rolls back when the target loses workspace membership", func(t *testing.T) {
		f, created := mustChannel(t, TypePrivate, fxMember)
		f.duringTx(t, func(ctx context.Context, tx *sql.Tx) {
			f.execTx(t, tx, ctx, `DELETE FROM workspace_memberships WHERE workspace_id = ? AND user_id = ?`, fxWS, fxGuest)
		})
		err := f.store.CommitAuthorized(f.ctx(), fxWS, created.ID, fxOwner, []string{CapAddChannelMembers}, func(tx Executor) error {
			_, err := f.store.AddHuman(f.ctx(), created.ID, fxGuest, "", tx)
			return err
		})
		if AsDomainError(err) == nil || AsDomainError(err).Message != "Human is not a member of this channel's server" {
			t.Fatalf("add after target removal: %v", err)
		}
		var members int
		if err := f.db.QueryRow(`SELECT COUNT(*) FROM workspace_memberships WHERE workspace_id = ? AND user_id = ?`, fxWS, fxGuest).Scan(&members); err != nil {
			t.Fatal(err)
		}
		if f.humanCount(t, created.ID, fxGuest) != 0 || members != 1 {
			t.Fatal("add after target removal committed")
		}
	})

	t.Run("role change rolls back when the requester is demoted", func(t *testing.T) {
		f, created := mustChannel(t, TypeChannel, fxMember)
		if _, err := f.store.AddHumanTx(f.ctx(), created.ID, fxGuest, ""); err != nil {
			t.Fatal(err)
		}
		f.duringTx(t, func(ctx context.Context, tx *sql.Tx) {
			f.execTx(t, tx, ctx, `UPDATE channel_humans SET role = 'member' WHERE channel_id = ? AND user_id = ?`, created.ID, fxMember)
		})
		_, err := f.store.ChangeChannelMembershipRole(f.ctx(), fxWS, created.ID, fxMember, "user", fxGuest, ChannelRoleAdmin)
		if AsRoleMutationError(err) == nil || AsRoleMutationError(err).Code != RoleCodeCapabilityRequired {
			t.Fatalf("demoted role change: %v", err)
		}
		if f.channelHumanRole(t, created.ID, fxGuest) != ChannelRoleMember || f.channelHumanRole(t, created.ID, fxMember) != ChannelRoleAdmin {
			t.Fatal("demoted role change committed")
		}
		if n := f.countWhere(`SELECT COUNT(*) FROM channel_membership_role_events WHERE channel_id = ?`, created.ID); n != 0 {
			t.Fatalf("demoted role change wrote %d events", n)
		}
	})

	t.Run("role change rolls back when the requester loses membership", func(t *testing.T) {
		f, created := mustChannel(t, TypeChannel, fxMember)
		if _, err := f.store.AddHumanTx(f.ctx(), created.ID, fxGuest, ""); err != nil {
			t.Fatal(err)
		}
		f.duringTx(t, func(ctx context.Context, tx *sql.Tx) {
			f.execTx(t, tx, ctx, `DELETE FROM workspace_memberships WHERE workspace_id = ? AND user_id = ?`, fxWS, fxMember)
		})
		_, err := f.store.ChangeChannelMembershipRole(f.ctx(), fxWS, created.ID, fxMember, "user", fxGuest, ChannelRoleAdmin)
		if AsRoleMutationError(err) == nil || AsRoleMutationError(err).Code != RoleCodeCapabilityRequired {
			t.Fatalf("role change after removal: %v", err)
		}
		var members int
		if err := f.db.QueryRow(`SELECT COUNT(*) FROM workspace_memberships WHERE workspace_id = ? AND user_id = ?`, fxWS, fxMember).Scan(&members); err != nil {
			t.Fatal(err)
		}
		if members != 1 || f.channelHumanRole(t, created.ID, fxGuest) != ChannelRoleMember {
			t.Fatal("role change after removal committed")
		}
	})

	t.Run("role change rolls back when the channel moves to another workspace", func(t *testing.T) {
		f, created := mustChannel(t, TypeChannel, fxMember)
		if _, err := f.store.AddHumanTx(f.ctx(), created.ID, fxGuest, ""); err != nil {
			t.Fatal(err)
		}
		f.duringTx(t, func(ctx context.Context, tx *sql.Tx) {
			f.execTx(t, tx, ctx, `UPDATE channels SET workspace_id = ? WHERE id = ?`, fxWS2, created.ID)
		})
		_, err := f.store.ChangeChannelMembershipRole(f.ctx(), fxWS, created.ID, fxMember, "user", fxGuest, ChannelRoleAdmin)
		if AsRoleMutationError(err) == nil || AsRoleMutationError(err).Code != RoleCodeChannelNotFound {
			t.Fatalf("cross-workspace role change: %v", err)
		}
		_, _, ws, _, _ := f.channelSnapshot(t, created.ID)
		if ws != fxWS || f.channelHumanRole(t, created.ID, fxGuest) != ChannelRoleMember {
			t.Fatal("cross-workspace role change committed")
		}
	})

	t.Run("dm remove rolls back when the actor loses the participant row", func(t *testing.T) {
		f := newFixture(t)
		dmID := "dddddddd-dddd-4ddd-8ddd-dddddddddddd"
		now := f.clock.T.UnixMilli()
		if _, err := f.db.Exec(`INSERT INTO channels (id, workspace_id, name, type, created_at) VALUES (?, ?, 'dm', 'dm', ?)`, dmID, fxWS, now); err != nil {
			t.Fatal(err)
		}
		for _, userID := range []string{fxOwner, fxMember} {
			if _, err := f.db.Exec(`INSERT INTO channel_humans (channel_id, user_id, role, joined_at) VALUES (?, ?, 'member', ?)`, dmID, userID, now); err != nil {
				t.Fatal(err)
			}
		}
		f.duringTx(t, func(ctx context.Context, tx *sql.Tx) {
			f.execTx(t, tx, ctx, `DELETE FROM channel_humans WHERE channel_id = ? AND user_id = ?`, dmID, fxOwner)
		})
		err := f.store.CommitDMParticipant(f.ctx(), fxWS, dmID, fxOwner, func(tx Executor) error {
			return f.store.RemoveHuman(f.ctx(), dmID, fxMember, tx)
		})
		if AsDomainError(err) == nil || AsDomainError(err).Message != "Channel not found" {
			t.Fatalf("dm remove after losing participation: %v", err)
		}
		if f.humanCount(t, dmID, fxOwner) != 1 || f.humanCount(t, dmID, fxMember) != 1 {
			t.Fatal("dm remove committed")
		}
	})

	t.Run("hiding #all rolls back when the owner is demoted", func(t *testing.T) {
		f := newFixture(t)
		list, err := f.store.ListChannels(f.ctx(), fxWS, fxOwner, ArchivedExclude)
		if err != nil {
			t.Fatal(err)
		}
		var allID string
		for _, item := range list {
			if item.Channel.Name == systemAllName {
				allID = item.Channel.ID
			}
		}
		if allID == "" {
			t.Fatal("missing #all")
		}
		f.duringTx(t, func(ctx context.Context, tx *sql.Tx) {
			f.execTx(t, tx, ctx, `UPDATE workspace_memberships SET role = 'member' WHERE workspace_id = ? AND user_id = ?`, fxWS, fxOwner)
		})
		next := TypePrivate
		_, err = f.store.UpdateChannel(f.ctx(), fxWS, fxOwner, allID, ChannelUpdates{Type: &next})
		if AsDomainError(err) == nil || AsDomainError(err).Message != CapabilityRequiredMessage {
			t.Fatalf("demoted hide: %v", err)
		}
		_, typ, _, _, _ := f.channelSnapshot(t, allID)
		if typ != TypeChannel || f.membershipRole(t, fxWS, fxOwner) != RoleOwner {
			t.Fatalf("demoted hide committed type=%s role=%s", typ, f.membershipRole(t, fxWS, fxOwner))
		}
	})
}
