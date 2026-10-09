// Package messaging owns the complete human messaging use cases: sending a
// message (with the thread-reply read advance), creating threads with their
// optional first reply, thread follow/unfollow interest, and the DM
// list/create exits' cross-module orchestration. Every mutation runs in ONE
// shared write transaction with the verified identity revalidated inside;
// every authenticated read runs on ONE pinned read snapshot. The channel
// facts stay channel-owned, the read algorithm stays readstate-owned, and
// this package only decides the order — it never writes another module's
// tables directly.
package messaging

import (
	"context"
	"database/sql"
	"errors"

	"raft.local/server-go/internal/agent"
	"raft.local/server-go/internal/auth"
	"raft.local/server-go/internal/channel"
	"raft.local/server-go/internal/delivery"
	"raft.local/server-go/internal/message"
	platformdb "raft.local/server-go/internal/platform/db"
	"raft.local/server-go/internal/readstate"
)

// Service is the complete human messaging use-case entry point. The fact
// owners are captured at construction and are immutable afterwards — no
// public field can rewire identity, transaction or read policy on a live
// service.
type Service struct {
	channels  *channel.Store
	messages  *message.Store
	readstate *readstate.Store
	// delivery and principals are frozen at construction from the same
	// database: A's real delivery.Store and C's real agent.Store. There is
	// no nil, no-op, or post-construction replacement.
	delivery   DeliveryPlanner
	principals AgentPrincipalValidator
}

// NewService validates the required fact owners and freezes the real
// delivery planner and agent principal validator on that same database.
// The signature stays the three fact owners so existing callers keep
// compiling; both M5 dependencies are constructed here, not injected later.
func NewService(channels *channel.Store, messages *message.Store, readstate *readstate.Store) (*Service, error) {
	if channels == nil || messages == nil || readstate == nil {
		return nil, errors.New("messaging: channels, messages and readstate fact owners are required")
	}
	if channels.DB() == nil || messages.DB() != channels.DB() || readstate.DB() != channels.DB() {
		return nil, errors.New("messaging: fact owners must share one application database")
	}
	handle := channels.DB()
	return &Service{
		channels:   channels,
		messages:   messages,
		readstate:  readstate,
		delivery:   delivery.NewStore(handle),
		principals: agent.NewStore(handle, agent.StoreOptions{}),
	}, nil
}

// SendHuman is the ONLY complete human send entry: identity revalidation,
// shape validation, unsupported-effect rejection, posting authority,
// random-id idempotency, mention resolution, message fact, thread follows
// and publication intents commit atomically — and a NEW thread reply also
// advances the author's own read frontier in the SAME commit (the original
// pipeline pairs the replied auto-follow with markReadLatest). A randomId
// replay returns the original message without re-following, re-reading or
// emitting any new publication.
func (s *Service) SendHuman(ctx context.Context, claims auth.AccessTokenClaims, workspaceID string, input message.CreateInput) (*message.CreateResult, error) {
	var result *message.CreateResult
	err := platformdb.WithWriteTx(ctx, s.messages.DB(), func(tx *sql.Tx) error {
		created, err := s.sendHumanTx(ctx, tx, claims, workspaceID, input)
		if err != nil {
			return err
		}
		result = created
		return nil
	})
	if err != nil {
		return nil, err
	}
	return result, nil
}

// sendHumanTx is the transaction-bound send step shared by SendHuman and the
// thread-initial-content use case (one db.WithWriteTx; never a nested
// top-level mutation).
func (s *Service) sendHumanTx(ctx context.Context, tx *sql.Tx, claims auth.AccessTokenClaims, workspaceID string, input message.CreateInput) (*message.CreateResult, error) {
	created, err := s.messages.CreateMessageTx(ctx, tx, claims, workspaceID, input)
	if err != nil {
		return nil, err
	}
	// The mandatory receipt intents join the same commit right after the
	// message and mention facts (resolved agent mentions, plus the canonical
	// human-Agent DM peer through the frozen implicit-receipt rule). A replay
	// records nothing; a planning failure rolls the whole send back — no
	// message can commit without its required receipt intents.
	if !created.Replayed {
		if err := s.planAgentDeliveriesTx(ctx, tx, workspaceID, created); err != nil {
			return nil, err
		}
	}
	// A NEW human thread reply advances the REPLIER's own read frontier in
	// the same commit; a replay (Replayed=true, ThreadReply=false) never
	// re-advances it.
	if created.ThreadReply && !created.Replayed {
		if _, err := s.readstate.MarkReadLatestTx(ctx, tx, claims, workspaceID, created.Message.ChannelID); err != nil {
			return nil, err
		}
	}
	// The publication intents join the same commit AFTER the read advance,
	// matching the original send path's durable row order (read_state and
	// unread_summary wakes, then message:new, then thread:updated). A replay
	// records nothing.
	if err := s.messages.RecordSendPublicationsTx(ctx, tx, workspaceID, created); err != nil {
		return nil, err
	}
	return created, nil
}

// readCursor adapts the readstate-owned viewer cursor for channel-owned
// thread projections; the caller has already authorized the conversation on
// the supplied snapshot, so no second authority snapshot is acquired.
func (s *Service) readCursor(ctx context.Context, ex channel.Executor, workspaceID, userID, channelID string) (int64, error) {
	return s.readstate.ReadCursorTx(ctx, ex, workspaceID, userID, channelID)
}

// dmReadState loads the #632 read frontier facts (InboxScopeReadFrontier
// union) for one DM row through the readstate-owned projection.
// DMReadFrontierTx fail-closes non-DM scopes, non-participants and foreign
// workspaces; the union rendering is a presenter concern.
func (s *Service) dmReadState(ctx context.Context, ex channel.Executor, workspaceID, userID, channelID string) (*readstate.ReadFrontier, error) {
	return s.readstate.DMReadFrontierTx(ctx, ex, workspaceID, userID, channelID)
}
