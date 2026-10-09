package realtime

// Socket fact sources: the current-fact reads the socket transport needs at
// handshake, room setup, join authorization, resume and heartbeat. The
// transport never reads the database itself; it calls these methods and maps
// the classified results onto its protocol.

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"time"

	"raft.local/server-go/internal/auth"
	"raft.local/server-go/internal/channel"
	"raft.local/server-go/internal/message"
	"raft.local/server-go/internal/platform/db"
)

// Handshake classification: the transport maps these onto its protocol's
// token/session error answers.
var (
	ErrHandshakeInvalidToken = errors.New("realtime: invalid or expired token")
	ErrHandshakeWrongType    = errors.New("realtime: wrong token type")
	ErrHandshakeNotAMember   = errors.New("realtime: not a member of this workspace")
)

// ViewerIdentity is the verified connection identity: the user, the bound
// workspace, the session family and the token's own validity window.
type ViewerIdentity struct {
	UserID          string
	WorkspaceID     string
	SessionFamilyID string
	TokenIssuedAt   time.Time
	TokenExpiresAt  time.Time
}

// TokenProof is the token's own validity window (never a lookup of the
// newest token for the user).
type TokenProof struct {
	IssuedAt  time.Time
	ExpiresAt time.Time
}

// SocketFacts serves the socket transport's current-fact reads.
type SocketFacts struct {
	db       *sql.DB
	signer   *auth.TokenSigner
	channels *channel.Store
	messages *message.Store
}

// NewSocketFacts validates the required dependencies at construction.
func NewSocketFacts(handle *sql.DB, signer *auth.TokenSigner, channels *channel.Store, messages *message.Store) (*SocketFacts, error) {
	if handle == nil || signer == nil || channels == nil || messages == nil {
		return nil, errors.New("realtime: db, signer, channels and messages are required for socket facts")
	}
	return &SocketFacts{db: handle, signer: signer, channels: channels, messages: messages}, nil
}

// IdentifyToken decodes the JWT signature/type only (no database): the
// returned proof is THIS verified token's own IssuedAt/ExpiresAt. A refresh
// token keeps the client's refresh trigger.
func (f *SocketFacts) IdentifyToken(_ context.Context, token string) (subject, family string, proof TokenProof, err error) {
	claims, err := f.signer.VerifyAccessToken(token)
	if err != nil {
		switch {
		case errors.Is(err, auth.ErrTokenWrongType):
			return "", "", TokenProof{}, ErrHandshakeWrongType
		default:
			return "", "", TokenProof{}, ErrHandshakeInvalidToken
		}
	}
	return claims.Subject, claims.FamilyID,
		TokenProof{IssuedAt: claims.IssuedAt, ExpiresAt: claims.ExpiresAt}, nil
}

// Authenticate performs the database-backed validation on one pinned read
// snapshot: the exact token still belongs to a live, owned, non-revoked
// session family of a real verified user; a client-bound serverId must map
// to a current membership, whose role is returned for the connection
// identity.
func (f *SocketFacts) Authenticate(ctx context.Context, token string, serverID *string) (string, error) {
	claims, err := f.signer.VerifyAccessToken(token)
	if err != nil {
		return "", ErrHandshakeInvalidToken
	}
	role := ""
	err = db.WithReadSnapshot(ctx, f.db, func(ex db.Executor) error {
		if err := auth.ValidateHumanTx(ctx, ex, *claims, time.Now()); err != nil {
			return err
		}
		if serverID == nil {
			return nil
		}
		return ex.QueryRowContext(ctx, `SELECT m.role
			FROM workspace_memberships m
			JOIN workspaces w ON w.id = m.workspace_id
			WHERE m.workspace_id = ? AND m.user_id = ?
			  AND w.deleted_at IS NULL AND w.kind <> 'joint_storage'`,
			*serverID, claims.Subject).Scan(&role)
	})
	if err != nil {
		switch {
		case errors.Is(err, sql.ErrNoRows):
			return "", ErrHandshakeNotAMember
		case errors.Is(err, auth.ErrTokenInvalid):
			return "", ErrHandshakeInvalidToken
		default:
			// Infrastructure failures fail closed (the transport classifies
			// unknown as invalid/expired); the real cause travels up for logs.
			return "", fmt.Errorf("realtime handshake validation: %w", err)
		}
	}
	return role, nil
}

