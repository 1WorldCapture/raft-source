package readstate

import "errors"

// Wire error codes kept byte-identical with the legacy handlers.
const (
	CodeDoneFrontierRequired     = "DONE_FRONTIER_REQUIRED"
	CodeDoneFrontierBeyondLatest = "DONE_FRONTIER_BEYOND_LATEST"
	CodeDoneFrontierAboveInt4    = "DONE_FRONTIER_ABOVE_INT4_AUTHORITY"
	CodeDoneFrontierSpaceNeeded  = "DONE_FRONTIER_SPACE_REQUIRED"
	CodeDoneFrontierUnmappable   = "DONE_FRONTIER_UNMAPPABLE"
	CodeNotAThread               = "NOT_A_THREAD"
)

// int4AuthorityMax is the legacy Done frontier ceiling kept for wire
// compatibility even though the Go storage is 64-bit: a bounded frontier
// above it stays a 409 until a future contract version explicitly widens it.
const int4AuthorityMax = 2147483647

// Error is a typed domain failure carrying the exact legacy message and a
// wire code. Transport maps Status() to the HTTP status; anything not a
// *Error is an infrastructure failure (500) and never an auth verdict.
type Error struct {
	Status  int
	Code    string
	Message string
}

func (e *Error) Error() string { return e.Message }

// AsError extracts a *Error, or nil for other errors.
func AsError(err error) *Error {
	var de *Error
	if errors.As(err, &de) {
		return de
	}
	return nil
}

func invalidInput(message string) *Error {
	return &Error{Status: 400, Code: "INVALID_INPUT", Message: message}
}

func notFound(message string) *Error {
	return &Error{Status: 404, Code: "NOT_FOUND", Message: message}
}

func forbidden(message string) *Error {
	return &Error{Status: 403, Code: "FORBIDDEN", Message: message}
}

func conflict(code, message string) *Error {
	return &Error{Status: 409, Code: code, Message: message}
}

func preconditionFailed(code, message string) *Error {
	return &Error{Status: 412, Code: code, Message: message}
}

// doneFrontierRequired ports DoneFrontierRequiredError: missing, non-string,
// zero or non-canonical decimal frontier.
func doneFrontierRequired(targetChannelID string) *Error {
	return &Error{
		Status:  400,
		Code:    CodeDoneFrontierRequired,
		Message: "Done requires a positive canonical-decimal throughActivitySeq for " + targetChannelID,
	}
}

// doneFrontierBeyondLatest ports DoneFrontierBeyondLatestError.
func doneFrontierBeyondLatest(targetChannelID, throughActivitySeq string, latest *int64) *Error {
	latestText := "null"
	if latest != nil {
		latestText = formatUint64(uint64(*latest))
	}
	return &Error{
		Status:  409,
		Code:    CodeDoneFrontierBeyondLatest,
		Message: "Done frontier " + throughActivitySeq + " is beyond current latest " + latestText + " for " + targetChannelID,
	}
}

// doneFrontierAboveInt4Authority ports DoneFrontierAboveInt4AuthorityError.
// The Go storage has no widen ledger, so the phase is always "unknown".
func doneFrontierAboveInt4Authority(targetChannelID, throughActivitySeq string) *Error {
	return &Error{
		Status:  409,
		Code:    CodeDoneFrontierAboveInt4,
		Message: "Done frontier " + throughActivitySeq + " exceeds the int4 rollback authority while read-cursor phase is unknown",
	}
}

// ErrTokenInvalid marks an in-transaction session/membership revalidation
// failure; the transport answers 401 exactly like auth.ErrTokenInvalid.
var ErrTokenInvalid = errors.New("invalid or expired session")
