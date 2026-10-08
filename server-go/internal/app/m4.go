package app

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"net/http"
	"time"

	"raft.local/server-go/internal/auth"
	"raft.local/server-go/internal/channel"
	"raft.local/server-go/internal/message"
	platformdb "raft.local/server-go/internal/platform/db"
	"raft.local/server-go/internal/platform/keys"
	"raft.local/server-go/internal/readstate"
	"raft.local/server-go/internal/realtime"
	"raft.local/server-go/internal/transport/legacyweb"
)

// m4Runtime composes the human chat fact/read-model slices over the same local
// database and channel authority as M3. Agent execution/delivery is not owned
// here. Protocol and publication lifecycle are connected in the M4 socket
// assembly, not hidden inside domain stores.
type m4Runtime struct {
	db           *sql.DB
	channels     *channel.Store
	messages     *message.Store
	readstate    *readstate.Store
	publications *realtime.Store
	// channelProjector resolves the M4 viewer-private channel enrichment
	// (read frontier, mute/display prefs, list-exit last-message facts) on a
	// caller-pinned snapshot. It is attached to every ChannelHandlers
	// instance this composition mounts and is exposed for the M3 runtime's
	// /api/channels list/detail/create registration (the one-line parent
	// attach is recorded in docs/m4-wiring-closeout.md).
	channelProjector legacyweb.M4ChannelProjector
}

func buildM4(handle *sql.DB, channels *channel.Store, root *keys.Root) (*m4Runtime, error) {
	cursorKey, err := root.ReactionCursorKey()
	if err != nil {
		return nil, err
	}
	messages := message.NewStore(handle, channels)
	messages.SetCursorSecret(cursorKey)
	states := readstate.NewStore(handle, channels)
	// These shared defaults are wired explicitly at the composition root as
	// well: no copied transaction retry, identity predicate or lossy enqueue
	// implementation can become the application's authority by accident.
	states.SetWriteTx(platformdb.WithWriteTx)
	states.SetReadSnapshot(func(ctx context.Context, db *sql.DB, fn func(readstate.Executor) error) error {
		return platformdb.WithReadSnapshot(ctx, db, func(ex platformdb.Executor) error { return fn(ex) })
	})
	states.SetValidateHuman(func(ctx context.Context, ex readstate.Queryer, claims auth.AccessTokenClaims, now time.Time) error {
		err := auth.ValidateHumanTx(ctx, ex, claims, now)
		if errors.Is(err, auth.ErrTokenInvalid) {
			return readstate.ErrTokenInvalid
		}
		return err
	})
	states.SetEnqueue(func(ctx context.Context, ex readstate.Executor, p readstate.PublicationIntent) error {
		return realtime.Enqueue(ctx, ex, realtime.Publication{
			WorkspaceID: p.WorkspaceID, ObjectType: p.ObjectType, ObjectID: p.ObjectID,
			EventType: p.EventType, Revision: p.Revision,
			SubjectUserID: p.SubjectUserID, ScopeID: p.ScopeID,
		})
	})
	// A human thread reply advances the REPLIER's own read frontier in the
	// same commit: the original pipeline pairs the replied auto-follow with
	// markReadLatest (messageService.ts:2653/2759). This is a product-path
	// requirement, not an optional seam — the message worker invokes the hook
	// only for new human replies, inside the reply transaction, so wiring it
	// to MarkReadLatestTx keeps message, follow and read effect one atomic
	// fact (a hook failure rolls the whole reply back; a missing hook would
	// leave the replier's thread unread). Fail closed at assembly if the
	// wiring is ever dropped.
	messages.SetThreadReplyReadHook(func(ctx context.Context, tx *sql.Tx, claims auth.AccessTokenClaims, workspaceID, threadID string) error {
		_, err := states.MarkReadLatestTx(ctx, tx, claims, workspaceID, threadID)
		return err
	})
	if !messages.HasThreadReplyReadHook() {
		return nil, errors.New("m4: thread reply read hook is required at assembly")
	}
	rt := &m4Runtime{
		db: handle, channels: channels, messages: messages,
		readstate: states, publications: realtime.NewStore(handle),
	}
	rt.channelProjector = rt.projectChannels
	return rt, nil
}

