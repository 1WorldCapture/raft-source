package messaging

import (
	"time"

	"raft.local/server-go/internal/message"
)

func now() time.Time { return time.Now() }

func sendInput(channelID, content string) message.CreateInput {
	return message.CreateInput{ChannelID: channelID, Content: content}
}
