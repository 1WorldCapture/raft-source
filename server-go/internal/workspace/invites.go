// Workspace invitations (M3 invitations fix, UI acceptance finding #1).
//
// Contract source: the frozen TS inviteService
// (packages/server/src/services/inviteService.ts) and its routes
// (packages/server/src/routes/servers.ts join-links/invites, auth.ts
// accept-invite/invite-info) as consumed by packages/web
// (InviteHumanDialog.tsx, SettingsPanel.tsx Invites/JoinLinks sections,
// auth InviteAcceptPage.tsx):
//   - owner/admin (inviteMembers capability) manage both surfaces; guests are
//     denied by the transport-level management-surface guard, members get the
//     exact legacy 403 sentences from these use cases;
//   - every management write revalidates the role inside its own transaction,
//     so a demotion between the scope middleware and the commit cannot push
//     through an invitation created under the old permission;
//   - email invites are single-use, email-bound and stored as sha256 digests
//     only; join links are multi-use, revocable, expirable and use-limited —
//     their raw token must stay retrievable because the UI contract rebuilds
//     the join URL from list responses;
//   - joining is idempotent: a caller who is already a member of the target
//     workspace succeeds without consuming a join-link use; the use counter
//     increments under a guarded UPDATE that re-checks revocation, expiry and
//     exhaustion atomically with the membership insert.
package workspace

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"database/sql"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"strings"
	"time"
)

// Exact legacy sentences; transport maps them verbatim to {error:...}.
const (
	errInvalidInviteToken   = "Invalid invite token"
	errInviteAlreadyUsed    = "This invite has already been used"
	errInviteExpired        = "This invite has expired"
	errInviteRevoked        = "This invite has been revoked"
	errInviteExhausted      = "This invite has already reached its usage limit"
	errInviteNoLongerValid  = "This invite is no longer valid"
	errInviteDifferentEmail = "This invite was sent to a different email address"
	errAlreadyMember        = "You are already a member of this server"
	errServerNoLongerExists = "This server no longer exists"

	errOnlyAdminCreateLinks = "Only server owners and admins can create join links"
	errOnlyAdminViewLinks   = "Only server owners and admins can view join links"
	errOnlyAdminRevokeLinks = "Only server owners and admins can revoke join links"
	errOnlyAdminSendInvite  = "Only server owners and admins can send invites"
	errOnlyAdminViewInvite  = "Only server owners and admins can view invites"
	errOnlyAdminRevokeInvit = "Only server owners and admins can revoke invites"

	errUserAlreadyMember   = "This user is already a member of this server"
	errInviteAlreadySent   = "An invite has already been sent to this email"
	errMaxUsesInvalid      = "Max uses must be a positive integer"
	errExpiresAtInvalid    = "Expires at must be a valid date"
	errInvalidInvitableRol = "role must be one of: member, guest"

	// MsgGuestAccessDisabled is the exact TS route sentence for inviting a
	// guest while the server guest feature flag is disabled. M3 freezes that
	// flag disabled (the local policy vector has no guest switch and the
	// feature-flag service is not implemented), so guest invitations are
	// refused on creation AND on acceptance of previously persisted rows —
	// never silently downgraded to member.
	MsgGuestAccessDisabled = "Guest access is not enabled for this server"
)

// inviteEmailWhitespace matches ECMAScript trim()/\\s used by the frozen
// shared/emailValidation.ts, including BOM (which strings.TrimSpace omits).
func inviteEmailWhitespace(r rune) bool {
	switch r {
	case '\t', '\n', '\v', '\f', '\r', ' ', '\u00a0', '\u1680',
		'\u2028', '\u2029', '\u202f', '\u205f', '\u3000', '\ufeff':
		return true
	}
	return r >= '\u2000' && r <= '\u200a'
}

// inviteNormalizedEmail applies the legacy trim + lowercase rule before
// persistence and email-bound acceptance.
func inviteNormalizedEmail(email string) string {
	return strings.ToLower(strings.TrimFunc(email, inviteEmailWhitespace))
}

// ValidateInviteEmail returns the TS route's exact validation sentence, or
// "". Both the HTTP precheck and the domain write use this one validator;
// limits are UTF-16 units, not Go bytes. Source: shared/emailValidation.ts.
func ValidateInviteEmail(email string) string {
	trimmed := strings.TrimFunc(email, inviteEmailWhitespace)
	if trimmed == "" {
		return "Email is required"
	}
	const invalid = "Enter a valid email address"
	if utf16Length(trimmed) > 254 || strings.IndexFunc(trimmed, inviteEmailWhitespace) >= 0 {
		return invalid
	}
	at := strings.IndexByte(trimmed, '@')
	if at <= 0 || at != strings.LastIndexByte(trimmed, '@') {
		return invalid
	}
	local, domain := trimmed[:at], trimmed[at+1:]
	if utf16Length(local) > 64 || domain == "" || strings.HasPrefix(domain, ".") ||
		strings.HasSuffix(domain, ".") || !strings.Contains(domain, ".") || strings.Contains(domain, "..") {
		return invalid
	}
	return ""
}

