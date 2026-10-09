// Package readstate owns the M4 P5 human read-state surface: versioned
// read/unread/read-all, conversation Done/undone with the strict storage
// frontier, notification (mute) and message-display preferences, the unified
// human Inbox projection and the server-authoritative Activity v1
// snapshot/difference reconcile.
//
// The package ports the frozen reference semantics from
// packages/server/src/services/channelService.ts,
// activitySyncService.ts and inboxSuppressionWriters.ts onto the Go schema
// (migrations 0001-0010 plus the 0011 draft in
// server-go/contracts/m4-readstate-schema.sql).
//
// Ownership seams (docs/m4-execution-lock.md): every public operation takes
// the full auth.AccessTokenClaims (the transport verified the JWT and saved
// the identity in the request context) and revalidates the session, the
// workspace membership and the channel access inside the transaction. The
// shared helpers the integrator supplies (db.WithWriteTx / WithReadSnapshot,
// auth.ValidateHumanTx, publication.Enqueue) are injected as function fields
// with faithful defaults so the package compiles and tests run before the
// parent lands them; the integrator overrides the fields at wiring time.
//
// Read vs Done vs Follow vs Mute stay separate: Done never touches
// thread_follows (channel-worker owned); Follow never advances read state;
// Mute never moves a read cursor or deletes a message. Socket notifications
// are transactional publication intents only (object/state owner references,
// never private payloads).
package readstate