// SubscribedChannels resolves a freshly opened connection's authorized
// subscription set from CURRENT channel facts (the sync visibility rule:
// public server-wide, private/DM by roster, threads by active follow).
func (f *SocketFacts) SubscribedChannels(ctx context.Context, workspaceID, userID string) ([]string, error) {
	var ids []string
	err := db.WithReadSnapshot(ctx, f.db, func(ex db.Executor) error {
		var err error
		ids, err = f.channels.ListSubscriptionsTx(ctx, ex, workspaceID, userID)
		return err
	})
	if err != nil {
		return nil, err
	}
	return ids, nil
}

// CanJoin authorizes join:channel by base content authorization (a readable
// conversation may be subscribed for live updates; explicit join never
// writes a follow row). Fail-closed on every denial and error, silently to
// the client like the original.
func (f *SocketFacts) CanJoin(ctx context.Context, workspaceID, userID, channelID string) (bool, error) {
	allowed := false
	err := db.WithReadSnapshot(ctx, f.db, func(ex db.Executor) error {
		conv, err := f.channels.AuthorizeConversationTx(ctx, ex, workspaceID, channelID, userID, false)
		if err != nil {
			if channel.AsDomainError(err) != nil {
				return nil // authorization denial, not an infrastructure error
			}
			return err
		}
		allowed = conv != nil && conv.Channel != nil
		return nil
	})
	if err != nil {
		return false, err
	}
	return allowed, nil
}

// ResumeFacts is one sync:resume page's FACTS: the visible rows'
// projections, the honest coverage cursor and the has-more flag. The
// transport renders the wire envelope and applies the encoded-byte budget
// (the budget is defined over the wire form, so it belongs to the
// transport); this layer never encodes client wire.
type ResumeFacts struct {
	Projections []*message.Projection
	CurrentSeq  int64
	HasMore     bool
}

// ResumePage is one sync:resume page from the message worker's persistent
// read model with the EXACT claims frozen at admission (rebuilt from the
// verified token identity — a resume request body can never select another
// principal) and the original 500-message page cap.
func (f *SocketFacts) ResumePage(ctx context.Context, id ViewerIdentity, lastSeq int64, maxMessages int) (*ResumeFacts, error) {
	claims := message.NewClaims(auth.AccessTokenClaims{
		Subject:   id.UserID,
		Type:      "access",
		FamilyID:  id.SessionFamilyID,
		IssuedAt:  id.TokenIssuedAt,
		ExpiresAt: id.TokenExpiresAt,
	})
	if maxMessages <= 0 || maxMessages > message.ResumeLimit {
		maxMessages = message.ResumeLimit
	}
	result, err := f.messages.SyncVisibleMessages(ctx, claims, id.WorkspaceID, lastSeq, "", maxMessages)
	if err != nil {
		return nil, err
	}
	return &ResumeFacts{
		Projections: result.Projections,
		CurrentSeq:  result.CoveredThrough,
		HasMore:     result.HasMore,
	}, nil
}

// WorkspaceSeq supplies each workspace's committed message high-water — a
// gap-detection hint, never an ack or delivery cursor.
func (f *SocketFacts) WorkspaceSeq(ctx context.Context, workspaceID string) (int64, error) {
	var seq int64
	err := f.db.QueryRowContext(ctx,
		`SELECT COALESCE(MAX(seq),0) FROM messages WHERE workspace_id = ?`, workspaceID).Scan(&seq)
	return seq, err
}
