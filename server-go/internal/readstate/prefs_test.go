package readstate

import "testing"

// TestMuteLifecycle: muting captures the boundary at latest+1, unmuting
// clears it, and same-value PATCHes keep the version untouched.
func TestMuteLifecycle(t *testing.T) {
	fx := newFixture(t)
	seq := fx.insertMessage(fxGeneral, fxBob, "one")

	state, err := fx.store.SetNotificationSettings(fx.ctx(), fx.claims[fxAlice], fxWS, fxGeneral, true)
	if err != nil {
		t.Fatal(err)
	}
	if !state.ActivityMuted || state.MuteFromSeq == nil || *state.MuteFromSeq != seq+1 {
		t.Fatalf("mute state = %+v, want boundary %d", state, seq+1)
	}
	if state.PrefsVersion != 1 {
		t.Fatalf("first mute version = %d", state.PrefsVersion)
	}
	// Same-value PATCH is an honest no-op.
	same, err := fx.store.SetNotificationSettings(fx.ctx(), fx.claims[fxAlice], fxWS, fxGeneral, true)
	if err != nil {
		t.Fatal(err)
	}
	if same.Changed || same.PrefsVersion != 1 {
		t.Fatalf("same-value mute = %+v", same)
	}
	// Unmute clears the boundary and bumps the version.
	off, err := fx.store.SetNotificationSettings(fx.ctx(), fx.claims[fxAlice], fxWS, fxGeneral, false)
	if err != nil {
		t.Fatal(err)
	}
	if off.ActivityMuted || off.MuteFromSeq != nil || off.PrefsVersion != 2 {
		t.Fatalf("unmute = %+v", off)
	}
	// Reads agree with the writes.
	read, err := fx.store.NotificationSettings(fx.ctx(), fx.claims[fxAlice], fxWS, fxGeneral)
	if err != nil {
		t.Fatal(err)
	}
	if read.ActivityMuted || read.PrefsVersion != 2 {
		t.Fatalf("read-back = %+v", read)
	}
	if !read.ActivityMuteSupported {
		t.Fatal("public channel must report activityMuteSupported")
	}
}

// TestMuteNeverMovesReadState: mute never advances the read cursor.
func TestMuteNeverMovesReadState(t *testing.T) {
	fx := newFixture(t)
	fx.insertMessage(fxGeneral, fxBob, "one")
	if _, err := fx.store.SetNotificationSettings(fx.ctx(), fx.claims[fxAlice], fxWS, fxGeneral, true); err != nil {
		t.Fatal(err)
	}
	if _, _, present := fx.readStateRow(fxAlice, fxGeneral); present {
		t.Fatal("mute wrote a read cursor")
	}
}

// TestMentionPiercesMute: a personally-mentioning message still promotes the
// channel row while the channel is muted.
func TestMentionPiercesMute(t *testing.T) {
	fx := newFixture(t)
	fx.insertMessage(fxGeneral, fxBob, "noise one")
	beforeBoundary := fx.insertMessage(fxGeneral, fxBob, "noise two")
	if _, err := fx.store.SetNotificationSettings(fx.ctx(), fx.claims[fxAlice], fxWS, fxGeneral, true); err != nil {
		t.Fatal(err)
	}
	// Post-boundary noise must not promote: the row keeps its pre-mute
	// frontier (mute suppresses future promotion, it never hides history).
	fx.insertMessage(fxGeneral, fxBob, "muted noise")
	page, err := fx.store.InboxItems(fx.ctx(), fx.claims[fxAlice], fxWS, InboxQuery{Filter: FilterAll, Limit: 30})
	if err != nil {
		t.Fatal(err)
	}
	if len(page.Items) != 1 {
		t.Fatalf("muted channel vanished entirely: %+v", page.Items)
	}
	// The promoted latest is the newest message BELOW the mute boundary.
	if got := *page.Items[0].LatestActivitySeq; got != beforeBoundary {
		t.Fatalf("promoted seq = %d, want pre-boundary %d", got, beforeBoundary)
	}
	// A personal mention pierces the mute and becomes the frontier.
	mentionSeq := fx.insertMessage(fxGeneral, fxBob, "ping", fxAlice)
	page, err = fx.store.InboxItems(fx.ctx(), fx.claims[fxAlice], fxWS, InboxQuery{Filter: FilterAll, Limit: 30})
	if err != nil {
		t.Fatal(err)
	}
	if len(page.Items) != 1 {
		t.Fatalf("mention must keep the row alive: %+v", page.Items)
	}
	if got := *page.Items[0].LatestActivitySeq; got != mentionSeq {
		t.Fatalf("promoted seq = %d, want the mention %d", got, mentionSeq)
	}
	if !page.Items[0].HasMention || page.Items[0].FirstMentionMessageID == nil {
		t.Fatalf("mention facts missing: %+v", page.Items[0])
	}
}

// TestDisplayPrefsIndependentDomain: display prefs default, persist, no-op
// and version independently of the mute domain.
func TestDisplayPrefsIndependentDomain(t *testing.T) {
	fx := newFixture(t)
	prefs, err := fx.store.DisplaySettings(fx.ctx(), fx.claims[fxAlice], fxWS, fxGeneral)
	if err != nil {
		t.Fatal(err)
	}
	if !prefs.CollapseLongMessages || prefs.PrefsVersion != 0 {
		t.Fatalf("default display prefs = %+v", prefs)
	}
	updated, err := fx.store.SetDisplaySettings(fx.ctx(), fx.claims[fxAlice], fxWS, fxGeneral, false)
	if err != nil {
		t.Fatal(err)
	}
	if updated.CollapseLongMessages || updated.PrefsVersion != 1 || !updated.Changed {
		t.Fatalf("collapse off = %+v", updated)
	}
	same, err := fx.store.SetDisplaySettings(fx.ctx(), fx.claims[fxAlice], fxWS, fxGeneral, false)
	if err != nil {
		t.Fatal(err)
	}
	if same.Changed || same.PrefsVersion != 1 {
		t.Fatalf("same-value display patch = %+v", same)
	}
	// Mute writes leave the display domain untouched.
	if _, err := fx.store.SetNotificationSettings(fx.ctx(), fx.claims[fxAlice], fxWS, fxGeneral, true); err != nil {
		t.Fatal(err)
	}
	prefs, err = fx.store.DisplaySettings(fx.ctx(), fx.claims[fxAlice], fxWS, fxGeneral)
	if err != nil {
		t.Fatal(err)
	}
	if prefs.PrefsVersion != 1 {
		t.Fatalf("display version drifted to %d", prefs.PrefsVersion)
	}
}

// TestPrefsThreadScopeRefused: thread channels answer the exact 400.
func TestPrefsThreadScopeRefused(t *testing.T) {
	fx := newFixture(t)
	fx.seedThreadParents()
	_, err := fx.store.NotificationSettings(fx.ctx(), fx.claims[fxAlice], fxWS, fxThread)
	de := AsError(err)
	if de == nil || de.Status != 400 || de.Message != "Thread notification settings are managed via follow/unfollow" {
		t.Fatalf("thread prefs error = %v", err)
	}
	_, err = fx.store.DisplaySettings(fx.ctx(), fx.claims[fxAlice], fxWS, fxThread)
	de = AsError(err)
	if de == nil || de.Status != 400 || de.Message != "Thread message display settings are managed by the parent channel" {
		t.Fatalf("thread display error = %v", err)
	}
}
