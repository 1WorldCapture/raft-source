// Model and typed errors for the workspace domain.

package workspace

import (
	"encoding/json"
	"errors"
	"time"
)

// Domain error codes shared by the workspace use cases. Transport maps each
// code to the exact legacy HTTP status/body; setup/settings workers extend the
// taxonomy with their exact TS machine codes on top of these generics.
const (
	CodeInvalidInput = "INVALID_INPUT"
	CodeForbidden    = "FORBIDDEN"
	CodeNotFound     = "NOT_FOUND"
	CodeConflict     = "CONFLICT"
)

// DomainError is a typed business failure. Transport maps Code to the legacy
// status/shape; anything that is not a DomainError is an infrastructure
// failure and must never be mistaken for an authentication failure.
type DomainError struct {
	Code    string
	Message string
}

func (e *DomainError) Error() string { return e.Message }

// AsDomainError extracts a DomainError, or nil for ordinary wrapped errors.
func AsDomainError(err error) *DomainError {
	var de *DomainError
	if errors.As(err, &de) {
		return de
	}
	return nil
}

// Membership is one row of the user's real server list (TS getUserServers,
// ordered by the account-level switcher order and stamped with its version).
type Membership struct {
	ID                    string
	Name                  string
	AvatarURL             *string
	Slug                  string
	OwnerID               string
	OnboardingAgentID     *string
	HideHumansFromMembers bool
	Plan                  string
	PlanDowngradedAt      *time.Time
	Role                  string
	ServerPushMuted       bool
	CreatedAt             time.Time
	// ServerOrderVersion is the account-level ordering version, identical on
	// every item of one list response (TS serverOrderVersion).
	ServerOrderVersion int64
}

// ServerRecord is the full external server row (TS `servers` select) used by
// create/detail/profile responses. Nullable columns stay pointers so null and
// empty never interchange; timestamps marshal as UTC millisecond ISO-8601.
type ServerRecord struct {
	ID                             string
	Name                           string
	AvatarURL                      *string
	Slug                           string
	Kind                           string
	OwnerID                        string
	OnboardingAgentID              *string
	AgentAllChannelGreetingEnabled bool
	HideHumansFromMembers          bool
	PubliclyVisible                bool
	Plan                           string
	TranslationEnabled             bool
	ProgressAnnouncementsEnabled   bool
	PlanDowngradedAt               *time.Time
	DeletedAt                      *time.Time
	CreatedAt                      time.Time
	UpdatedAt                      time.Time
}

// milliTime renders a time as UTC ISO-8601 with millisecond precision, the
// legacy JSON.stringify(Date) wire shape (never Go nanoseconds or local time).
type milliTime struct{ t time.Time }

func (m milliTime) MarshalJSON() ([]byte, error) {
	return json.Marshal(m.t.UTC().Format("2006-01-02T15:04:05.000Z"))
}