// inviteTokenDigest is sha256(token) hex — the only stored form of an email
// invite token, and the indexed lookup key for join links.
func inviteTokenDigest(token string) string {
	sum := sha256.Sum256([]byte(token))
	return hex.EncodeToString(sum[:])
}

// newJoinLinkToken mirrors the TS 16-byte base64url join-link token.
func newJoinLinkToken() (string, error) {
	buf := make([]byte, 16)
	if _, err := rand.Read(buf); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(buf), nil
}

// newInviteToken mirrors the TS 32-byte hex email-invite token.
func newInviteToken() (string, error) {
	buf := make([]byte, 32)
	if _, err := rand.Read(buf); err != nil {
		return "", err
	}
	return hex.EncodeToString(buf), nil
}

// InviteEmailTTL matches the frozen TS 7-day invite expiry.
const InviteEmailTTL = 7 * 24 * time.Hour

// JoinLinkOptions carries the two optional join-link limits. MaxUses nil or
// >= 1; ExpiresAt nil means never. Sentence-level validation lives here so
// the transactional write cannot bypass it.
type JoinLinkOptions struct {
	MaxUses   *int64
	ExpiresAt *time.Time
}

// ValidateJoinLinkMaxUses applies the TS positive-integer rule.
func ValidateJoinLinkMaxUses(maxUses int64) string {
	if maxUses < 1 || maxUses > 1<<53-1 {
		return errMaxUsesInvalid
	}
	return ""
}

// JoinLinkRecord is one workspace_join_links row (TS ServerJoinLinkRecord).
type JoinLinkRecord struct {
	ID        string
	Token     string
	CreatedAt time.Time
	ExpiresAt *time.Time
	MaxUses   *int64
	UseCount  int64
	RevokedAt *time.Time
}

// InviteRecord is one workspace_invites row (TS listPendingInvites item).
type InviteRecord struct {
	ID              string
	InvitedEmail    string
	InvitedByUserID string
	Role            string
	Status          string
	ExpiresAt       time.Time
	CreatedAt       time.Time
}

// CreatedInvite is the create-invite response projection (TS createInvite)
// plus the mail-resolved names (TS inviter?.name || "Someone" and the
// workspace name) so delivery never needs a second read.
type CreatedInvite struct {
	ID           string
	InvitedEmail string
	Role         string
	ExpiresAt    time.Time
	// Token carries the one-time raw secret for the email the caller just
	// triggered. It never persists and never appears in any list response.
	Token string
	// InvitedByName / WorkspaceName feed the invitation email greeting.
	InvitedByName string
	WorkspaceName string
}

// InviteAcceptResult mirrors the TS { serverId, serverName } body.
type InviteAcceptResult struct {
	ServerID   string
	ServerName string
}

// requireInviteManager revalidates the inviteMembers capability inside the
// caller's transaction. Guests are already rejected by the transport
// management-surface guard; here the role read is the live one.
func (s *Store) requireInviteManager(ctx context.Context, ex executor, workspaceID, userID, forbidden string) error {
	role, err := s.memberRole(ctx, ex, workspaceID, userID)
	if err != nil {
		return err
	}
	if !CanManage(role) {
		return &DomainError{Code: CodeForbidden, Message: forbidden}
	}
	return nil
}

// CreateJoinLink inserts one multi-use join link after the transactional
// capability revalidation and returns the raw token with its record.
func (s *Store) CreateJoinLink(ctx context.Context, workspaceID, userID string, opts JoinLinkOptions) (string, JoinLinkRecord, error) {
	if opts.MaxUses != nil {
		if msg := ValidateJoinLinkMaxUses(*opts.MaxUses); msg != "" {
			return "", JoinLinkRecord{}, &DomainError{Code: CodeInvalidInput, Message: msg}
		}
	}
	token, err := newJoinLinkToken()
	if err != nil {
		return "", JoinLinkRecord{}, err
	}
	var record JoinLinkRecord
	err = s.withTx(ctx, func(tx *sql.Tx) error {
		if err := s.requireInviteManager(ctx, tx, workspaceID, userID, errOnlyAdminCreateLinks); err != nil {
			return err
		}
		var exists bool
		if err := tx.QueryRowContext(ctx,
			`SELECT EXISTS(SELECT 1 FROM workspaces WHERE id = ? AND deleted_at IS NULL AND kind <> 'joint_storage')`,
			workspaceID).Scan(&exists); err != nil {
			return err
		}
		if !exists {
			return &DomainError{Code: CodeNotFound, Message: "Server not found"}
		}
		id, err := newUUID()
		if err != nil {
			return err
		}
		nowMS := s.now().UnixMilli()
		var expiresAt any
		if opts.ExpiresAt != nil {
			expiresAt = opts.ExpiresAt.UnixMilli()
		}
		var maxUses any
		if opts.MaxUses != nil {
			maxUses = *opts.MaxUses
		}
		if _, err := tx.ExecContext(ctx, `
			INSERT INTO workspace_join_links
				(id, workspace_id, created_by_user_id, token, token_digest, created_at, expires_at, max_uses, use_count)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)`,
			id, workspaceID, userID, token, inviteTokenDigest(token), nowMS, expiresAt, maxUses); err != nil {
			return err
		}
		record, err = scanJoinLink(tx.QueryRowContext(ctx, `SELECT `+joinLinkColumns+`
			FROM workspace_join_links WHERE id = ?`, id))
		return err
	})
	if err != nil {
		return "", JoinLinkRecord{}, err
	}
	return token, record, nil
}

