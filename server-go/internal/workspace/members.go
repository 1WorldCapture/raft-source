// Member directory reads (GET /api/servers/:id/members, M2 settings worker).
//
// Contract source: legacy TS getServerMembers + the members route
// (packages/server/src/routes/servers.ts:1795-1817, R15):
//   - guest callers are rejected by this endpoint itself (not only by the
//     management-surface middleware), with the exact legacy sentence;
//   - owner/admin requesters see every member email, ordinary members see only
//     their own, everyone else's email is null;
//   - gravatarHash is always computed from the member's real (trimmed,
//     lowercased) email, even when the email itself is hidden;
//   - hideHumansFromMembers=true limits an ordinary member's directory to the
//     requester alone; owner/admin keep the full management directory;
//   - rows are ordered by membership joinedAt (user_id is a deterministic
//     tie-breaker SQLite needs for identical join timestamps; the legacy TS
//     order for identical joinedAt values is not specified — registered as
//     non-semantic drift in the M2 report).
package workspace

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"strings"
	"time"
)

// ListMembers returns the human directory of one workspace as raw protocol
// maps. The transport layer serializes them verbatim ([] is a real answer).
func (s *Store) ListMembers(ctx context.Context, workspaceID, userID string) ([]map[string]any, error) {
	var requesterRole string
	var hideHumans bool
	err := s.db.QueryRowContext(ctx, `
		SELECT m.role, w.hide_humans_from_members
		FROM workspace_memberships m
		JOIN workspaces w ON w.id = m.workspace_id
		WHERE m.workspace_id = ? AND m.user_id = ? AND w.deleted_at IS NULL`,
		workspaceID, userID).Scan(&requesterRole, &hideHumans)
	if err == sql.ErrNoRows {
		// Legacy handlers answer a vanished workspace/membership with 404
		// "Server not found"; the 403 non-member shape belongs to the scope
		// middleware that runs before this domain call.
		return nil, &DomainError{Code: CodeNotFound, Message: "Server not found"}
	} else if err != nil {
		return nil, err
	}
	if requesterRole == "guest" {
		return nil, &DomainError{Code: CodeForbidden, Message: "Guests cannot access server management data"}
	}

	rows, err := s.db.QueryContext(ctx, `
		SELECT u.id, u.email, u.name, u.display_name, u.description, u.avatar_url,
		       m.role, m.joined_at
		FROM workspace_memberships m
		JOIN users u ON u.id = m.user_id
		WHERE m.workspace_id = ?
		ORDER BY m.joined_at ASC, m.user_id ASC`, workspaceID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	canSeeAllEmails := CanManage(requesterRole)
	hideDirectory := hideHumans && requesterRole == "member"
	out := []map[string]any{}
	for rows.Next() {
		var id, email, name, role string
		var displayName, description, avatarURL sql.NullString
		var joinedAt int64
		if err := rows.Scan(&id, &email, &name, &displayName, &description, &avatarURL, &role, &joinedAt); err != nil {
			return nil, err
		}
		if hideDirectory && id != userID {
			continue
		}
		var emailOut any
		if canSeeAllEmails || id == userID {
			emailOut = email
		}
		joined := time.UnixMilli(joinedAt).UTC().Format("2006-01-02T15:04:05.000Z")
		out = append(out, map[string]any{
			"userId":       id,
			"email":        emailOut,
			"name":         name,
			"displayName":  nullStringValue(displayName),
			"description":  nullStringValue(description),
			"avatarUrl":    nullStringValue(avatarURL),
			"role":         role,
			"joinedAt":     joined,
			"gravatarHash": memberGravatarHash(email),
		})
	}
	return out, rows.Err()
}

// memberGravatarHash mirrors the legacy sha256(trim+lowercase(email)) helper.
// It is computed from the real email regardless of email visibility.
func memberGravatarHash(email string) string {
	sum := sha256.Sum256([]byte(strings.ToLower(strings.TrimSpace(email))))
	return hex.EncodeToString(sum[:])
}

// nullStringValue maps a nullable column to a JSON-friendly value.
func nullStringValue(v sql.NullString) any {
	if v.Valid {
		return v.String
	}
	return nil
}
