package bridge

import (
	"testing"

	apprealtime "raft.local/server-go/internal/application/realtime"
	"raft.local/server-go/internal/transport/socketio/core"
)

// The application event vocabulary and the gateway event names must stay
// string-identical: the bridge maps semantic notifications onto gateway
// events by name, so a drift would silently drop frames.
func TestSemanticEventVocabularyMatchesGateway(t *testing.T) {
	pairs := [][2]string{
		{apprealtime.EventMessageNew, core.EventMessageNew},
		{apprealtime.EventMessageUpdated, core.EventMessageUpdated},
		{apprealtime.EventDMNew, core.EventDMNew},
		{apprealtime.EventThreadUpdated, core.EventThreadUpdated},
		{apprealtime.EventThreadFollowers, core.EventThreadFollowers},
		{apprealtime.EventUnreadSummary, core.EventUnreadSummary},
		{apprealtime.EventReactionViewer, core.EventReactionViewer},
		{apprealtime.EventChannelUpdated, core.EventChannelUpdated},
		{apprealtime.EventChannelMembers, core.EventChannelMembers},
		{apprealtime.EventReadState, core.EventReadState},
		{apprealtime.EventReadStateBulk, core.EventReadStateBulk},
		{apprealtime.EventNotifPrefs, core.EventNotifPrefs},
		{apprealtime.EventDisplayPrefs, core.EventDisplayPrefs},
	}
	for _, pair := range pairs {
		if pair[0] != pair[1] {
			t.Fatalf("event vocabulary drift: application %q vs gateway %q", pair[0], pair[1])
		}
		if got := coreEvent(pair[0]); got != pair[1] {
			t.Fatalf("bridge mapping: %q -> %q, want %q", pair[0], got, pair[1])
		}
	}
}
