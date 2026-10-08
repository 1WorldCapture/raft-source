package readstate

import (
	"testing"
)

// intentOf builds a publication intent shaped like the ones the mutations
// enqueue (revision = the version the mutation observed).
func intentOf(event, objectID string, revision int64) PublicationIntent {
	return PublicationIntent{
		WorkspaceID: fxWS,
		ObjectType: map[string]string{
			EventReadStateUpdated:     "read_state",
			EventUnreadSummaryChanged: "unread_summary",
			EventNotificationPrefs:    "notification_prefs",
			EventMessageDisplayPrefs:  "message_display_prefs",
			"scope_read:updated":      "scope_read",
		}[event],
		ObjectID:      objectID,
		EventType:     event,
		Revision:      revision,
		SubjectUserID: fxAlice,
		ScopeID:       objectID,
	}
}

// TestProjectorRendersCurrentAuthorizedPayloads: each private event family
// projects its exact wire payload from CURRENT facts, with the subject bound
// to the user∩workspace room.
func TestProjectorRendersCurrentAuthorizedPayloads(t *testing.T) {
	fx := newFixture(t)
	seq := fx.insertMessage(fxGeneral, fxBob, "one")
	state, err := fx.store.MarkRead(fx.ctx(), fx.claims[fxAlice], fxWS, fxGeneral, seq)
	if err != nil {
		t.Fatal(err)
	}

	events, err := fx.store.ProjectPublication(fx.ctx(), fx.claims[fxAlice],
		intentOf(EventReadStateUpdated, fxGeneral, state.ReadStateVersion))
	if err != nil {
		t.Fatal(err)
	}
	if len(events) != 1 {
		t.Fatalf("read_state events = %+v", events)
	}
	ev := events[0]
	if ev.Event != EventReadStateUpdated || ev.ServerID != fxWS || ev.SubjectUserID != fxAlice || ev.SharedScope {
		t.Fatalf("event envelope = %+v", ev)
	}
	if ev.Payload["maxReadSeq"] != seq || ev.Payload["readStateVersion"] != state.ReadStateVersion ||
		ev.Payload["scopeId"] != fxGeneral || ev.Payload["serverId"] != fxWS {
		t.Fatalf("read_state payload = %+v", ev.Payload)
	}

	// unread summary wake: serverId only.
	events, err = fx.store.ProjectPublication(fx.ctx(), fx.claims[fxAlice],
		intentOf(EventUnreadSummaryChanged, fxWS, 1))
	if err != nil {
		t.Fatal(err)
	}
	if len(events) != 1 || events[0].Payload["serverId"] != fxWS {
		t.Fatalf("summary event = %+v", events)
	}

	// Prefs events carry the frozen prefs envelope.
	muteState, err := fx.store.SetNotificationSettings(fx.ctx(), fx.claims[fxAlice], fxWS, fxGeneral, true)
	if err != nil {
		t.Fatal(err)
	}
	events, err = fx.store.ProjectPublication(fx.ctx(), fx.claims[fxAlice],
		intentOf(EventNotificationPrefs, fxGeneral, muteState.PrefsVersion))
	if err != nil {
		t.Fatal(err)
	}
	if len(events) != 1 {
		t.Fatalf("prefs events = %+v", events)
	}
	prefs := events[0].Payload["prefs"].(map[string]any)
	if prefs["activityMuted"] != true || prefs["muteFromSeq"] != *muteState.MuteFromSeq ||
		events[0].Payload["prefsVersion"] != muteState.PrefsVersion {
		t.Fatalf("prefs payload = %+v", events[0].Payload)
	}

	display, err := fx.store.SetDisplaySettings(fx.ctx(), fx.claims[fxAlice], fxWS, fxGeneral, false)
	if err != nil {
		t.Fatal(err)
	}
	events, err = fx.store.ProjectPublication(fx.ctx(), fx.claims[fxAlice],
		intentOf(EventMessageDisplayPrefs, fxGeneral, display.PrefsVersion))
	if err != nil {
		t.Fatal(err)
	}
	if len(events) != 1 {
		t.Fatalf("display events = %+v", events)
	}
	displayPrefs := events[0].Payload["prefs"].(map[string]any)
	if displayPrefs["collapseLongMessages"] != false || events[0].Payload["prefsVersion"] != display.PrefsVersion {
		t.Fatalf("display payload = %+v", events[0].Payload)
	}
}

// TestProjectorDropsStaleSubjects: a revoked session or a lost workspace
// membership projects NOTHING — the wake is dropped on current authority,
// never delivered to a stale recipient.
func TestProjectorDropsStaleSubjects(t *testing.T) {
	fx := newFixture(t)
	seq := fx.insertMessage(fxGeneral, fxBob, "one")
	state, err := fx.store.MarkRead(fx.ctx(), fx.claims[fxAlice], fxWS, fxGeneral, seq)
	if err != nil {
		t.Fatal(err)
	}
	intent := intentOf(EventReadStateUpdated, fxGeneral, state.ReadStateVersion)

	if _, err := fx.db.Exec(`UPDATE session_families SET revoked_at = ? WHERE id = ?`,
		fx.clock.Now().UnixMilli(), fx.family[fxAlice]); err != nil {
		t.Fatal(err)
	}
	events, err := fx.store.ProjectPublication(fx.ctx(), fx.claims[fxAlice], intent)
	if err != nil {
		t.Fatal(err)
	}
	if len(events) != 0 {
		t.Fatalf("revoked subject projected events: %+v", events)
	}

	// A member of ANOTHER workspace projecting into this one: dropped.
	events, err = fx.store.ProjectPublication(fx.ctx(), fx.claims[fxStranger], intent)
	if err != nil {
		t.Fatal(err)
	}
	if len(events) != 0 {
		t.Fatalf("non-member projected events: %+v", events)
	}
}

// TestProjectorHumanScopeReadIsSilent: the shared read-receipt event is
// agents-only in the reference (readReceiptService drops a human actor before
// emitting); M4 writes only human reads, so the honest projection is none.
func TestProjectorHumanScopeReadIsSilent(t *testing.T) {
	fx := newFixture(t)
	seq := fx.insertMessage(fxGeneral, fxBob, "one")
	state, err := fx.store.MarkRead(fx.ctx(), fx.claims[fxAlice], fxWS, fxGeneral, seq)
	if err != nil {
		t.Fatal(err)
	}
	events, err := fx.store.ProjectPublication(fx.ctx(), fx.claims[fxAlice],
		intentOf("scope_read:updated", fxGeneral, state.ReadStateVersion))
	if err != nil {
		t.Fatal(err)
	}
	if len(events) != 0 {
		t.Fatalf("human scope_read projected: %+v", events)
	}
}
