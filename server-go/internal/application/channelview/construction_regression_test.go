package channelview_test

import (
	"database/sql"
	"path/filepath"
	"testing"

	"raft.local/server-go/internal/application/channelview"
	"raft.local/server-go/internal/application/messaging"
	"raft.local/server-go/internal/channel"
	"raft.local/server-go/internal/message"
	platformdb "raft.local/server-go/internal/platform/db"
	"raft.local/server-go/internal/readstate"
)

// Cross-module atomicity and pinned snapshots assume all fact owners belong
// to ONE application database. Constructor checks must reject half-wired
// or mixed-database stores before a handler can receive a request.
func TestApplicationConstructorsRejectMixedDatabaseOwners(t *testing.T) {
	open := func(name string) *sql.DB {
		t.Helper()
		db, err := platformdb.Open(filepath.Join(t.TempDir(), name+".db"))
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { _ = db.Close(); platformdb.ReleaseAuthorityFence(db) })
		return db
	}
	a, b := open("first"), open("second")
	ca, cb := channel.NewStore(a), channel.NewStore(b)
	ma, mb := message.NewStore(a, ca), message.NewStore(b, cb)
	ra, rb := readstate.NewStore(a, ca), readstate.NewStore(b, cb)
	for _, test := range []struct {
		name     string
		channels *channel.Store
		messages *message.Store
		states   *readstate.Store
		valid    bool
	}{
		{"coherent", ca, ma, ra, true},
		{"missing channel", nil, ma, ra, false},
		{"missing message", ca, nil, ra, false},
		{"missing readstate", ca, ma, nil, false},
		{"zero-value stores", &channel.Store{}, &message.Store{}, &readstate.Store{}, false},
		{"foreign messages", ca, mb, ra, false},
		{"foreign readstate", ca, ma, rb, false},
		{"foreign channel", cb, ma, ra, false},
	} {
		t.Run(test.name, func(t *testing.T) {
			query, queryErr := channelview.NewService(test.channels, test.states, test.messages)
			send, sendErr := messaging.NewService(test.channels, test.messages, test.states)
			if test.valid {
				if queryErr != nil || sendErr != nil || query == nil || send == nil {
					t.Fatalf("coherent application dependencies were rejected: query=%v, send=%v", queryErr, sendErr)
				}
				return
			}
			if queryErr == nil || query != nil {
				t.Error("query constructor accepted missing or foreign database fact owners")
			}
			if sendErr == nil || send != nil {
				t.Error("messaging constructor accepted missing or foreign database fact owners")
			}
		})
	}
}
