package realtime_test

// Behavior tests relocated from the retired readstate projector
// (readstate.ProjectPublication / ProjectedEvent): the production projection
// path for the readstate-owned private events is THIS package's Dispatcher.
// The durable intent is a reference only; the projection re-reads CURRENT
// facts under one snapshot and delivers presenter-rendered payloads through
// the sink, so every assertion here drives the real dispatcher over a real
// SQLite database seeded the way the composition does.

import (
	"context"
	"database/sql"
	"path/filepath"
	"testing"
	"time"

	"raft.local/server-go/internal/application/realtime"
	"raft.local/server-go/internal/auth"
	"raft.local/server-go/internal/channel"
	"raft.local/server-go/internal/message"
	platformdb "raft.local/server-go/internal/platform/db"
	"raft.local/server-go/internal/protocol/client"
	"raft.local/server-go/internal/publication"
	"raft.local/server-go/internal/readstate"
	"raft.local/server-go/internal/transport/presenter"
)

// recordingSink is the NotificationSink double: it captures every verified
// notification a dispatch produces, in dispatch order.
type recordingSink struct {
	notes []realtime.Notification
}

func (s *recordingSink) Notify(_ context.Context, n realtime.Notification) error {
	s.notes = append(s.notes, n)
	return nil
}

func (s *recordingSink) drain() []realtime.Notification {
	got := s.notes
	s.notes = nil
	return got
}

// readstateEventsEnv owns one real database plus the stores and the
// production dispatcher wired exactly like the composition (NewDispatcher).
type readstateEventsEnv struct {
	t          *testing.T
	db         *sql.DB
	channels   *channel.Store
	messages   *message.Store
	states     *readstate.Store
	sink       *recordingSink
	dispatcher *realtime.Dispatcher

	ws      string
	general string

	claimsOf map[string]auth.AccessTokenClaims
}