// joinLinkColumns is the full row projection.
const joinLinkColumns = `id, token, created_at, expires_at, max_uses, use_count, revoked_at`

func scanJoinLink(scanner interface{ Scan(dest ...any) error }) (JoinLinkRecord, error) {
	var r JoinLinkRecord
	var expiresAt, revokedAt sql.NullInt64
	var maxUses sql.NullInt64
	var createdAt int64
	if err := scanner.Scan(&r.ID, &r.Token, &createdAt, &expiresAt, &maxUses, &r.UseCount, &revokedAt); err != nil {
		return JoinLinkRecord{}, err
	}
	r.CreatedAt = time.UnixMilli(createdAt).UTC()
	if expiresAt.Valid {
		t := time.UnixMilli(expiresAt.Int64).UTC()
		r.ExpiresAt = &t
	}
	if maxUses.Valid {
		v := maxUses.Int64
		r.MaxUses = &v
	}
	if revokedAt.Valid {
		t := time.UnixMilli(revokedAt.Int64).UTC()
		r.RevokedAt = &t
	}
	return r, nil
}

// joinLinkEligible reports whether the link is still usable at nowMS.
func joinLinkEligible(r JoinLinkRecord, nowMS int64) bool {
	if r.RevokedAt != nil {
		return false
	}
	if r.ExpiresAt != nil && r.ExpiresAt.UnixMilli() <= nowMS {
		return false
	}
	if r.MaxUses != nil && r.UseCount >= *r.MaxUses {
		return false
	}
	return true
}

// ListJoinLinks returns the active links (revoked/expired/exhausted hidden),
// newest first, after the transactional capability revalidation.
func (s *Store) ListJoinLinks(ctx context.Context, workspaceID, userID string) ([]JoinLinkRecord, error) {
	var links []JoinLinkRecord
	err := s.withTx(ctx, func(tx *sql.Tx) error {
		if err := s.requireInviteManager(ctx, tx, workspaceID, userID, errOnlyAdminViewLinks); err != nil {
			return err
		}
		rows, err := tx.QueryContext(ctx, `SELECT `+joinLinkColumns+`
			FROM workspace_join_links
			WHERE workspace_id = ? AND revoked_at IS NULL
			ORDER BY created_at DESC, id DESC`, workspaceID)
		if err != nil {
			return err
		}
		defer rows.Close()
		nowMS := s.now().UnixMilli()
		links = []JoinLinkRecord{}
		for rows.Next() {
			link, err := scanJoinLink(rows)
			if err != nil {
				return err
			}
			if joinLinkEligible(link, nowMS) {
				links = append(links, link)
			}
		}
		return rows.Err()
	})
	if err != nil {
		return nil, err
	}
	return links, nil
}

// RevokeJoinLink tombstones one link of THIS workspace. A link id from a
// different workspace matches no row and stays untouched (cross-workspace
// isolation); like the TS service the outcome is an idempotent ok.
func (s *Store) RevokeJoinLink(ctx context.Context, workspaceID, userID, linkID string) error {
	return s.withTx(ctx, func(tx *sql.Tx) error {
		if err := s.requireInviteManager(ctx, tx, workspaceID, userID, errOnlyAdminRevokeLinks); err != nil {
			return err
		}
		_, err := tx.ExecContext(ctx, `
			UPDATE workspace_join_links SET revoked_at = ?
			WHERE id = ? AND workspace_id = ? AND revoked_at IS NULL`,
			s.now().UnixMilli(), linkID, workspaceID)
		return err
	})
}

