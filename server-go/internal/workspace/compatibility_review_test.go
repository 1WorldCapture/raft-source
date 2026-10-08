package workspace

import "testing"

// ECMAScript String.prototype.trim uses WhiteSpace + LineTerminator, not Go's
// Unicode White_Space set. In particular BOM is trimmed; U+0085 NEL is not.
// These cases protect the original PATCH name rule, not a new validation rule.
func TestM2ProfileNameECMAScriptWhitespace(t *testing.T) {
	for _, tc := range []struct {
		name         string
		input        string
		want         string
		errorMessage string
	}{
		{name: "BOM around name", input: "\ufeffTeam\ufeff", want: "Team"},
		{name: "only BOM", input: "\ufeff", errorMessage: "Name is required"},
		{name: "NEL remains name", input: "\u0085", want: "\u0085"},
		{name: "NEL not removed at edge", input: "\u0085Team\u0085", want: "\u0085Team\u0085"},
		{name: "nonbreaking spaces", input: "\u00a0\u202fTeam\u3000", want: "Team"},
		{name: "line separators", input: "\u2028Team\u2029", want: "Team"},
		{name: "zero-width space remains", input: "\u200b", want: "\u200b"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			got, message := validateProfileName(tc.input)
			if got != tc.want || message != tc.errorMessage {
				t.Fatalf("PATCH trim mismatch: got %q/%q; want %q/%q", got, message, tc.want, tc.errorMessage)
			}
		})
	}
}