func newReadstateEventsEnv(t *testing.T) *readstateEventsEnv {
	t.Helper()
	handle, err := platformdb.Open(filepath.Join(t.TempDir(), "raft.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = handle.Close() })
	channels := channel.NewStore(handle)
	messages := message.NewStore(handle, channels)
	states := readstate.NewStore(handle, channels)
	sink := &recordingSink{}
	dispatcher, err := realtime.NewDispatcher(handle, sink, messages, channels, nil)
	if err != nil {
		t.Fatal(err)
	}
	env := &readstateEventsEnv{
		t: t, db: handle, channels: channels, messages: messages, states: states,
		sink: sink, dispatcher: dispatcher,
		ws:       "bbbbbbb1-0000-4000-8000-000000000001",
		general:  "bbbbbbb1-0000-4000-8000-000000000002",
		claimsOf: map[string]auth.AccessTokenClaims{},
	}
	env.seed()
	return env
}

func (e *readstateEventsEnv) seed() {
	e.t.Helper()
	now := time.Now().UnixMilli()
	e.exec(`INSERT INTO users (id, email, name, password_hash, email_verified, profile_setup_completed_at, created_at, updated_at)
		VALUES ('alice', 'a@t', 'alice', 'x', 1, 1, 0, 0), ('bob', 'b@t', 'bob', 'x', 1, 1, 0, 0),
		       ('stranger', 's@t', 'stranger', 'x', 1, 1, 0, 0)`)
	e.exec(`INSERT INTO session_families (id, user_id, created_at)
		VALUES ('fam-alice', 'alice', 0), ('fam-bob', 'bob', 0), ('fam-stranger', 'stranger', 0)`)
	e.exec(`INSERT INTO workspaces (id, name, slug, owner_id, created_at) VALUES (?, 'w', 'w', 'alice', 0)`, e.ws)
	// The stranger holds NO membership in this workspace on purpose.
	e.exec(`INSERT INTO workspace_memberships (workspace_id, user_id, role, joined_at)
		VALUES (?, 'alice', 'owner', 0), (?, 'bob', 'member', 0)`, e.ws, e.ws)
	e.exec(`INSERT INTO channels (id, workspace_id, name, type, created_at) VALUES (?, ?, 'general', 'channel', ?)`, e.general, e.ws, now)
	e.exec(`INSERT INTO channel_humans (channel_id, user_id, role, joined_at)
		VALUES (?, 'alice', 'member', ?), (?, 'bob', 'member', ?)`, e.general, now, e.general, now)
}

func (e *readstateEventsEnv) exec(query string, args ...any) {
	e.t.Helper()
	if _, err := e.db.Exec(query, args...); err != nil {
		e.t.Fatal(err)
	}
}

func (e *readstateEventsEnv) ctx() context.Context { return context.Background() }

func (e *readstateEventsEnv) claims(user string) auth.AccessTokenClaims {
	now := time.Now()
	return auth.AccessTokenClaims{
		Subject: user, Type: "access", FamilyID: "fam-" + user,
		IssuedAt: now.Add(-time.Minute), ExpiresAt: now.Add(time.Hour),
	}
}

// insertMessage appends one chat message and returns its global seq.
func (e *readstateEventsEnv) insertMessage(channelID, sender, content string) int64 {
	e.t.Helper()
	id := content + "-" + time.Now().Format("150405.000000000")
	res, err := e.db.Exec(`INSERT INTO messages (id, workspace_id, channel_id, sender_type, sender_id,
		content, message_type, random_id, request_digest, created_at)
		VALUES (?, ?, ?, 'user', ?, ?, 'chat', NULL, ?, ?)`,
		id, e.ws, channelID, sender, content, "digest-"+content, time.Now().UnixMilli())
	if err != nil {
		e.t.Fatal(err)
	}
	seq, err := res.LastInsertId()
	if err != nil {
		e.t.Fatal(err)
	}
	return seq
}

func (e *readstateEventsEnv) markRead(user, channelID string, seq int64) readstate.ReadStateResult {
	e.t.Helper()
	state, err := e.states.MarkRead(e.ctx(), e.claims(user), e.ws, channelID, seq)
	if err != nil {
		e.t.Fatal(err)
	}
	return state
}

// dispatchPending drives every durably enqueued intent through the dispatcher
// exactly like the publication worker's dequeue: oldest first, one at a time.
func (e *readstateEventsEnv) dispatchPending() {
	e.t.Helper()
	rows, err := e.db.Query(`SELECT id, workspace_id, object_type, object_id, event_type, revision,
		subject_user_id, scope_id FROM realtime_publications
		WHERE published_at IS NULL ORDER BY id`)
	if err != nil {
		e.t.Fatal(err)
	}
	pending := []publication.Publication{}
	for rows.Next() {
		var ref publication.Publication
		if err := rows.Scan(&ref.ID, &ref.WorkspaceID, &ref.ObjectType, &ref.ObjectID,
			&ref.EventType, &ref.Revision, &ref.SubjectUserID, &ref.ScopeID); err != nil {
			rows.Close()
			e.t.Fatal(err)
		}
		pending = append(pending, ref)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		e.t.Fatal(err)
	}
	rows.Close()
	for _, ref := range pending {
		if err := e.dispatcher.Dispatch(e.ctx(), ref); err != nil {
			e.t.Fatalf("dispatch %s/%s rev %d: %v", ref.ObjectType, ref.EventType, ref.Revision, err)
		}
	}
}

// readStateIntent loads the FIRST enqueued read_state wake of one subject so a
// test can re-dispatch the original revision after newer facts committed.
func (e *readstateEventsEnv) readStateIntent(subject, channelID string) publication.Publication {
	e.t.Helper()
	var ref publication.Publication
	err := e.db.QueryRow(`SELECT id, workspace_id, object_type, object_id, event_type, revision,
		subject_user_id, scope_id FROM realtime_publications
		WHERE object_type = 'read_state' AND subject_user_id = ? AND object_id = ?
		ORDER BY id LIMIT 1`, subject, channelID).Scan(&ref.ID, &ref.WorkspaceID, &ref.ObjectType,
		&ref.ObjectID, &ref.EventType, &ref.Revision, &ref.SubjectUserID, &ref.ScopeID)
	if err != nil {
		e.t.Fatal(err)
	}
	return ref
}

// payloadOf dereferences a delivered notification payload. The dispatcher
// hands the sink pointer forms for the re-projected families; the presenter
// accepts both, so these helpers pin the actual delivered values.
func readStatePayloadOf(t *testing.T, n realtime.Notification) realtime.ReadStateEventPayload {
	t.Helper()
	switch p := n.Payload.(type) {
	case realtime.ReadStateEventPayload:
		return p
	case *realtime.ReadStateEventPayload:
		if p == nil {
			t.Fatal("nil read_state payload")
		}
		return *p
	default:
		t.Fatalf("read_state payload type = %T", n.Payload)
		return realtime.ReadStateEventPayload{}
	}
}

func notifPrefsPayloadOf(t *testing.T, n realtime.Notification) realtime.NotificationPrefsEventPayload {
	t.Helper()
	switch p := n.Payload.(type) {
	case realtime.NotificationPrefsEventPayload:
		return p
	case *realtime.NotificationPrefsEventPayload:
		if p == nil {
			t.Fatal("nil notification_prefs payload")
		}
		return *p
	default:
		t.Fatalf("notification_prefs payload type = %T", n.Payload)
		return realtime.NotificationPrefsEventPayload{}
	}
}

func displayPrefsPayloadOf(t *testing.T, n realtime.Notification) realtime.DisplayPrefsEventPayload {
	t.Helper()
	switch p := n.Payload.(type) {
	case realtime.DisplayPrefsEventPayload:
		return p
	case *realtime.DisplayPrefsEventPayload:
		if p == nil {
			t.Fatal("nil message_display_prefs payload")
		}
		return *p
	default:
		t.Fatalf("message_display_prefs payload type = %T", n.Payload)
		return realtime.DisplayPrefsEventPayload{}
	}
}

// soleWake returns the single notification of the wanted event kind and fails
// when the dispatch delivered anything else on this private event family.
func soleWake(t *testing.T, notes []realtime.Notification, event string) realtime.Notification {
	t.Helper()
	var found *realtime.Notification
	for i := range notes {
		if notes[i].Event != event {
			continue
		}
		if found != nil {
			t.Fatalf("delivered %s twice: %+v", event, notes)
		}
		found = &notes[i]
	}
	if found == nil {
		t.Fatalf("no %s notification delivered: %+v", event, notes)
	}
	return *found
}

// privateRecipient checks the receiver-private envelope: exactly the subject,
// no channel interest, the owning workspace.
func privateRecipient(t *testing.T, n realtime.Notification, workspaceID, subject string) {
	t.Helper()
	if n.WorkspaceID != workspaceID {
		t.Fatalf("workspace = %q, want %q", n.WorkspaceID, workspaceID)
	}
	if len(n.Users) != 1 {
		t.Fatalf("recipients = %v, want only %q", n.Users, subject)
	}
	if _, ok := n.Users[subject]; !ok {
		t.Fatalf("recipients = %v, want only %q", n.Users, subject)
	}
	if len(n.ChannelIDs) != 0 {
		t.Fatalf("channel interest = %v, want none on a private wake", n.ChannelIDs)
	}
}

// TestReadStateWakeProjectsCurrentFactsThroughPresenter: one read_state wake
// projects the CURRENT authorized row — {serverId, scopeId, maxReadSeq,
// readStateVersion} — onto client.ReadStateEvent through presenter.
// RealtimePayload. The intent is a durable reference, never a stored payload:
// re-dispatching the ORIGINAL revision after a newer advance renders the
// CURRENT row (relocated from TestProjectorRendersCurrentAuthorizedPayloads).
func TestReadStateWakeProjectsCurrentFactsThroughPresenter(t *testing.T) {
	e := newReadstateEventsEnv(t)
	seq1 := e.insertMessage(e.general, "bob", "one")
	seq3 := e.insertMessage(e.general, "bob", "three")

	state := e.markRead("alice", e.general, seq1)
	e.dispatchPending()
	wake := soleWake(t, e.sink.drain(), realtime.EventReadState)
	privateRecipient(t, wake, e.ws, "alice")
	payload := readStatePayloadOf(t, wake)
	want := realtime.ReadStateEventPayload{
		ServerID: e.ws, ScopeID: e.general, MaxReadSeq: seq1, ReadStateVersion: state.ReadStateVersion,
	}
	if payload != want {
		t.Fatalf("read_state payload = %+v, want %+v", payload, want)
	}
	wire, ok := presenter.RealtimePayload(realtime.EventReadState, payload).(client.ReadStateEvent)
	if !ok {
		t.Fatalf("presenter rendered %T, want client.ReadStateEvent", presenter.RealtimePayload(realtime.EventReadState, payload))
	}
	if wire != (client.ReadStateEvent{ServerID: e.ws, ScopeID: e.general, MaxReadSeq: seq1, ReadStateVersion: state.ReadStateVersion}) {
		t.Fatalf("presenter wire = %+v", wire)
	}

	// The stale revision re-projects the CURRENT facts, not its own.
	later := e.markRead("alice", e.general, seq3)
	e.dispatchPending()
	e.sink.drain() // the newer revision's own projections
	if err := e.dispatcher.Dispatch(e.ctx(), e.readStateIntent("alice", e.general)); err != nil {
		t.Fatal(err)
	}
	replayed := soleWake(t, e.sink.drain(), realtime.EventReadState)
	replayedPayload := readStatePayloadOf(t, replayed)
	wantCurrent := realtime.ReadStateEventPayload{
		ServerID: e.ws, ScopeID: e.general, MaxReadSeq: seq3, ReadStateVersion: later.ReadStateVersion,
	}
	if replayedPayload != wantCurrent {
		t.Fatalf("stale-revision replay = %+v, want the current row %+v", replayedPayload, wantCurrent)
	}
}

// TestUnreadSummaryWakeProjectsServerIDInvalidation: the unread summary wake
// is the exact invalidation hint {serverId} — counts are never fabricated into
// the frame; receivers re-read their real summary (relocated from
// TestProjectorRendersCurrentAuthorizedPayloads).
func TestUnreadSummaryWakeProjectsServerIDInvalidation(t *testing.T) {
	e := newReadstateEventsEnv(t)
	seq := e.insertMessage(e.general, "bob", "one")

	e.markRead("alice", e.general, seq)
	e.dispatchPending()
	wake := soleWake(t, e.sink.drain(), realtime.EventUnreadSummary)
	privateRecipient(t, wake, e.ws, "alice")
	payload, ok := wake.Payload.(realtime.UnreadSummaryEventPayload)
	if !ok {
		t.Fatalf("summary payload type = %T", wake.Payload)
	}
	if payload != (realtime.UnreadSummaryEventPayload{ServerID: e.ws}) {
		t.Fatalf("summary payload = %+v, want only {serverId}", payload)
	}
	wire, ok := presenter.RealtimePayload(realtime.EventUnreadSummary, payload).(client.UnreadSummaryEvent)
	if !ok {
		t.Fatalf("presenter rendered %T, want client.UnreadSummaryEvent", presenter.RealtimePayload(realtime.EventUnreadSummary, payload))
	}
	if wire != (client.UnreadSummaryEvent{ServerID: e.ws}) {
		t.Fatalf("presenter wire = %+v", wire)
	}
}

// TestStaleSubjectWakeCompletesWithoutDelivery: the dispatcher owns stale
// subjects at projection time, so the wake is dropped on CURRENT authority —
// never delivered to a stale recipient and never a durable error (relocated
// from TestProjectorDropsStaleSubjects onto the production semantics):
//   - authority lost: a subject with no workspace membership can never
//     authorize the conversation;
//   - facts gone: an authorized member whose read-state row disappeared has
//     nothing to project.
//
// Both complete without a delivery (no sink frame, no error retained).
func TestStaleSubjectWakeCompletesWithoutDelivery(t *testing.T) {
	e := newReadstateEventsEnv(t)
	seq := e.insertMessage(e.general, "bob", "one")
	state := e.markRead("alice", e.general, seq)
	before := e.dispatcher.Stats()

	// Authority lost: the stranger projects nothing.
	stranger := publication.Publication{
		WorkspaceID: e.ws, ObjectType: "read_state", ObjectID: e.general,
		EventType: realtime.EventReadState, Revision: state.ReadStateVersion,
		SubjectUserID: "stranger", ScopeID: e.general,
	}
	if err := e.dispatcher.Dispatch(e.ctx(), stranger); err != nil {
		t.Fatalf("stale subject wake must complete, got %v", err)
	}
	if notes := e.sink.drain(); len(notes) != 0 {
		t.Fatalf("non-member wake delivered: %+v", notes)
	}

	// Facts gone: alice's read-state row vanished after the mutation.
	e.exec(`DELETE FROM user_channel_read_states
		WHERE workspace_id = ? AND user_id = 'alice' AND channel_id = ?`, e.ws, e.general)
	member := publication.Publication{
		WorkspaceID: e.ws, ObjectType: "read_state", ObjectID: e.general,
		EventType: realtime.EventReadState, Revision: state.ReadStateVersion,
		SubjectUserID: "alice", ScopeID: e.general,
	}
	if err := e.dispatcher.Dispatch(e.ctx(), member); err != nil {
		t.Fatalf("vanished-fact wake must complete, got %v", err)
	}
	if notes := e.sink.drain(); len(notes) != 0 {
		t.Fatalf("vanished-fact wake delivered: %+v", notes)
	}

	after := e.dispatcher.Stats()
	if after.Completed != before.Completed+2 {
		t.Fatalf("completed counter = %d, want %d (two silent completions)", after.Completed, before.Completed+2)
	}
	if after.Published != before.Published {
		t.Fatalf("published counter moved on dropped wakes: %+v -> %+v", before, after)
	}
}

// TestPrefsWakesProjectFrozenPrefsEnvelopes: notification_prefs and
// message_display_prefs wakes project the frozen prefs envelope (never
// flattened) from CURRENT facts, presenter-rendered onto the protocol types
// (relocated from TestProjectorRendersCurrentAuthorizedPayloads onto the
// production payload semantics).
func TestPrefsWakesProjectFrozenPrefsEnvelopes(t *testing.T) {
	e := newReadstateEventsEnv(t)
	e.insertMessage(e.general, "bob", "one")

	mute, err := e.states.SetNotificationSettings(e.ctx(), e.claims("alice"), e.ws, e.general, true)
	if err != nil {
		t.Fatal(err)
	}
	e.dispatchPending()
	notified := soleWake(t, e.sink.drain(), realtime.EventNotifPrefs)
	privateRecipient(t, notified, e.ws, "alice")
	prefs := notifPrefsPayloadOf(t, notified)
	if !prefs.Prefs.ActivityMuted || prefs.Prefs.MuteFromSeq == nil ||
		*prefs.Prefs.MuteFromSeq != *mute.MuteFromSeq || prefs.PrefsVersion != mute.PrefsVersion {
		t.Fatalf("notification_prefs payload = %+v, want the stored mute row %+v", prefs, mute)
	}
	prefsWire, ok := presenter.RealtimePayload(realtime.EventNotifPrefs, prefs).(client.NotificationPrefsPayload)
	if !ok {
		t.Fatalf("presenter rendered %T, want client.NotificationPrefsPayload", presenter.RealtimePayload(realtime.EventNotifPrefs, prefs))
	}
	if !prefsWire.Prefs.ActivityMuted || prefsWire.Prefs.MuteFromSeq == nil ||
		*prefsWire.Prefs.MuteFromSeq != *mute.MuteFromSeq ||
		prefsWire.ServerID != e.ws || prefsWire.ScopeID != e.general || prefsWire.PrefsVersion != mute.PrefsVersion {
		t.Fatalf("presenter prefs wire = %+v", prefsWire)
	}

	display, err := e.states.SetDisplaySettings(e.ctx(), e.claims("alice"), e.ws, e.general, false)
	if err != nil {
		t.Fatal(err)
	}
	e.dispatchPending()
	displayed := soleWake(t, e.sink.drain(), realtime.EventDisplayPrefs)
	privateRecipient(t, displayed, e.ws, "alice")
	displayPrefs := displayPrefsPayloadOf(t, displayed)
	if displayPrefs.Prefs.CollapseLongMessages || displayPrefs.PrefsVersion != display.PrefsVersion {
		t.Fatalf("message_display_prefs payload = %+v, want the stored display row %+v", displayPrefs, display)
	}
	displayWire, ok := presenter.RealtimePayload(realtime.EventDisplayPrefs, displayPrefs).(client.DisplayPrefsPayload)
	if !ok {
		t.Fatalf("presenter rendered %T, want client.DisplayPrefsPayload", presenter.RealtimePayload(realtime.EventDisplayPrefs, displayPrefs))
	}
	if displayWire.Prefs.CollapseLongMessages || displayWire.ServerID != e.ws ||
		displayWire.ScopeID != e.general || displayWire.PrefsVersion != display.PrefsVersion {
		t.Fatalf("presenter display wire = %+v", displayWire)
	}
}