// CreateEmailInvite validates and stores one email-bound invite. The raw
// token is returned once for the triggered delivery; only its digest
// persists. Existing-but-expired pending invites for the same address are
// replaced, exactly like the TS service.
func (s *Store) CreateEmailInvite(ctx context.Context, workspaceID, userID, invitedEmail, role string) (CreatedInvite, error) {
	if role != RoleMember && role != RoleGuest {
		return CreatedInvite{}, &DomainError{Code: CodeInvalidInput, Message: errInvalidInvitableRol}
	}
	// Frozen M3 guest gate (TS SERVER_GUEST_FEATURE_FLAG_KEY disabled): the
	// refusal runs inside the transaction, so it holds even when a caller
	// bypasses the transport precheck. No silent member downgrade.
	if role == RoleGuest {
		return CreatedInvite{}, &DomainError{Code: CodeInvalidInput, Message: MsgGuestAccessDisabled}
	}
	if msg := ValidateInviteEmail(invitedEmail); msg != "" {
		return CreatedInvite{}, &DomainError{Code: CodeInvalidInput, Message: msg}
	}
	email := inviteNormalizedEmail(invitedEmail)
	token, err := newInviteToken()
	if err != nil {
		return CreatedInvite{}, err
	}
	var created CreatedInvite
	err = s.withTx(ctx, func(tx *sql.Tx) error {
		if err := s.requireInviteManager(ctx, tx, workspaceID, userID, errOnlyAdminSendInvite); err != nil {
			return err
		}
		// A workspace that vanished is not an invitation target.
		var workspaceExists bool
		if err := tx.QueryRowContext(ctx,
			`SELECT EXISTS(SELECT 1 FROM workspaces WHERE id = ? AND deleted_at IS NULL AND kind <> 'joint_storage')`,
			workspaceID).Scan(&workspaceExists); err != nil {
			return err
		}
		if !workspaceExists {
			return &DomainError{Code: CodeNotFound, Message: "Server not found"}
		}
		// Existing account with this address must not already be a member.
		var existingUserID string
		err := tx.QueryRowContext(ctx, `SELECT id FROM users WHERE email = ?`, email).Scan(&existingUserID)
		if err == nil {
			var member bool
			if err := tx.QueryRowContext(ctx,
				`SELECT EXISTS(SELECT 1 FROM workspace_memberships WHERE workspace_id = ? AND user_id = ?)`,
				workspaceID, existingUserID).Scan(&member); err != nil {
				return err
			}
			if member {
				return &DomainError{Code: CodeConflict, Message: errUserAlreadyMember}
			}
		} else if !errors.Is(err, sql.ErrNoRows) {
			return err
		}
		// One live invite per address: an expired pending row is replaced.
		var pendingID string
		var pendingExpires int64
		err = tx.QueryRowContext(ctx, `
			SELECT id, expires_at FROM workspace_invites
			WHERE workspace_id = ? AND invited_email = ? AND status = 'pending'
			ORDER BY created_at DESC LIMIT 1`, workspaceID, email).Scan(&pendingID, &pendingExpires)
		if err == nil {
			if pendingExpires > s.now().UnixMilli() {
				return &DomainError{Code: CodeConflict, Message: errInviteAlreadySent}
			}
			if _, err := tx.ExecContext(ctx, `DELETE FROM workspace_invites WHERE id = ?`, pendingID); err != nil {
				return err
			}
		} else if !errors.Is(err, sql.ErrNoRows) {
			return err
		}
		id, err := newUUID()
		if err != nil {
			return err
		}
		now := s.now()
		expiresAt := now.Add(InviteEmailTTL)
		if _, err := tx.ExecContext(ctx, `
			INSERT INTO workspace_invites
				(id, workspace_id, invited_email, invited_by_user_id, role, token_digest, status, expires_at, created_at)
			VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
			id, workspaceID, email, userID, role, inviteTokenDigest(token), expiresAt.UnixMilli(), now.UnixMilli()); err != nil {
			return err
		}
		invitedByName := "Someone"
		var inviterHandle string
		if err := tx.QueryRowContext(ctx,
			`SELECT name FROM users WHERE id = ?`, userID).Scan(&inviterHandle); err == nil && inviterHandle != "" {
			invitedByName = inviterHandle
		} else if err != nil && !errors.Is(err, sql.ErrNoRows) {
			return err
		}
		workspaceName, err := s.liveWorkspaceName(ctx, tx, workspaceID)
		if err != nil {
			return err
		}
		created = CreatedInvite{
			ID: id, InvitedEmail: email, Role: role, ExpiresAt: expiresAt, Token: token,
			InvitedByName: invitedByName, WorkspaceName: workspaceName,
		}
		return nil
	})
	if err != nil {
		return CreatedInvite{}, err
	}
	return created, nil
}

// ListPendingInvites returns the still-usable email invites, oldest first
// (the TS service returns the raw pending scan; ordering by creation keeps
// the list deterministic), after the transactional capability revalidation.
func (s *Store) ListPendingInvites(ctx context.Context, workspaceID, userID string) ([]InviteRecord, error) {
	var invites []InviteRecord
	err := s.withTx(ctx, func(tx *sql.Tx) error {
		if err := s.requireInviteManager(ctx, tx, workspaceID, userID, errOnlyAdminViewInvite); err != nil {
			return err
		}
		rows, err := tx.QueryContext(ctx, `
			SELECT id, invited_email, invited_by_user_id, role, status, expires_at, created_at
			FROM workspace_invites
			WHERE workspace_id = ? AND status = 'pending' AND expires_at > ?
			ORDER BY created_at ASC, id ASC`, workspaceID, s.now().UnixMilli())
		if err != nil {
			return err
		}
		defer rows.Close()
		invites = []InviteRecord{}
		for rows.Next() {
			var inv InviteRecord
			var expiresAt, createdAt int64
			if err := rows.Scan(&inv.ID, &inv.InvitedEmail, &inv.InvitedByUserID, &inv.Role,
				&inv.Status, &expiresAt, &createdAt); err != nil {
				return err
			}
			inv.ExpiresAt = time.UnixMilli(expiresAt).UTC()
			inv.CreatedAt = time.UnixMilli(createdAt).UTC()
			invites = append(invites, inv)
		}
		return rows.Err()
	})
	if err != nil {
		return nil, err
	}
	return invites, nil
}

// RevokeInvite deletes one pending invite of THIS workspace (TS semantics).
// An invite id from a different workspace matches no row; the response stays
// the idempotent ok.
func (s *Store) RevokeInvite(ctx context.Context, workspaceID, userID, inviteID string) error {
	return s.withTx(ctx, func(tx *sql.Tx) error {
		if err := s.requireInviteManager(ctx, tx, workspaceID, userID, errOnlyAdminRevokeInvit); err != nil {
			return err
		}
		_, err := tx.ExecContext(ctx, `
			DELETE FROM workspace_invites WHERE id = ? AND workspace_id = ?`, inviteID, workspaceID)
		return err
	})
}

// InviteInfo is the public pre-accept preview (TS InviteInfo). The token
// itself is the capability; the payload leaks no management data: counts
// follow the workspace's hide-inside-counts policy and there is no local
// billing/agreement provider, so those fields report their honest values.
type InviteInfo struct {
	Kind                  string // "email" | "join_link"
	ServerName            string
	InviterName           *string // join links: null when the creator vanished
	MemberCount           int64
	AgentCount            int64
	InsideCountsHidden    bool
	HumanSeatLimitReached bool
	HumanSeatLimitMessage *string
	Agreement             any // always nil: no agreement provider in this phase
}

// InviteInfo resolves one token for the public accept page. Invalid, used,
// revoked, expired or exhausted tokens — and tokens whose workspace is gone —
// all collapse to the single legacy "not found" answer so the preview leaks
// nothing beyond what a valid link already shows.
func (s *Store) InviteInfo(ctx context.Context, token string) (*InviteInfo, error) {
	digest := inviteTokenDigest(token)
	nowMS := s.now().UnixMilli()

	// Email invites win the shared token space, exactly like the TS service.
	var inviteWorkspace, invitedBy string
	var inviteExpires int64
	err := s.db.QueryRowContext(ctx, `
		SELECT workspace_id, invited_by_user_id, expires_at
		FROM workspace_invites WHERE token_digest = ? AND status = 'pending'`, digest).
		Scan(&inviteWorkspace, &invitedBy, &inviteExpires)
	switch {
	case err == nil:
		if inviteExpires <= nowMS {
			return nil, nil
		}
		return s.inviteInfoFor(ctx, "email", inviteWorkspace, invitedBy)
	case errors.Is(err, sql.ErrNoRows):
		// fall through to join links
	default:
		return nil, err
	}

	var linkWorkspace, createdBy string
	err = s.db.QueryRowContext(ctx, `
		SELECT workspace_id, created_by_user_id
		FROM workspace_join_links WHERE token_digest = ?`, digest).
		Scan(&linkWorkspace, &createdBy)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	var expiresAt, revokedAt sql.NullInt64
	var maxUses, useCount sql.NullInt64
	if err := s.db.QueryRowContext(ctx, `
		SELECT expires_at, max_uses, use_count, revoked_at
		FROM workspace_join_links WHERE token_digest = ?`, digest).
		Scan(&expiresAt, &maxUses, &useCount, &revokedAt); err != nil {
		return nil, err
	}
	if revokedAt.Valid ||
		(expiresAt.Valid && expiresAt.Int64 <= nowMS) ||
		(maxUses.Valid && useCount.Int64 >= maxUses.Int64) {
		return nil, nil
	}
	return s.inviteInfoFor(ctx, "join_link", linkWorkspace, createdBy)
}

// inviteInfoFor builds the preview for a resolved workspace + inviter.
func (s *Store) inviteInfoFor(ctx context.Context, kind, workspaceID, inviterUserID string) (*InviteInfo, error) {
	var name string
	var hideHumans int
	var deletedAt sql.NullInt64
	var kindCol string
	err := s.db.QueryRowContext(ctx, `
		SELECT name, hide_humans_from_members, deleted_at, kind
		FROM workspaces WHERE id = ?`, workspaceID).
		Scan(&name, &hideHumans, &deletedAt, &kindCol)
	if errors.Is(err, sql.ErrNoRows) || (err == nil && (deletedAt.Valid || kindCol == "joint_storage")) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	var inviterHandle sql.NullString
	if err := s.db.QueryRowContext(ctx,
		`SELECT name FROM users WHERE id = ?`, inviterUserID).Scan(&inviterHandle); err != nil && !errors.Is(err, sql.ErrNoRows) {
		return nil, err
	}
	info := &InviteInfo{
		Kind:               kind,
		ServerName:         name,
		InsideCountsHidden: hideHumans != 0,
		Agreement:          nil,
	}
	// TS: email invites always show an inviter ("Someone" as fallback); join
	// links show null only when the creator row cannot be named.
	inviter := inviterHandle.String
	if inviter == "" {
		inviter = "Someone"
	}
	info.InviterName = &inviter
	if kind == "join_link" && !inviterHandle.Valid {
		info.InviterName = nil
	}
	if info.InsideCountsHidden {
		// The workspace hides its roster: keep both counts at the TS zero
		// projection instead of leaking real numbers.
		return info, nil
	}
	if err := s.db.QueryRowContext(ctx,
		`SELECT COUNT(*) FROM workspace_memberships WHERE workspace_id = ?`, workspaceID).
		Scan(&info.MemberCount); err != nil {
		return nil, err
	}
	if err := s.db.QueryRowContext(ctx,
		`SELECT COUNT(*) FROM agents WHERE workspace_id = ? AND deleted_at IS NULL`, workspaceID).
		Scan(&info.AgentCount); err != nil {
		return nil, err
	}
	return info, nil
}

// AcceptInvite performs the transactional, idempotent join for one token:
//   - email invite: pending + unexpired + the caller's account email bound to
//     the invited address; consumes the invite (status accepted) exactly when
//     the membership insert commits;
//   - join link: the membership insert and the guarded use-count increment
//     share one transaction, so revocation/expiry/exhaustion happening before
//     the commit cancels the join instead of over-admitting;
//   - join links are CONDITIONALLY idempotent: a caller who is already a
//     member of the target workspace succeeds again without consuming a use
//     (TS joinedThisServer=false path); email invites are strictly
//     single-use — the same token never joins anyone twice, not even the
//     accepting account ("This invite has already been used").
func (s *Store) AcceptInvite(ctx context.Context, token, userID string) (InviteAcceptResult, error) {
	digest := inviteTokenDigest(token)
	var result InviteAcceptResult
	err := s.withTx(ctx, func(tx *sql.Tx) error {
		nowMS := s.now().UnixMilli()

		var inviteID, inviteWorkspace, invitedEmail, inviteRole string
		var inviteExpires int64
		err := tx.QueryRowContext(ctx, `
			SELECT id, workspace_id, invited_email, role, expires_at
			FROM workspace_invites WHERE token_digest = ?`, digest).
			Scan(&inviteID, &inviteWorkspace, &invitedEmail, &inviteRole, &inviteExpires)
		switch {
		case err == nil:
			return s.acceptEmailInvite(ctx, tx, acceptEmailInviteInput{
				inviteID: inviteID, workspaceID: inviteWorkspace, invitedEmail: invitedEmail,
				role: inviteRole, expiresAtMS: inviteExpires, nowMS: nowMS,
			}, userID, &result)
		case errors.Is(err, sql.ErrNoRows):
			// fall through to join links
		default:
			return err
		}

		var linkID, linkWorkspace string
		err = tx.QueryRowContext(ctx, `
			SELECT id, workspace_id FROM workspace_join_links WHERE token_digest = ?`, digest).
			Scan(&linkID, &linkWorkspace)
		if errors.Is(err, sql.ErrNoRows) {
			return &DomainError{Code: CodeNotFound, Message: errInvalidInviteToken}
		}
		if err != nil {
			return err
		}
		return s.acceptJoinLink(ctx, tx, linkID, linkWorkspace, userID, nowMS, &result)
	})
	if err != nil {
		return InviteAcceptResult{}, err
	}
	return result, nil
}

type acceptEmailInviteInput struct {
	inviteID     string
	workspaceID  string
	invitedEmail string
	role         string
	expiresAtMS  int64
	nowMS        int64
}

func (s *Store) acceptEmailInvite(ctx context.Context, tx *sql.Tx, in acceptEmailInviteInput, userID string, result *InviteAcceptResult) error {
	var status string
	if err := tx.QueryRowContext(ctx,
		`SELECT status FROM workspace_invites WHERE id = ?`, in.inviteID).Scan(&status); err != nil {
		return err
	}
	if status != "pending" {
		return &DomainError{Code: CodeInvalidInput, Message: errInviteAlreadyUsed}
	}
	if in.expiresAtMS <= in.nowMS {
		if _, err := tx.ExecContext(ctx,
			`UPDATE workspace_invites SET status = 'expired' WHERE id = ?`, in.inviteID); err != nil {
			return err
		}
		return &DomainError{Code: CodeInvalidInput, Message: errInviteExpired}
	}
	// Frozen M3 guest gate applies to previously persisted guest invites too:
	// a row minted under an earlier policy cannot hand out guest access now.
	// The refusal is explicit and leaves the row untouched (still pending,
	// revocable); it is never downgraded into a member join.
	if in.role == RoleGuest {
		return &DomainError{Code: CodeInvalidInput, Message: MsgGuestAccessDisabled}
	}
	// Email binding: the accepter's account email must match the invited
	// address under the shared normalization.
	var accountEmail string
	err := tx.QueryRowContext(ctx, `SELECT email FROM users WHERE id = ?`, userID).Scan(&accountEmail)
	if errors.Is(err, sql.ErrNoRows) {
		return &DomainError{Code: CodeInvalidInput, Message: errInviteDifferentEmail}
	}
	if err != nil {
		return err
	}
	if inviteNormalizedEmail(accountEmail) != inviteNormalizedEmail(in.invitedEmail) {
		return &DomainError{Code: CodeInvalidInput, Message: errInviteDifferentEmail}
	}
	serverName, err := s.liveWorkspaceName(ctx, tx, in.workspaceID)
	if err != nil {
		return err
	}
	if member, err := s.isMemberTx(ctx, tx, in.workspaceID, userID); err != nil {
		return err
	} else if member {
		return &DomainError{Code: CodeInvalidInput, Message: errAlreadyMember}
	}
	// Race-safe insert: a concurrent admin-add wins the PK and this invite
	// still closes as accepted, mirroring the TS onConflictDoNothing path.
	inserted, err := insertJoinedMemberTx(ctx, tx, in.workspaceID, userID, in.role, in.nowMS)
	if err != nil {
		return err
	}
	if inserted {
		if err := s.insertInviteAgreementAudit(ctx, tx, in.workspaceID, userID, in.nowMS, "invite"); err != nil {
			return err
		}
	}
	if _, err := tx.ExecContext(ctx,
		`UPDATE workspace_invites SET status = 'accepted' WHERE id = ?`, in.inviteID); err != nil {
		return err
	}
	*result = InviteAcceptResult{ServerID: in.workspaceID, ServerName: serverName}
	return nil
}

func (s *Store) acceptJoinLink(ctx context.Context, tx *sql.Tx, linkID, workspaceID, userID string, nowMS int64, result *InviteAcceptResult) error {
	var expiresAt, revokedAt sql.NullInt64
	var maxUses, useCount sql.NullInt64
	if err := tx.QueryRowContext(ctx, `
		SELECT expires_at, max_uses, use_count, revoked_at
		FROM workspace_join_links WHERE id = ?`, linkID).
		Scan(&expiresAt, &maxUses, &useCount, &revokedAt); err != nil {
		return err
	}
	switch {
	case revokedAt.Valid:
		return &DomainError{Code: CodeInvalidInput, Message: errInviteRevoked}
	case expiresAt.Valid && expiresAt.Int64 <= nowMS:
		return &DomainError{Code: CodeInvalidInput, Message: errInviteExpired}
	case maxUses.Valid && useCount.Int64 >= maxUses.Int64:
		return &DomainError{Code: CodeInvalidInput, Message: errInviteExhausted}
	}
	serverName, err := s.liveWorkspaceName(ctx, tx, workspaceID)
	if err != nil {
		return err
	}
	inserted, err := insertJoinedMemberTx(ctx, tx, workspaceID, userID, RoleMember, nowMS)
	if err != nil {
		return err
	}
	if inserted {
		if err := s.insertInviteAgreementAudit(ctx, tx, workspaceID, userID, nowMS, "join"); err != nil {
			return err
		}
		// Guarded consumption: revocation, expiry or exhaustion committed by
		// anyone else between the read above and this write cancels the join.
		res, err := tx.ExecContext(ctx, `
			UPDATE workspace_join_links SET use_count = use_count + 1
			WHERE id = ? AND revoked_at IS NULL
			  AND (expires_at IS NULL OR expires_at > ?)
			  AND (max_uses IS NULL OR use_count < max_uses)`, linkID, nowMS)
		if err != nil {
			return err
		}
		affected, err := res.RowsAffected()
		if err != nil {
			return err
		}
		if affected == 0 {
			var expiresNow, revokedNow sql.NullInt64
			var maxNow, usedNow sql.NullInt64
			if err := tx.QueryRowContext(ctx, `
				SELECT expires_at, max_uses, use_count, revoked_at
				FROM workspace_join_links WHERE id = ?`, linkID).
				Scan(&expiresNow, &maxNow, &usedNow, &revokedNow); err != nil {
				return err
			}
			switch {
			case revokedNow.Valid:
				return &DomainError{Code: CodeInvalidInput, Message: errInviteRevoked}
			case expiresNow.Valid && expiresNow.Int64 <= nowMS:
				return &DomainError{Code: CodeInvalidInput, Message: errInviteExpired}
			case maxNow.Valid && usedNow.Int64 >= maxNow.Int64:
				return &DomainError{Code: CodeInvalidInput, Message: errInviteExhausted}
			default:
				return &DomainError{Code: CodeInvalidInput, Message: errInviteNoLongerValid}
			}
		}
	}
	// Not inserted: the caller was already a member — success without
	// consuming a use (idempotent join, TS joinedThisServer=false path).
	*result = InviteAcceptResult{ServerID: workspaceID, ServerName: serverName}
	return nil
}

// liveWorkspaceName resolves the live workspace or answers the legacy
// "no longer exists" sentence.
func (s *Store) liveWorkspaceName(ctx context.Context, ex executor, workspaceID string) (string, error) {
	var name string
	var deletedAt sql.NullInt64
	var kind string
	err := ex.QueryRowContext(ctx, `
		SELECT name, deleted_at, kind FROM workspaces WHERE id = ?`, workspaceID).
		Scan(&name, &deletedAt, &kind)
	if errors.Is(err, sql.ErrNoRows) || (err == nil && (deletedAt.Valid || kind == "joint_storage")) {
		return "", &DomainError{Code: CodeNotFound, Message: errServerNoLongerExists}
	}
	if err != nil {
		return "", err
	}
	return name, nil
}

// isMemberTx reports a current membership inside the caller's transaction.
func (s *Store) isMemberTx(ctx context.Context, ex executor, workspaceID, userID string) (bool, error) {
	var member bool
	err := ex.QueryRowContext(ctx,
		`SELECT EXISTS(SELECT 1 FROM workspace_memberships WHERE workspace_id = ? AND user_id = ?)`,
		workspaceID, userID).Scan(&member)
	return member, err
}

// insertJoinedMemberTx inserts the full membership slice a usable joined
// member needs, atomically: the membership row itself, the per-member setup
// row (same 'not_started' v2 contract workspace creation writes for the
// owner) and the per-member preferences row (GET sidebar-order and
// onboarding-settings answer integrity-drift 404s when it is missing).
// False means the (workspace, user) membership already existed and nothing
// was written — join-link accepts use that to skip use consumption.
func insertJoinedMemberTx(ctx context.Context, tx *sql.Tx, workspaceID, userID, role string, nowMS int64) (bool, error) {
	res, err := tx.ExecContext(ctx, `
		INSERT INTO workspace_memberships (workspace_id, user_id, role, server_push_muted, joined_at)
		VALUES (?, ?, ?, 0, ?)
		ON CONFLICT (workspace_id, user_id) DO NOTHING`, workspaceID, userID, role, nowMS)
	if err != nil {
		return false, err
	}
	affected, err := res.RowsAffected()
	if err != nil {
		return false, err
	}
	if affected == 0 {
		return false, nil
	}
	if _, err := tx.ExecContext(ctx, `
		INSERT INTO workspace_member_setup (workspace_id, user_id, status, completion_reason, contract_version)
		VALUES (?, ?, 'not_started', NULL, 'onboarding-setup-v2')
		ON CONFLICT (workspace_id, user_id) DO NOTHING`, workspaceID, userID); err != nil {
		return false, err
	}
	if _, err := tx.ExecContext(ctx, `
		INSERT INTO workspace_member_preferences (workspace_id, user_id)
		VALUES (?, ?)
		ON CONFLICT (workspace_id, user_id) DO NOTHING`, workspaceID, userID); err != nil {
		return false, err
	}
	return true, nil
}

// insertInviteAgreementAudit records the self-serve join fact: no agreement
// exists in this phase, so agreement columns stay NULL — never fabricated.
func (s *Store) insertInviteAgreementAudit(ctx context.Context, tx *sql.Tx, workspaceID, userID string, nowMS int64, source string) error {
	id, err := newUUID()
	if err != nil {
		return err
	}
	_, err = tx.ExecContext(ctx, `
		INSERT INTO workspace_membership_agreement_audit
			(id, workspace_id, subject_type, subject_id, agreement_id, agreement_version,
			 actor_user_id, source, ip_address, user_agent, created_at)
		VALUES (?, ?, 'user', ?, NULL, NULL, ?, ?, NULL, NULL, ?)`,
		id, workspaceID, userID, userID, source, nowMS)
	return err
}
