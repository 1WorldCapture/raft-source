// Workspace use cases: creation with the full legacy transaction, and the
// basic profile surface (name / hideHumansFromMembers / avatar URL).
// Transactions belong to these use cases; the channel and audit writers below
// accept the transaction and never open their own.

package workspace

import (
	"context"
	"crypto/rand"
	"database/sql"
	"fmt"
	"strings"

	platformdb "raft.local/server-go/internal/platform/db"
)

// newUUID mints the legacy UUIDv4 string shape for workspace/channel/audit IDs
// (crypto/rand; a mint failure is returned, never substituted with a weaker ID).
func newUUID() (string, error) {
	buf := make([]byte, 16)
	if _, err := rand.Read(buf); err != nil {
		return "", err
	}
	buf[6] = (buf[6] & 0x0f) | 0x40
	buf[8] = (buf[8] & 0x3f) | 0x80
	return fmt.Sprintf("%x-%x-%x-%x-%x", buf[0:4], buf[4:6], buf[6:8], buf[8:10], buf[10:16]), nil
}

// CreateWorkspace performs the whole TS createServer transaction: slug
// precheck, workspace row, owner membership (explicit owner role — the column
// default is member), the v2 setup and preference defaults, the membership
// agreement audit row, the #all and #announcement system channels, and — when
// the opener policy is on — the private onboarding-owner channel with the
// creator on its roster. Any failure rolls the whole transaction back; no
// Agent is started and no message is delivered.
func (s *Store) CreateWorkspace(ctx context.Context, userID, name, slug string) (ServerRecord, error) {
	// Domain-level truthiness re-check with the legacy wording; raw-JSON
	// type checks (truthy non-string slug) belong to transport.
	if name == "" || slug == "" {
		return ServerRecord{}, &DomainError{Code: CodeInvalidInput, Message: "Name and slug are required"}
	}
	if msg := validateSlug(slug); msg != "" {
		return ServerRecord{}, &DomainError{Code: CodeInvalidInput, Message: msg}
	}
	var record ServerRecord
	err := s.withTx(ctx, func(tx *sql.Tx) error {
		// Transactional revalidation: the owner row must still exist.
		var exists bool
		if err := tx.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM users WHERE id = ?)`, userID).Scan(&exists); err != nil {
			return err
		}
		if !exists {
			return fmt.Errorf("create workspace: owner %q does not exist", userID)
		}
		// Active-slug precheck (TS checks live rows only; the unique index
		// below still arbitrates races and soft-deleted slugs — design D02).
		var conflicting string
		err := tx.QueryRowContext(ctx,
			`SELECT id FROM workspaces WHERE slug = ? AND deleted_at IS NULL`, slug).Scan(&conflicting)
		if err == nil {
			return &DomainError{Code: CodeConflict, Message: fmt.Sprintf("Server slug %q is already taken", slug)}
		}
		if err != sql.ErrNoRows {
			return err
		}

		now := s.now().UnixMilli()
		workspaceID, err := newUUID()
		if err != nil {
			return err
		}
		if _, err := tx.ExecContext(ctx, `
			INSERT INTO workspaces (id, name, slug, kind, owner_id,
				agent_all_channel_greeting_enabled, hide_humans_from_members, publicly_visible,
				plan, translation_enabled, progress_announcements_enabled, created_at, updated_at)
			VALUES (?, ?, ?, 'normal', ?, 1, 0, 0, 'free', 0, 0, ?, ?)`,
			workspaceID, name, slug, userID, now, now); err != nil {
			// The unique index sees what the precheck cannot: races against a
			// concurrent winner and slugs reserved by soft-deleted rows. The
			// two map differently (frozen route matrix + design D02): an
			// ACTIVE conflicting row is the approved 409 conflict whichever
			// statement detected it; a slug reserved only by soft-deleted
			// rows keeps the legacy failed-insert path — unifying that to 409
			// is the pending-review D02 repair, not landed silently here.
			if platformdb.IsUniqueViolation(err, "slug") {
				var activeWinner string
				checkErr := tx.QueryRowContext(ctx,
					`SELECT id FROM workspaces WHERE slug = ? AND deleted_at IS NULL`, slug).Scan(&activeWinner)
				if checkErr == nil {
					return &DomainError{Code: CodeConflict, Message: fmt.Sprintf("Server slug %q is already taken", slug)}
				}
				if checkErr != sql.ErrNoRows {
					return checkErr
				}
			}
			return fmt.Errorf("insert workspace: %w", err)
		}
		if _, err := tx.ExecContext(ctx, `
			INSERT INTO workspace_memberships (workspace_id, user_id, role, server_push_muted, joined_at)
			VALUES (?, ?, 'owner', 0, ?)`, workspaceID, userID, now); err != nil {
			return err
		}
		// New owners are born under the current setup contract (v2): setup is
		// a per-member fact, not a global server boolean.
		if _, err := tx.ExecContext(ctx, `
			INSERT INTO workspace_member_setup (workspace_id, user_id, status, completion_reason, contract_version)
			VALUES (?, ?, 'not_started', NULL, 'onboarding-setup-v2')`, workspaceID, userID); err != nil {
			return err
		}
		if _, err := tx.ExecContext(ctx, `
			INSERT INTO workspace_member_preferences (workspace_id, user_id)
			VALUES (?, ?)`, workspaceID, userID); err != nil {
			return err
		}
		if err := s.insertAgreementAudit(ctx, tx, workspaceID, userID, now); err != nil {
			return err
		}
		if err := s.insertSystemChannels(ctx, tx, workspaceID, userID, now); err != nil {
			return err
		}
		row := tx.QueryRowContext(ctx, `SELECT `+workspaceColumns+` FROM workspaces w WHERE w.id = ?`, workspaceID)
		record, err = scanWorkspace(row)
		return err
	})
	if err != nil {
		return ServerRecord{}, err
	}
	return record, nil
}

// insertAgreementAudit records the creation-time membership audit fact. No
// agreement was accepted; the nullable columns stay NULL rather than
// fabricating one.
func (s *Store) insertAgreementAudit(ctx context.Context, tx *sql.Tx, workspaceID, userID string, nowMS int64) error {
	id, err := newUUID()
	if err != nil {
		return err
	}
	_, err = tx.ExecContext(ctx, `
		INSERT INTO workspace_membership_agreement_audit
			(id, workspace_id, subject_type, subject_id, agreement_id, agreement_version,
			 actor_user_id, source, ip_address, user_agent, created_at)
		VALUES (?, ?, 'user', ?, NULL, NULL, ?, 'admin-add', NULL, NULL, ?)`,
		id, workspaceID, userID, userID, nowMS)
	return err
}

// insertSystemChannels creates the #all channel (type driven by the opener
// policy) and the always-present #announcement channel; with the opener on,
// the private onboarding-owner channel and the creator's roster row follow.
func (s *Store) insertSystemChannels(ctx context.Context, tx *sql.Tx, workspaceID, userID string, nowMS int64) error {
	allType := "channel"
	if s.policy.OnboardingOpenerV2 {
		allType = "private"
	}
	allID, err := newUUID()
	if err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, `
		INSERT INTO channels (id, workspace_id, name, description, type, system_kind, created_at)
		VALUES (?, ?, 'all', 'General channel for all members', ?, 'all', ?)`,
		allID, workspaceID, allType, nowMS); err != nil {
		return err
	}
	announcementID, err := newUUID()
	if err != nil {
		return err
	}
	// #announcement exists regardless of progressAnnouncementsEnabled, which
	// only gates timers/reminders later.
	if _, err := tx.ExecContext(ctx, `
		INSERT INTO channels (id, workspace_id, name, description, type, system_kind, created_at)
		VALUES (?, ?, 'announcement', 'Agent progress announcements', 'channel', 'announcement', ?)`,
		announcementID, workspaceID, nowMS); err != nil {
		return err
	}
	if !s.policy.OnboardingOpenerV2 {
		return nil
	}
	ownerChannelID, err := newUUID()
	if err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, `
		INSERT INTO channels (id, workspace_id, name, description, type, created_at)
		VALUES (?, ?, 'onboarding-owner', 'Your private onboarding space', 'private', ?)`,
		ownerChannelID, workspaceID, nowMS); err != nil {
		return err
	}
	_, err = tx.ExecContext(ctx, `
		INSERT INTO channel_humans (channel_id, user_id, role, authority_revision, joined_at)
		VALUES (?, ?, 'member', 1, ?)`, ownerChannelID, userID, nowMS)
	return err
}

// UpdateProfile applies the PATCH /api/servers/:id contract: capability
// checked inside the transaction (roles come from the real membership), name
// validated with the PATCH rules (trim, non-empty, ≤100 UTF-16 units),
// hideHumansFromMembers stored as a real boolean, updatedAt refreshed while
// createdAt never changes. slug/owner/plan/kind cannot be changed here.
func (s *Store) UpdateProfile(ctx context.Context, workspaceID, userID string, patch ProfilePatch) (ServerRecord, error) {
	var record ServerRecord
	err := s.withTx(ctx, func(tx *sql.Tx) error {
		role, err := s.memberRole(ctx, tx, workspaceID, userID)
		if err != nil {
			return err
		}
		if !CanManage(role) {
			return &DomainError{Code: CodeForbidden, Message: "Only server owners and admins can edit the server profile"}
		}
		sets := []string{"updated_at = ?"}
		args := []any{s.now().UnixMilli()}
		if patch.Name != nil {
			trimmed, msg := validateProfileName(*patch.Name)
			if msg != "" {
				return &DomainError{Code: CodeInvalidInput, Message: msg}
			}
			sets = append(sets, "name = ?")
			args = append(args, trimmed)
		}
		if patch.HideHumansFromMembers != nil {
			sets = append(sets, "hide_humans_from_members = ?")
			args = append(args, boolToInt(*patch.HideHumansFromMembers))
		}
		if len(sets) == 1 {
			return &DomainError{Code: CodeInvalidInput, Message: "At least one field is required"}
		}
		args = append(args, workspaceID)
		res, err := tx.ExecContext(ctx,
			`UPDATE workspaces SET `+strings.Join(sets, ", ")+` WHERE id = ? AND deleted_at IS NULL`, args...)
		if err != nil {
			return err
		}
		affected, err := res.RowsAffected()
		if err != nil {
			return err
		}
		if affected == 0 {
			return &DomainError{Code: CodeNotFound, Message: "Server not found"}
		}
		row := tx.QueryRowContext(ctx, `SELECT `+workspaceColumns+` FROM workspaces w WHERE w.id = ?`, workspaceID)
		record, err = scanWorkspace(row)
		return err
	})
	if err != nil {
		return ServerRecord{}, err
	}
	return record, nil
}

// SetAvatar stores a published avatar URL with the same capability check as
// the profile update. The file itself is written and published by transport;
// this write is the database reference only, so an empty URL clears the
// reference to NULL.
func (s *Store) SetAvatar(ctx context.Context, workspaceID, userID, url string) (ServerRecord, error) {
	var record ServerRecord
	err := s.withTx(ctx, func(tx *sql.Tx) error {
		role, err := s.memberRole(ctx, tx, workspaceID, userID)
		if err != nil {
			return err
		}
		if !CanManage(role) {
			return &DomainError{Code: CodeForbidden, Message: "Only server owners and admins can edit the server profile"}
		}
		var avatar any
		if url != "" {
			avatar = url
		}
		res, err := tx.ExecContext(ctx,
			`UPDATE workspaces SET avatar_url = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL`,
			avatar, s.now().UnixMilli(), workspaceID)
		if err != nil {
			return err
		}
		affected, err := res.RowsAffected()
		if err != nil {
			return err
		}
		if affected == 0 {
			return &DomainError{Code: CodeNotFound, Message: "Server not found"}
		}
		row := tx.QueryRowContext(ctx, `SELECT `+workspaceColumns+` FROM workspaces w WHERE w.id = ?`, workspaceID)
		record, err = scanWorkspace(row)
		return err
	})
	if err != nil {
		return ServerRecord{}, err
	}
	return record, nil
}

func boolToInt(b bool) int {
	if b {
		return 1
	}
	return 0
}