func (m *m4Runtime) register(mux *http.ServeMux, gate *legacyweb.AuthGate) {
	// This instance carries the M4 viewer-projection seam for every surface
	// the M4 composition mounts (the conversation/message routes below and
	// the RequireChannelServer helpers they reuse). The /api/channels
	// list/detail/create exits are registered by the M3 runtime's
	// RegisterChannelRoutes call; the same projector is exposed as
	// m.channelProjector for that registration point.
	channels := &legacyweb.ChannelHandlers{Store: m.channels, M4: m.channelProjector}
	legacyweb.RegisterMessageRoutes(mux, legacyweb.NewMessageHandlers(m.messages, channels), gate)
	legacyweb.RegisterM4ConversationRoutes(mux, &legacyweb.M4ConversationHandlers{
		Channels: channels,
		PostInitialReply: func(ctx context.Context, tx *sql.Tx, claims auth.AccessTokenClaims, workspaceID, channelID, content string) error {
			// EnsureThreadTx and the optional initial reply use this SAME tx.
			// Calling Create here would acquire a nested transaction/fence.
			_, err := m.messages.CreateTx(ctx, tx, claims, workspaceID, message.CreateInput{
				ChannelID: channelID, Content: content,
			})
			return err
		},
		ReadCursor: m.readCursor,
		MarkReadLatest: func(ctx context.Context, tx *sql.Tx, claims auth.AccessTokenClaims, workspaceID, userID, threadID string) error {
			if claims.Subject != userID {
				return auth.ErrTokenInvalid
			}
			_, err := m.readstate.MarkReadLatestTx(ctx, tx, claims, workspaceID, threadID)
			return err
		},
		DMReadState: m.dmReadState,
	}, gate)
	legacyweb.RegisterReadstateRoutes(mux, &legacyweb.ReadstateHandlers{Store: m.readstate}, gate)
}

// readCursor is a read-only adapter for channel-owned thread projections.
// Its caller has already authorized the conversation on the supplied snapshot;
// no second connection or different authority snapshot is acquired here.
func (m *m4Runtime) readCursor(ctx context.Context, ex channel.Executor, workspaceID, userID, channelID string) (int64, error) {
	return m.readstate.ReadCursorTx(ctx, ex, workspaceID, userID, channelID)
}

// dmReadState renders the exact original #632 read frontier
// (InboxScopeReadFrontier union) for one DM row through the readstate-owned
// projection. DMReadStateTx fail-closes non-DM scopes, non-participants and
// foreign workspaces; the bytes are embedded verbatim by the conversation
// handlers, never re-assembled here.
func (m *m4Runtime) dmReadState(ctx context.Context, ex channel.Executor, workspaceID, userID, channelID string) (json.RawMessage, error) {
	return m.readstate.DMReadStateTx(ctx, ex, workspaceID, userID, channelID)
}

