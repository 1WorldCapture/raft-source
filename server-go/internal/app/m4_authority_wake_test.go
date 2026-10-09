package app

import (
	"context"
	"database/sql"
	"net/http/httptest"
	"testing"
	"time"

	"raft.local/server-go/internal/platform/db"
	"raft.local/server-go/internal/transport/socketio/core"
)

// Deterministically replay a delayed notification AFTER a socket has already
// authenticated against that same committed authority generation. Scheduler
// timing must never turn a legitimate fresh connection into a stale one.
func TestM4DelayedAuthorityWakePreservesFreshConnections(t *testing.T) {
	for _, kind := range []string{"workspace", "user", "family"} {
		for _, pending := range []bool{false, true} {
			name := kind + "/opened"
			if pending {
				name = kind + "/pending"
			}
			t.Run(name, func(t *testing.T) {
				f := newRTFixture(t, nil)
				scopeID := rtWS
				if kind == "user" {
					scopeID = rtBob
				} else if kind == "family" {
					scopeID = rtFamB
				}
				if err := db.WithWriteTx(context.Background(), f.handle, func(tx *sql.Tx) error {
					switch kind {
					case "user":
						_, err := tx.Exec(`UPDATE users SET name='bob-renamed' WHERE id=?`, rtBob)
						return err
					case "family":
						// Two changes in one transaction leave the session valid
						// while assigning a real positive family generation.
						if _, err := tx.Exec(`UPDATE session_families SET revoked_at=? WHERE id=?`, time.Now().UnixMilli(), rtFamB); err != nil {
							return err
						}
						_, err := tx.Exec(`UPDATE session_families SET revoked_at=NULL WHERE id=?`, rtFamB)
						return err
					default:
						_, err := tx.Exec(`UPDATE channels SET name='renamed-general' WHERE id=?`, rtGeneral)
						return err
					}
				}); err != nil {
					t.Fatal(err)
				}
				generation := db.AuthorityGeneration(f.handle, kind, scopeID)
				if generation == 0 {
					t.Fatal("fixture did not commit an authority generation")
				}
				if pending {
					req := httptest.NewRequest("GET", "/socket.io/?EIO=4&transport=websocket", nil)
					if _, err := f.rt.gateway.Admit(context.Background(), "fresh", req,
						map[string]any{"token": f.token(rtBob), "serverId": rtWS, "clientKind": "web"}); err != nil {
						t.Fatal(err)
					}
				} else {
					f.connect("fresh", rtBob, rtWS)
				}
				change := db.AuthorityChange{Scope: db.AuthorityScope{Kind: kind, ID: scopeID}, Generation: generation}
				f.rt.applyAuthorityChange(change)
				if f.transport.closeCount("fresh") != 0 {
					t.Fatal("delayed authority wake evicted a connection admitted at the current generation")
				}
				if pending {
					f.rt.gateway.Opened("fresh")
					rtWaitUntil(t, 5*time.Second, func() bool {
						return slicesContains(f.transport.events("fresh"), core.EventRoomsJoined)
					}, "fresh pending connection survives delayed wake")
				}
				if generation > 1 {
					change.Generation--
					f.rt.applyAuthorityChange(change)
					if f.transport.closeCount("fresh") != 0 {
						t.Fatal("out-of-order older wake evicted a newer connection")
					}
				}
			})
		}
	}
}

// A hard-deleted family cannot be resolved by looking its owner up afterward.
// The retained family generation itself must immediately evict old sockets,
// without waiting for a heartbeat and without affecting other login families.
func TestM4DeletedFamilyWakeDoesNotRequireOwnerLookup(t *testing.T) {
	f := newRTFixture(t, func(cfg *realtimeConfig) { cfg.HeartbeatInterval = time.Hour })
	f.connect("bob-deleted", rtBob, rtWS)
	f.connect("alice-kept", rtAlice, rtWS)
	if err := db.WithWriteTx(context.Background(), f.handle, func(tx *sql.Tx) error {
		_, err := tx.Exec(`DELETE FROM session_families WHERE id=?`, rtFamB)
		return err
	}); err != nil {
		t.Fatal(err)
	}
	change := db.AuthorityChange{
		Scope:      db.AuthorityScope{Kind: "family", ID: rtFamB},
		Generation: db.AuthorityGeneration(f.handle, "family", rtFamB),
	}
	f.rt.applyAuthorityChange(change)
	if f.transport.closeCount("bob-deleted") == 0 {
		t.Fatal("deleted family's idle socket was not closed by its authority wake")
	}
	if f.transport.closeCount("alice-kept") != 0 {
		t.Fatal("family-only eviction affected another family")
	}
}
