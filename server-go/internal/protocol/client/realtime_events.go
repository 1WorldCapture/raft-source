// Package client holds the pure client-protocol wire shapes: numeric and
// string values, unions and nullable encodings exactly as the existing
// clients decode them. The package is a protocol leaf: no application,
// domain, database or network imports ever appear here.
package client

import "encoding/json"

// ReadStateEvent is the original normalized read-state DTO.
type ReadStateEvent struct {
	ServerID         string `json:"serverId"`
	ScopeID          string `json:"scopeId"`
	MaxReadSeq       int64  `json:"maxReadSeq"`
	ReadStateVersion int64  `json:"readStateVersion"`
}

// ReadStateBulkEvent is the bulk variant: one event, all scopes.
type ReadStateBulkEvent struct {
	ServerID string           `json:"serverId"`
	Scopes   []ReadStateEvent `json:"scopes"`
}

// UnreadSummaryEvent is the exact invalidation hint {serverId} — counts are
// never fabricated; receivers re-read their real summary.
type UnreadSummaryEvent struct {
	ServerID string `json:"serverId"`
}

// NotificationPrefsPayload is the frozen prefs envelope (never flattened).
type NotificationPrefsPayload struct {
	ServerID string `json:"serverId"`
	ScopeID  string `json:"scopeId"`
	Prefs    struct {
		ActivityMuted bool   `json:"activityMuted"`
		MuteFromSeq   *int64 `json:"muteFromSeq"`
	} `json:"prefs"`
	PrefsVersion int64 `json:"prefsVersion"`
}

// DisplayPrefsPayload keeps the display-prefs version domain separate from
// the mute domain, exactly like the wire contract.
type DisplayPrefsPayload struct {
	ServerID string `json:"serverId"`
	ScopeID  string `json:"scopeId"`
	Prefs    struct {
		CollapseLongMessages bool `json:"collapseLongMessages"`
	} `json:"prefs"`
	PrefsVersion int64 `json:"prefsVersion"`
}

// DMNewPayload is the exact wire shape {channelId} — never a channel DTO.
type DMNewPayload struct {
	ChannelID string `json:"channelId"`
}

// ChannelMembersPayload is the exact TS shape {channelId}.
type ChannelMembersPayload struct {
	ChannelID string `json:"channelId"`
}

// ThreadFollowersPayload is {threadChannelId} only — follower-private state
// itself is never broadcast.
type ThreadFollowersPayload struct {
	ThreadChannelID string `json:"threadChannelId"`
}

// ChannelUpdatedPayload is the single-argument wire shape {channel} carrying
// the raw channel row projection — never a viewer-private envelope (read
// frontier, mute/display prefs live only in per-user surfaces). The channel
// body is pre-serialized by the presenter so this package stays a pure
// protocol leaf.
type ChannelUpdatedPayload struct {
	Channel json.RawMessage `json:"channel"`
}