// projectChannels is the composition-root M4ChannelProjector. It mirrors the
// validated reference implementation (legacyweb's m4TestProjector) field for
// field — legacy coalesce-to-0 scalars, the announcement default mute, the
// muted boundary's null/number distinction, display defaults and the
// list-exit last-message facts — with one deliberate upgrade: the #632
// read-state union is rendered by its owning slice (readstate's
// ReadFrontierJSONTx, including the real latest-activity pair) instead of a
// parallel hand-built shape. All reads run on the caller's pinned snapshot
// executor (channel.Executor satisfies readstate's Queryer); nothing opens a
// second connection, so the exit's channel rows and viewer state cannot tear.
func (m *m4Runtime) projectChannels(ctx context.Context, ex channel.Executor, serverID, userID string, channels []channel.Channel, includeLastMessage bool) (map[string]legacyweb.M4ChannelProjection, error) {
	out := make(map[string]legacyweb.M4ChannelProjection, len(channels))
	if len(channels) == 0 {
		return out, nil
	}
	ids := make([]any, 0, len(channels))
	placeholders := ""
	for i, c := range channels {
		if i > 0 {
			placeholders += ","
		}
		placeholders += "?"
		ids = append(ids, c.ID)
	}
	inList := "(" + placeholders + ")"

	// Read state (0011): legacy scalars coalesce to 0; the union itself is
	// re-rendered per present scope by the owning slice below.
	type readRow struct{ seq, version int64 }
	readByChannel := map[string]readRow{}
	readRows, err := ex.QueryContext(ctx, `SELECT channel_id, last_read_seq, read_state_version
		FROM user_channel_read_states WHERE workspace_id = ? AND user_id = ? AND channel_id IN `+inList,
		append([]any{serverID, userID}, ids...)...)
	if err != nil {
		return nil, err
	}
	for readRows.Next() {
		var channelID string
		var r readRow
		if err := readRows.Scan(&channelID, &r.seq, &r.version); err != nil {
			readRows.Close()
			return nil, err
		}
		readByChannel[channelID] = r
	}
	if err := readRows.Err(); err != nil {
		readRows.Close()
		return nil, err
	}
	readRows.Close()

	// Mute (0011): a row with activity_muted=1 carries a valid boundary; the
	// unmuted wire shape is muteFromSeq:null. Announcement channels without
	// any explicit row keep the legacy default mute {true, boundary 0}.
	type muteRow struct {
		muted bool
		from  sql.NullInt64
		prefs int64
	}
	muteByChannel := map[string]muteRow{}
	muteRows, err := ex.QueryContext(ctx, `SELECT channel_id, activity_muted, mute_from_seq, prefs_version
		FROM user_channel_mute_states WHERE workspace_id = ? AND user_id = ? AND channel_id IN `+inList,
		append([]any{serverID, userID}, ids...)...)
	if err != nil {
		return nil, err
	}
	for muteRows.Next() {
		var channelID string
		var muted int
		var r muteRow
		if err := muteRows.Scan(&channelID, &muted, &r.from, &r.prefs); err != nil {
			muteRows.Close()
			return nil, err
		}
		r.muted = muted != 0
		muteByChannel[channelID] = r
	}
	if err := muteRows.Err(); err != nil {
		muteRows.Close()
		return nil, err
	}
	muteRows.Close()

	// Display prefs (0011): collapse defaults to true with version 0.
	type displayRow struct {
		collapse bool
		version  int64
	}
	displayByChannel := map[string]displayRow{}
	displayRows, err := ex.QueryContext(ctx, `SELECT channel_id, collapse_long_messages, prefs_version
		FROM user_channel_display_prefs WHERE workspace_id = ? AND user_id = ? AND channel_id IN `+inList,
		append([]any{serverID, userID}, ids...)...)
	if err != nil {
		return nil, err
	}
	for displayRows.Next() {
		var channelID string
		var collapse int
		var r displayRow
		if err := displayRows.Scan(&channelID, &collapse, &r.version); err != nil {
			displayRows.Close()
			return nil, err
		}
		r.collapse = collapse != 0
		displayByChannel[channelID] = r
	}
	if err := displayRows.Err(); err != nil {
		displayRows.Close()
		return nil, err
	}
	displayRows.Close()

	// Last-message facts: only the list exit attaches them (the original
	// composition's includeLastMessage rule).
	lastByChannel := map[string]int64{}
	if includeLastMessage {
		lastRows, err := ex.QueryContext(ctx, `SELECT m.channel_id, MAX(m.created_at)
			FROM messages m WHERE m.workspace_id = ? AND m.channel_id IN `+inList+` GROUP BY m.channel_id`,
			append([]any{serverID}, ids...)...)
		if err != nil {
			return nil, err
		}
		for lastRows.Next() {
			var channelID string
			var createdAt int64
			if err := lastRows.Scan(&channelID, &createdAt); err != nil {
				lastRows.Close()
				return nil, err
			}
			lastByChannel[channelID] = createdAt
		}
		if err := lastRows.Err(); err != nil {
			lastRows.Close()
			return nil, err
		}
		lastRows.Close()
	}

	for _, c := range channels {
		var p legacyweb.M4ChannelProjection
		if r, ok := readByChannel[c.ID]; ok {
			union, err := m.readstate.ReadFrontierJSONTx(ctx, ex, serverID, userID, c.ID)
			if err != nil {
				return nil, err
			}
			p.ReadState = union
			maxRead, version := r.seq, r.version
			p.MaxReadSeq, p.ReadStateVersion = &maxRead, &version
		} else {
			p.ReadState = json.RawMessage(`{"kind":"absent"}`)
			maxRead, version := int64(0), int64(0)
			p.MaxReadSeq, p.ReadStateVersion = &maxRead, &version
		}

		muted, fromSeq, prefs := false, any(json.RawMessage("null")), int64(0)
		if ms, ok := muteByChannel[c.ID]; ok {
			muted = ms.muted && ms.from.Valid
			prefs = ms.prefs
			if muted {
				fromSeq = ms.from.Int64
			}
		} else if c.SystemKind != nil && *c.SystemKind == "announcement" && c.Type == channel.TypeChannel {
			// Legacy ANNOUNCEMENT_DEFAULT_MUTE: {activityMuted:true,
			// muteFromSeq:0, prefsVersion:0} — boundary 0, not null.
			zero := int64(0)
			muted, fromSeq, prefs = true, zero, zero
		}
		p.ActivityMuted = &muted
		p.MuteFromSeq = fromSeq
		p.PrefsVersion = &prefs
		supported := channel.SupportsActivityMute(c.Type)
		p.ActivityMuteSupported = &supported

		collapse, displayVersion := true, int64(0)
		if d, ok := displayByChannel[c.ID]; ok {
			collapse, displayVersion = d.collapse, d.version
		}
		p.CollapseLongMessages = &collapse
		p.DisplayPrefsVersion = &displayVersion

		if includeLastMessage {
			if createdAt, ok := lastByChannel[c.ID]; ok {
				p.LastMessageAt = time.UnixMilli(createdAt).UTC().Format("2006-01-02T15:04:05.000Z")
			} else {
				p.LastMessageAt = json.RawMessage("null")
			}
		}
		out[c.ID] = p
	}
	return out, nil
}
