package message

import "errors"

// Domain failure taxonomy. The humanapi transport maps each error to the
// exact legacy TS status/body; unknown errors stay 500 and never become an
// authentication failure.

// UnsupportedEffect marks input that names an M4-disabled capability
// (attachments, asTask, agent mention actions, agent DM...). It must surface
// as HTTP 501 feature_not_implemented BEFORE any write, never as a fake
// success and never as a silent drop.
type UnsupportedEffect struct{ Reason string }

func (e *UnsupportedEffect) Error() string { return e.Reason }

// AsUnsupportedEffect extracts the typed effect, or nil.
func AsUnsupportedEffect(err error) *UnsupportedEffect {
	var e *UnsupportedEffect
	if errors.As(err, &e) {
		return e
	}
	return nil
}

// InvalidInput marks request shapes/values rejected exactly like the TS
// parsers (empty content, UTF-16 length overflow, bad randomId, malformed
// mentions...). HTTP 400 with the legacy sentence.
type InvalidInput struct{ Reason string }

func (e *InvalidInput) Error() string { return e.Reason }

// AsInvalidInput extracts the typed input failure, or nil.
func AsInvalidInput(err error) *InvalidInput {
	var e *InvalidInput
	if errors.As(err, &e) {
		return e
	}
	return nil
}

// RandomIDConflict ports UserRandomIdConflictError: the same
// (sender_type, sender_id, random_id) was already committed with a different
// request digest. HTTP 409 {"error":...,"code":"random_id_conflict"}.
type RandomIDConflict struct{ Reason string }

func (e *RandomIDConflict) Error() string { return e.Reason }

// AsRandomIDConflict extracts the typed conflict, or nil.
func AsRandomIDConflict(err error) *RandomIDConflict {
	var e *RandomIDConflict
	if errors.As(err, &e) {
		return e
	}
	return nil
}

// ErrMessageNotFound selects the legacy 404 "Message not found" path.
var ErrMessageNotFound = errors.New("Message not found")

// ErrChannelArchived maps to 409 {"error":"This channel is archived",
// "code":"channel_archived"} exactly like the TS catch.
var ErrChannelArchived = errors.New("This channel is archived")

// ErrNoChannelAccess maps to the denyChannelAccess split (403 prior
// relationship / 404 otherwise) decided by the transport with channel facts.
var ErrNoChannelAccess = errors.New("no access to this channel")

// ErrNotChannelMember maps to the TS posting denial 403 "You must join this
// channel to send messages" (and the react variant chosen by the caller).
type ErrNotChannelMember struct{ Action string }

func (e *ErrNotChannelMember) Error() string {
	if e.Action == "" {
		return "You must join this channel to send messages"
	}
	return "You must join this channel to " + e.Action
}

// ErrSystemMessage maps to 400 "System messages cannot receive reactions".
var ErrSystemMessage = errors.New("System messages cannot receive reactions")

// ReactionActorsCursorError marks a malformed reaction-actors cursor.
type ReactionActorsCursorError struct{}

func (ReactionActorsCursorError) Error() string { return "Invalid reaction actors cursor" }

// ReactionDiscussionChanged ports ReactionDiscussionVersionChangedError.
type ReactionDiscussionChanged struct{ CurrentVersion int64 }

func (e *ReactionDiscussionChanged) Error() string {
	return "Reaction discussion changed while reading this page"
}

// ReactionVisibilityChanged ports ReactionActorVisibilityChangedError.
type ReactionVisibilityChanged struct{}

func (e *ReactionVisibilityChanged) Error() string {
	return "Reaction actor visibility changed while reading this page"
}

// MentionBindingConflict ports the TS v2 MentionValidationError with code
// mention_binding_conflict: one handle bound to more than one actor.
type MentionBindingConflict struct{ Handle string }

func (e *MentionBindingConflict) Error() string {
	return "Mention @" + e.Handle + " is bound to more than one actor. Select exactly one actor id and type."
}

// AsMentionBindingConflict extracts the typed binding failure, or nil.
func AsMentionBindingConflict(err error) *MentionBindingConflict {
	var e *MentionBindingConflict
	if errors.As(err, &e) {
		return e
	}
	return nil
}
