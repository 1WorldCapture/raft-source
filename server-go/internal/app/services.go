package app

import (
	"database/sql"

	"raft.local/server-go/internal/application/channelview"
	"raft.local/server-go/internal/application/messaging"
	"raft.local/server-go/internal/channel"
	"raft.local/server-go/internal/message"
	"raft.local/server-go/internal/platform/keys"
	"raft.local/server-go/internal/publication"
	"raft.local/server-go/internal/readstate"
)

// chatServices composes the human chat fact/read-model slices over the same
// local database and channel authority as the execution plane. Agent
// execution/delivery is not owned here. Protocol and publication lifecycle
// are connected in the realtime assembly, not hidden inside domain stores.
type chatServices struct {
	db           *sql.DB
	channels     *channel.Store
	messages     *message.Store
	readstate    *readstate.Store
	publications *publication.Store
	messaging    *messaging.Service
	channelView  *channelview.Service
}

func buildChat(handle *sql.DB, channels *channel.Store, root *keys.Root) (*chatServices, error) {
	cursorKey, err := root.ReactionCursorKey()
	if err != nil {
		return nil, err
	}
	messages := message.NewStoreWithOptions(handle, channels, message.Options{CursorSecret: cursorKey})
	states := readstate.NewStore(handle, channels)
	messagingSvc, err := messaging.NewService(channels, messages, states)
	if err != nil {
		return nil, err
	}
	channelViewSvc, err := channelview.NewService(channels, states, messages)
	if err != nil {
		return nil, err
	}
	return &chatServices{
		db: handle, channels: channels, messages: messages,
		readstate: states, publications: publication.NewStore(handle),
		messaging: messagingSvc, channelView: channelViewSvc,
	}, nil
}
