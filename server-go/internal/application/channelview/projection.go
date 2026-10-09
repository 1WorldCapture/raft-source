// Package channelview owns the viewer-facing channel read model: the
// list/detail/create-result projections assembled from channel authority,
// readstate viewer state and message facts on ONE pinned read snapshot. It
// never writes, never authorizes beyond delegating to the channel-owned
// transaction APIs, and holds no wire DTOs.
package channelview

import (
	"context"

	"raft.local/server-go/internal/channel"
	"raft.local/server-go/internal/message"
	"raft.local/server-go/internal/readstate"
)

// Service assembles the viewer-facing channel read model. The fact owners
// are captured at construction and are immutable afterwards — no public
// field can rewire the projection onto another database mid-flight.
type Service struct {
	channels  *channel.Store
	readstate *readstate.Store
	messages  *message.Store
}

// NewService validates the required fact owners at construction time;
// production assembly fails closed when any is missing.
func NewService(channels *channel.Store, readstate *readstate.Store, messages *message.Store) (*Service, error) {
	if channels == nil || readstate == nil || messages == nil {
		return nil, errMissingDependency
	}
	if channels.DB() == nil || readstate.DB() != channels.DB() || messages.DB() != channels.DB() {
		return nil, errMissingDependency
	}
	return &Service{channels: channels, readstate: readstate, messages: messages}, nil
}

// Projection is one channel's viewer-private enrichment. Zero-value pointer
// fields mean "no data supplied"; the exit omits the field rather than
// inventing a value. Scalar wire shapes the original exits always emit
// (maxReadSeq/readStateVersion coalesced to 0, activityMuted false,
// muteFromSeq null, prefsVersion 0) are expressed with explicit pointers
// plus json.RawMessage for nullable JSON, so "absent", "null" and a real
// value stay distinguishable.
type Projection struct {
	// ReadState is the #632 frontier union as the readstate-owned facts
	// (nil means the explicit absent shape).
	ReadState *readstate.ReadFrontier
	// MaxReadSeq/ReadStateVersion keep the legacy coalesce-to-0 facts.
	MaxReadSeq       int64
	ReadStateVersion int64

	ActivityMuted         bool
	MuteBoundary          *int64 // nil renders as the wire null boundary
	PrefsVersion          int64
	ActivityMuteSupported bool

	CollapseLongMessages bool
	DisplayPrefsVersion  int64

	// LastMessageAtMillis is the channel's newest message time; Present
	// distinguishes the JSON null from a formatted timestamp (list exit
	// only).
	LastMessageAtMillis  int64
	LastMessageAtPresent bool
}

// Project resolves the enrichment for a batch of channel rows on the
// caller's pinned executor. channels holds exactly the rows the exit is
// about to serialize (already filtered to the viewer's visibility), so this
// does not re-derive channel visibility; a missing map entry means "no data
// supplied" and the exit omits those fields. includeLastMessage mirrors the
// original composition: only the list exit attaches last-message facts.
//
// Rules owned here (mirroring the original attachments): announcement
// default mute, muteFromSeq null when unmuted, display defaults, and the
// read-state union shape rendered by the readstate owner. Every read runs on
// the caller's snapshot executor through the owning modules' batch fact
// readers — nothing opens a second connection, so the exit's channel rows
// and viewer state cannot tear.
func (s *Service) Project(ctx context.Context, ex channel.Executor, serverID, userID string, channels []channel.Channel, includeLastMessage bool) (map[string]Projection, error) {
	out := make(map[string]Projection, len(channels))
	if len(channels) == 0 {
		return out, nil
	}
	ids := make([]any, 0, len(channels))
	for _, c := range channels {
		ids = append(ids, c.ID)
	}

	// Read state (0011): legacy scalars coalesce to 0; the union itself is
	// re-rendered per present scope by the owning slice.
	readByChannel, err := s.readstate.ViewerReadStatesTx(ctx, ex, serverID, userID, idStrings(channels))
	if err != nil {
		return nil, err
	}
	muteByChannel, err := s.readstate.ViewerMuteStatesTx(ctx, ex, serverID, userID, idStrings(channels))
	if err != nil {
		return nil, err
	}
	displayByChannel, err := s.readstate.ViewerDisplayPrefsTx(ctx, ex, serverID, userID, idStrings(channels))
	if err != nil {
		return nil, err
	}

	// Last-message facts: only the list exit attaches them (the original
	// composition's includeLastMessage rule), read through the message
	// owner's batch reader on the same snapshot.
	var lastByChannel map[string]int64
	if includeLastMessage {
		lastByChannel, err = s.messages.LastMessageFactsTx(ctx, ex, serverID, idStrings(channels))
		if err != nil {
			return nil, err
		}
	}

	for _, c := range channels {
		var p Projection
		if r, ok := readByChannel[c.ID]; ok {
			union, err := s.readstate.ReadFrontierTx(ctx, ex, serverID, userID, c.ID)
			if err != nil {
				return nil, err
			}
			p.ReadState = union
			p.MaxReadSeq, p.ReadStateVersion = r.LastReadSeq, r.ReadStateVersion
		} else {
			p.MaxReadSeq, p.ReadStateVersion = 0, 0
		}

		prefs := int64(0)
		if ms, ok := muteByChannel[c.ID]; ok {
			p.ActivityMuted = ms.ActivityMuted && ms.FromSeq.Valid
			prefs = ms.PrefsVersion
			if p.ActivityMuted {
				boundary := ms.FromSeq.Int64
				p.MuteBoundary = &boundary
			}
		} else if c.SystemKind != nil && *c.SystemKind == "announcement" && c.Type == channel.TypeChannel {
			// Legacy ANNOUNCEMENT_DEFAULT_MUTE: {activityMuted:true,
			// muteFromSeq:0, prefsVersion:0} — boundary 0, not null.
			zero := int64(0)
			p.ActivityMuted, p.MuteBoundary, p.PrefsVersion = true, &zero, 0
		}
		p.PrefsVersion = prefs
		p.ActivityMuteSupported = channel.SupportsActivityMute(c.Type)

		p.CollapseLongMessages, p.DisplayPrefsVersion = true, 0
		if d, ok := displayByChannel[c.ID]; ok {
			p.CollapseLongMessages, p.DisplayPrefsVersion = d.CollapseLong, d.PrefsVersion
		}

		if includeLastMessage {
			if createdAt, ok := lastByChannel[c.ID]; ok {
				p.LastMessageAtMillis, p.LastMessageAtPresent = createdAt, true
			}
		}
		out[c.ID] = p
	}
	return out, nil
}

func idStrings(channels []channel.Channel) []string {
	ids := make([]string, 0, len(channels))
	for _, c := range channels {
		ids = append(ids, c.ID)
	}
	return ids
}
