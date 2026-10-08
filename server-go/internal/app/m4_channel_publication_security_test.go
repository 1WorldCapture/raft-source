package app

import (
	"context"
	"testing"

	"raft.local/server-go/internal/channel"
	"raft.local/server-go/internal/transport/socketio/core"
)

// Workspace visibility is not channel membership. A delayed gain intent
// must not render joined:true for a user who subsequently left a public
// channel, even though they may still receive its public invalidation hint.
func TestM4PublisherStalePublicJoinRequiresCurrentRoster(t *testing.T) {
	f := newRTFixture(t, nil)
	ch, err := f.runtime.channels.CreateChannel(context.Background(), channel.CreateInput{
		WorkspaceID: rtWS, Name: "left-public", Type: channel.TypeChannel,
		CreatorUserID: rtAlice, InitialUserIDs: []string{rtCara},
	})
	if err != nil {
		t.Fatal(err)
	}
	waitChannelIntents(t, f, ch.ID)
	if err := f.runtime.channels.RemoveHumanTx(context.Background(), ch.ID, rtCara); err != nil {
		t.Fatal(err)
	}
	waitChannelIntents(t, f, ch.ID)
	f.connect("left-cara", rtCara, rtWS)
	f.enqueueChannelIntent(t, channel.PublicationEventMembersUpdated, ch.ID, rtCara)
	channelEventPayload(t, f, "left-cara", core.EventChannelMembers, ch.ID)
	waitChannelIntents(t, f, ch.ID)
	settle()
	if got := len(f.transport.payloads("left-cara", core.EventChannelUpdated)); got != 0 {
		t.Fatal("stale gain intent emitted joined:true to a departed public-channel member")
	}
}
