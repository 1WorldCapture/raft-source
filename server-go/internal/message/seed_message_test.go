package message

import (
	"context"
	"database/sql"

	"raft.local/server-go/internal/auth"
)

// CreateTx is deliberately TEST-ONLY: domain/crash fixtures sometimes need
// facts and intents without a complete human use case. It is not compiled
// into the production Store API. Production sends use messaging.SendHuman,
// which owns the intervening thread-follow/read step and idempotent replay.
func (s *Store) CreateTx(ctx context.Context, tx *sql.Tx, claims auth.AccessTokenClaims, workspaceID string, input CreateInput) (*CreateResult, error) {
	created, err := s.CreateMessageTx(ctx, tx, claims, workspaceID, input)
	if err != nil {
		return nil, err
	}
	if err := s.RecordSendPublicationsTx(ctx, tx, workspaceID, created); err != nil {
		return nil, err
	}
	return created, nil
}
