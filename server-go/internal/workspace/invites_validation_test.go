package workspace

import (
	"strings"
	"testing"
)

// These cases pin shared/emailValidation.ts, rather than the older account
// validator: JS UTF-16 limits, domain boundaries, whitespace and exact copy.
func TestInviteEmailValidationMatchesSharedContract(t *testing.T) {
	const invalid = "Enter a valid email address"
	for _, tc := range []struct {
		name, email, want string
	}{
		{"empty", "", "Email is required"},
		{"blank BOM", " \ufeff\u00a0 ", "Email is required"},
		{"normal", "dev@example.com", ""},
		{"trim", "\ufeff Dev@Example.com\u00a0", ""},
		{"comma allowed by shared validator", "a,b@example.com", ""},
		{"missing at", "not-an-email", invalid},
		{"multiple at", "a@b@example.com", invalid},
		{"empty local", "@example.com", invalid},
		{"no dot", "a@localhost", invalid},
		{"leading dot", "a@.example.com", invalid},
		{"trailing dot", "a@example.com.", invalid},
		{"double dot", "a@example..com", invalid},
		{"ASCII space", "a b@example.com", invalid},
		{"unicode space", "a\u00a0b@example.com", invalid},
		{"embedded BOM", "a\ufeffb@example.com", invalid},
		{"64 local units", strings.Repeat("a", 64) + "@example.com", ""},
		{"65 local units", strings.Repeat("a", 65) + "@example.com", invalid},
		{"64 astral local units", strings.Repeat("😀", 32) + "@example.com", ""},
		{"66 astral local units", strings.Repeat("😀", 33) + "@example.com", invalid},
		{"254 units", "a@" + strings.Repeat("b", 250) + ".c", ""},
		{"255 units", "a@" + strings.Repeat("b", 251) + ".c", invalid},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if got := ValidateInviteEmail(tc.email); got != tc.want {
				t.Fatalf("validation = %q, want %q", got, tc.want)
			}
		})
	}
	if got := inviteNormalizedEmail("\ufeff Dev@Example.com\u00a0"); got != "dev@example.com" {
		t.Fatalf("normalized email = %q", got)
	}
}
