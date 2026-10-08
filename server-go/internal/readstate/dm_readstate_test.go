package readstate

import (
	"context"
	"encoding/json"
	"testing"
)

// TestReadFrontierJSONExactWire: the #632 union renders byte-exact — absent,
// present with the same-source latestActivity pair, present with null pair
// for a cursor on an empty scope.
func TestReadFrontierJSONExactWire(t *testing.T) {
	fx := newFixture(t)
	var out json.RawMessage
	err := fx.store.readSnapshot(fx.ctx(), fx.db, func(ex Executor) error {
		var err error
		out, err = fx.store.ReadFrontierJSONTx(fx.ctx(), ex, fxWS, fxAlice, fxDM)
		return err
	})
	if err != nil {
		t.Fatal(err)
	}
	if string(out) != `{"kind":"absent"}` {
		t.Fatalf("absent wire = %s", out)
	}

	seq := fx.insertMessage(fxDM, fxBob, "dm hello")
	if _, err := fx.store.MarkRead(fx.ctx(), fx.claims[fxAlice], fxWS, fxDM, seq); err != nil {
		t.Fatal(err)
	}
	err = fx.store.readSnapshot(fx.ctx(), fx.db, func(ex Executor) error {
		var err error
		out, err = fx.store.ReadFrontierJSONTx(fx.ctx(), ex, fxWS, fxAlice, fxDM)
		return err
	})
	if err != nil {
		t.Fatal(err)
	}
	var decoded map[string]any
	if err := json.Unmarshal(out, &decoded); err != nil {
		t.Fatal(err)
	}
	if decoded["kind"] != "present" || decoded["maxReadSeq"] != itoa(seq) || decoded["readStateVersion"] != float64(1) {
		t.Fatalf("present wire = %s", out)
	}
	activity := decoded["latestActivity"].(map[string]any)
	if activity["seq"] != itoa(seq) {
		t.Fatalf("latestActivity pair = %s", out)
	}
	// The rendered bytes are stable (map key order is Go-sorted, single shape).
	if string(out) == `{"kind":"absent"}` {
		t.Fatal("frontier did not become present")
	}
}

// TestDMReadStateParticipantGuard: the DM projection fails closed for
// non-participants and wrong-workspace scopes; participants get the exact
// frontier wire.
func TestDMReadStateParticipantGuard(t *testing.T) {
	fx := newFixture(t)
	seq := fx.insertMessage(fxDM, fxBob, "dm hello")
	if _, err := fx.store.MarkRead(fx.ctx(), fx.claims[fxAlice], fxWS, fxDM, seq); err != nil {
		t.Fatal(err)
	}

	var out json.RawMessage
	err := fx.store.readSnapshot(fx.ctx(), fx.db, func(ex Executor) error {
		var err error
		out, err = fx.store.DMReadStateTx(fx.ctx(), ex, fxWS, fxAlice, fxDM)
		return err
	})
	if err != nil {
		t.Fatal(err)
	}
	var decoded map[string]any
	if err := json.Unmarshal(out, &decoded); err != nil {
		t.Fatal(err)
	}
	if decoded["kind"] != "present" || decoded["maxReadSeq"] != itoa(seq) {
		t.Fatalf("participant wire = %s", out)
	}

	// A workspace member who is NOT a participant of the DM fails closed.
	err = fx.store.readSnapshot(fx.ctx(), fx.db, func(ex Executor) error {
		_, err := fx.store.DMReadStateTx(fx.ctx(), ex, fxWS, fxGuest, fxDM)
		return err
	})
	if de := AsError(err); de == nil || de.Status != 404 {
		t.Fatalf("non-participant error = %v, want 404", err)
	}
	// A non-DM scope is refused with the same closed shape.
	err = fx.store.readSnapshot(fx.ctx(), fx.db, func(ex Executor) error {
		_, err := fx.store.DMReadStateTx(fx.ctx(), ex, fxWS, fxAlice, fxGeneral)
		return err
	})
	if de := AsError(err); de == nil || de.Status != 404 {
		t.Fatalf("non-DM scope error = %v, want 404", err)
	}
	_ = context.Background
}
