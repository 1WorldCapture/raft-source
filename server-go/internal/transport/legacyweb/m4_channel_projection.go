// M4 viewer-private channel projections (read state, mute, display prefs,
// latest message) for the channel list/detail/create exits. The M3 exits
// could only emit fixture defaults; with 0010/0011 facts installed those
// zeros would overwrite the original client's real state on refresh, so the
// exits now consult an injected projector that resolves every row on the ONE
// pinned snapshot the handler already reads through — no per-field queries,
// no second connection, no drift between the channel rows and their state.
//
// The projector is implemented by the readstate/message slices (or the
// composition root) and owns the exact wire semantics; channel handlers only
// embed its results. While the projector is absent the exits keep the
// explicit M3 fixture defaults, which standalone M3 suites rely on.
package legacyweb

import (
	"context"
	"encoding/json"

	"raft.local/server-go/internal/channel"
)

// M4ChannelProjection is one channel's viewer-private enrichment. Zero-value
// pointer fields mean "the projector did not supply this field"; the exit
// then omits it rather than inventing a value. Scalar wire shapes that the
// original exits always emit (maxReadSeq/readStateVersion coalesced to 0,
// activityMuted false, muteFromSeq null, prefsVersion 0) are expressed with
// explicit pointers plus json.RawMessage for nullable JSON, so "absent",
// "null" and a real value stay distinguishable.
type M4ChannelProjection struct {
	// ReadState is the #632 frontier union rendered by its owner
	// ({"kind":"present",...} or {"kind":"absent"}); embedded verbatim.
	ReadState json.RawMessage
	// MaxReadSeq/ReadStateVersion keep the legacy coalesce-to-0 wire shape.
	MaxReadSeq       *int64
	ReadStateVersion *int64

	ActivityMuted         *bool
	MuteFromSeq           any // nil omits; json.RawMessage("null") emits null
	PrefsVersion          *int64
	ActivityMuteSupported *bool

	CollapseLongMessages *bool
	DisplayPrefsVersion  *int64

	// LastMessageAt is the channel's newest message time (millis DTO or
	// JSON null); the original list exit always emits it. LastMessagePreview
	// is only supplied where the original exit includes previews (the DM
	// list); the /api/channels list omits the key.
	LastMessageAt      any
	LastMessagePreview any
}

// M4ChannelProjector resolves the enrichment for a batch of channel rows on
// the caller's pinned executor. channels holds exactly the rows the exit is
// about to serialize (already filtered to the viewer's visibility), so the
// projector does not re-derive channel visibility; missing map entries are
// treated as "no data supplied" and the exit omits those fields.
// includeLastMessage mirrors the original composition: only the list exit
// attaches last-message facts, so it is the only caller passing true.
// Rules the implementation owns (mirroring the original attachments):
// announcement default mute, muteFromSeq null when unmuted, display
// defaults, and the read-state union shape.
type M4ChannelProjector func(ctx context.Context, ex channel.Executor, serverID, userID string, channels []channel.Channel, includeLastMessage bool) (map[string]M4ChannelProjection, error)

// m4ChannelProjection is the per-row lookup result for one exit (nil when no
// projector is wired).
type m4ChannelProjectionRow struct {
	wired bool
	data  M4ChannelProjection
}

func m4ProjectionFor(m map[string]M4ChannelProjection, wired bool, channelID string) m4ChannelProjectionRow {
	if !wired {
		return m4ChannelProjectionRow{}
	}
	p, ok := m[channelID]
	if !ok {
		// Wired but nothing supplied for this row: fields stay absent; the
		// exit must not fall back to fixture defaults (that is how stale
		// zeros overwrite client state).
		return m4ChannelProjectionRow{wired: true}
	}
	return m4ChannelProjectionRow{wired: true, data: p}
}

// applyM4Projection overlays a projection onto a channelView. Pointer fields
// copy only when supplied; ReadState replaces the fixture absent-shape only
// when supplied.
func (v *channelView) applyM4Projection(p m4ChannelProjectionRow) {
	if !p.wired {
		return
	}
	d := p.data
	if d.ReadState != nil {
		v.ReadState = d.ReadState
	}
	if d.MaxReadSeq != nil {
		v.MaxReadSeq = *d.MaxReadSeq
	}
	if d.ReadStateVersion != nil {
		v.ReadStateVersion = *d.ReadStateVersion
	}
	if d.ActivityMuted != nil {
		v.ActivityMuted = d.ActivityMuted
	}
	if d.MuteFromSeq != nil {
		v.MuteFromSeq = d.MuteFromSeq
	}
	if d.PrefsVersion != nil {
		v.PrefsVersion = d.PrefsVersion
	}
	if d.ActivityMuteSupported != nil {
		v.ActivityMuteSupported = d.ActivityMuteSupported
	}
	if d.CollapseLongMessages != nil {
		v.CollapseLongMessages = d.CollapseLongMessages
	}
	if d.DisplayPrefsVersion != nil {
		v.DisplayPrefsVersion = d.DisplayPrefsVersion
	}
	if d.LastMessageAt != nil {
		v.LastMessageAt = d.LastMessageAt
	}
	if d.LastMessagePreview != nil {
		v.LastMessagePreview = d.LastMessagePreview
	}
}
