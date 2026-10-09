package readstate

import (
	"testing"
)

// TestReadFrontierTypedFacts: the #632 frontier FACTS carry the same-source
// latest-activity pairing — absent is Present-by-kind with no invented
// values, present carries version/maxReadSeq and the scope's newest message
// pair from the same snapshot (the wire rendering lives in the presenter).
func TestReadFrontierTypedFacts(t *testing.T) {
	fx := newFixture(t)
	var frontier *ReadFrontier
	err := fx.store.readSnapshot(fx.ctx(), fx.db, func(ex Executor) error {
		var err error
		frontier, err = fx.store.ReadFrontierTx(fx.ctx(), ex, fxWS, fxAlice, fxDM)
		return err
	})
	if err != nil {
		t.Fatal(err)
	}
	if frontier.Kind != "absent" || frontier.LatestValid {
		t.Fatalf("absent facts = %+v", frontier)
	}

	seq := fx.insertMessage(fxDM, fxBob, "dm hello")
	if _, err := fx.store.MarkRead(fx.ctx(), fx.claims[fxAlice], fxWS, fxDM, seq); err != nil {
		t.Fatal(err)
	}
	err = fx.store.readSnapshot(fx.ctx(), fx.db, func(ex Executor) error {
		var err error
		frontier, err = fx.store.ReadFrontierTx(fx.ctx(), ex, fxWS, fxAlice, fxDM)
		return err
	})
	if err != nil {
		t.Fatal(err)
	}
	if frontier.Kind != "present" || frontier.MaxReadSeq != seq || frontier.Version != 1 {
		t.Fatalf("present facts = %+v", frontier)
	}
	if !frontier.LatestValid || frontier.LatestSeq != seq || frontier.LatestID == "" {
		t.Fatalf("latest activity pair = %+v", frontier)
	}

	// A scope with a message but no cursor row reads the newest pair as the
	// latest activity while the frontier itself stays absent.
	err = fx.store.readSnapshot(fx.ctx(), fx.db, func(ex Executor) error {
		var err error
		frontier, err = fx.store.ReadFrontierTx(fx.ctx(), ex, fxWS, fxBob, fxDM)
		return err
	})
	if err != nil {
		t.Fatal(err)
	}
	if frontier.Kind != "absent" || frontier.LatestValid {
		t.Fatalf("uncursored scope facts = %+v", frontier)
	}
}

// TestDMReadFrontierParticipantGuard: the DM facts projection fails closed
// for non-participants and wrong-workspace scopes; participants get their
// frontier facts.
func TestDMReadFrontierParticipantGuard(t *testing.T) {
	fx := newFixture(t)
	seq := fx.insertMessage(fxDM, fxBob, "dm hello")
	if _, err := fx.store.MarkRead(fx.ctx(), fx.claims[fxAlice], fxWS, fxDM, seq); err != nil {
		t.Fatal(err)
	}

	var frontier *ReadFrontier
	err := fx.store.readSnapshot(fx.ctx(), fx.db, func(ex Executor) error {
		var err error
		frontier, err = fx.store.DMReadFrontierTx(fx.ctx(), ex, fxWS, fxAlice, fxDM)
		return err
	})
	if err != nil {
		t.Fatal(err)
	}
	if frontier.Kind != "present" || frontier.MaxReadSeq != seq {
		t.Fatalf("participant facts = %+v", frontier)
	}

	// A workspace member who is NOT a participant of the DM fails closed.
	err = fx.store.readSnapshot(fx.ctx(), fx.db, func(ex Executor) error {
		_, err := fx.store.DMReadFrontierTx(fx.ctx(), ex, fxWS, fxGuest, fxDM)
		return err
	})
	if de := AsError(err); de == nil || de.Status != 404 {
		t.Fatalf("non-participant error = %v, want 404", err)
	}
	// A non-DM scope is refused with the same closed shape.
	err = fx.store.readSnapshot(fx.ctx(), fx.db, func(ex Executor) error {
		_, err := fx.store.DMReadFrontierTx(fx.ctx(), ex, fxWS, fxAlice, fxGeneral)
		return err
	})
	if de := AsError(err); de == nil || de.Status != 404 {
		t.Fatalf("non-DM scope error = %v, want 404", err)
	}
}
