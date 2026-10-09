package humanapi

import (
	"encoding/json"
	"testing"
	"time"

	"raft.local/server-go/internal/channel"
)

func TestDMWirePassesCanonicalPeerType(t *testing.T) {
	hash := "should-clear"
	agentWire := dmChannelWireView("srv", channel.DMView{
		Channel: channel.Channel{
			ID: "c-agent", Name: "ada", Type: "dm", CreatedAt: time.UnixMilli(0).UTC(),
		},
		PeerType: "agent", PeerID: "agt", PeerName: "ada", PeerGravatarHash: hash,
	}, nil)
	if agentWire.PeerType != "agent" {
		t.Fatalf("peerType = %q", agentWire.PeerType)
	}
	if agentWire.PeerGravatarHash != "" {
		t.Fatalf("agent gravatar = %q", agentWire.PeerGravatarHash)
	}

	userWire := dmChannelWireView("srv", channel.DMView{
		Channel: channel.Channel{
			ID: "c-user", Name: "sam", Type: "dm", CreatedAt: time.UnixMilli(0).UTC(),
		},
		PeerID: "usr", PeerName: "sam", PeerGravatarHash: hash,
	}, json.RawMessage(`{"lastReadSeq":1}`))
	if userWire.PeerType != "user" {
		t.Fatalf("empty peer type = %q", userWire.PeerType)
	}
	if userWire.PeerGravatarHash != hash {
		t.Fatalf("user gravatar = %q", userWire.PeerGravatarHash)
	}
}