// MarshalJSON keeps the exact external field set; no omitempty, so
// required fields stay explicit and nulls stay nulls.
func (r ServerRecord) MarshalJSON() ([]byte, error) {
	type wire struct {
		ID                             string     `json:"id"`
		Name                           string     `json:"name"`
		AvatarURL                      *string    `json:"avatarUrl"`
		Slug                           string     `json:"slug"`
		Kind                           string     `json:"kind"`
		OwnerID                        string     `json:"ownerId"`
		OnboardingAgentID              *string    `json:"onboardingAgentId"`
		AgentAllChannelGreetingEnabled bool       `json:"agentAllChannelGreetingEnabled"`
		HideHumansFromMembers          bool       `json:"hideHumansFromMembers"`
		PubliclyVisible                bool       `json:"publiclyVisible"`
		Plan                           string     `json:"plan"`
		TranslationEnabled             bool       `json:"translationEnabled"`
		ProgressAnnouncementsEnabled   bool       `json:"progressAnnouncementsEnabled"`
		PlanDowngradedAt               *milliTime `json:"planDowngradedAt"`
		DeletedAt                      *milliTime `json:"deletedAt"`
		CreatedAt                      milliTime  `json:"createdAt"`
		UpdatedAt                      milliTime  `json:"updatedAt"`
	}
	return json.Marshal(wire{
		ID:                             r.ID,
		Name:                           r.Name,
		AvatarURL:                      r.AvatarURL,
		Slug:                           r.Slug,
		Kind:                           r.Kind,
		OwnerID:                        r.OwnerID,
		OnboardingAgentID:              r.OnboardingAgentID,
		AgentAllChannelGreetingEnabled: r.AgentAllChannelGreetingEnabled,
		HideHumansFromMembers:          r.HideHumansFromMembers,
		PubliclyVisible:                r.PubliclyVisible,
		Plan:                           r.Plan,
		TranslationEnabled:             r.TranslationEnabled,
		ProgressAnnouncementsEnabled:   r.ProgressAnnouncementsEnabled,
		PlanDowngradedAt:               toMilli(r.PlanDowngradedAt),
		DeletedAt:                      toMilli(r.DeletedAt),
		CreatedAt:                      milliTime{r.CreatedAt},
		UpdatedAt:                      milliTime{r.UpdatedAt},
	})
}

func toMilli(t *time.Time) *milliTime {
	if t == nil {
		return nil
	}
	return &milliTime{*t}
}

// WorkspaceOrder is the account-level switcher order (TS
// ServerSwitcherOrderPreferences). ServerOrder is never null: an unset order
// is the empty array plus version 0.
type WorkspaceOrder struct {
	ServerOrder        []string `json:"serverOrder"`
	ServerOrderVersion int64    `json:"serverOrderVersion"`
}

// ProfilePatch carries the only fields PATCH /api/servers/:id may change.
// Absent fields are nil pointers so absent/null/false stay distinguishable;
// raw-JSON type errors are rejected by transport before reaching the domain.
type ProfilePatch struct {
	Name                  *string
	HideHumansFromMembers *bool
}

// Slug validation mirrors packages/shared serverSlugValidation.ts exactly:
// minimum 5 UTF-16 code units, ^[a-z][a-z0-9-]*$, with no trimming,
// lowercasing or new reserved words. Order matters: required, then length,
// then pattern — the same sequence clients observe in error messages.
const slugMinUTF16Length = 5

// validateSlug returns the legacy error sentence for an invalid slug, or "".
func validateSlug(slug string) string {
	if slug == "" {
		return "Slug is required"
	}
	if utf16Length(slug) < slugMinUTF16Length {
		return "Slug must be at least 5 characters"
	}
	if !slugPatternMatch(slug) {
		return "Slug must start with a letter and contain only lowercase letters, numbers, and hyphens"
	}
	return ""
}

func slugPatternMatch(slug string) bool {
	if slug == "" {
		return false
	}
	for i := 0; i < len(slug); i++ {
		c := slug[i]
		switch {
		case c >= 'a' && c <= 'z', c >= '0' && c <= '9', c == '-':
		default:
			return false
		}
	}
	first := slug[0]
	return first != '-' && !(first >= '0' && first <= '9')
}

// utf16Length counts UTF-16 code units the way TS string.length does: astral
// characters (emoji) count as two, so legacy boundaries are not silently
// converted to byte or rune counts.
func utf16Length(s string) int {
	units := 0
	for _, r := range s {
		if r > 0xFFFF {
			units += 2
		} else {
			units++
		}
	}
	return units
}

// validateProfileName applies the TS PATCH rule (NOT the create rule, see
// design §7.1/D01): trim, non-empty, at most 100 UTF-16 code units. The
// trimmed value is what gets stored.
func validateProfileName(name string) (string, string) {
	trimmed := trimECMAScriptSpace(name)
	if trimmed == "" {
		return "", "Name is required"
	}
	if utf16Length(trimmed) > 100 {
		return "", "Name must be 100 characters or fewer"
	}
	return trimmed, ""
}
