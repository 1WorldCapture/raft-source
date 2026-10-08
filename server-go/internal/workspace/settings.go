// Aggregated settings and onboarding preference reads/writes (M2 settings
// worker): GET/PATCH /api/servers/:id/onboarding-settings and the aggregated
// GET /api/servers/:id/settings.
//
// Contract sources:
//   - packages/server/src/services/serverSettingsService.ts (R07): the
//     aggregated {settings:{onboardSettings, feedbackSettings}} shape;
//   - packages/server/src/routes/servers.ts:1378-1536 (R02/R23): the PATCH
//     field matrix, exact validation sentences and their order, the alias
//     precedence setupModalReminderOptOut ?? onboardingReminderOptOut, and the
//     manager-field permission gate;
//   - packages/server/src/services/serverService.ts:445-465,504-545 (R23):
//     onboarding settings reads/writes and the configured-agent checkpoint.
//
// Legacy behavior intentionally preserved here:
//   - The aggregated response always exposes both reminder aliases pointing at
//     the same stored fact (setup_modal_reminder_opt_out).
//   - dismissal=true stamps "now", dismissal=false clears to null; neither
//     ever touches workspace_member_setup (setup truth is a separate fact).
//   - A non-empty onboardingAgentId is validated against the real agent
//     directory (setup worker helper) inside the same transaction, and an
//     authorized setter then reconciles incomplete owners to
//     complete/grandfathered without repeating official-identity validation —
//     this is deliberately NOT the same rule as explicit setup complete.
//   - Unlike legacy TS, which ran the server update and the member preference
//     update as two separate writes, all effects of one PATCH commit in a
//     single SQLite transaction (approved M2 improvement; success responses
//     are unchanged).
package workspace

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"time"
)

// Exact legacy error sentences for these endpoints. The transport layer maps
// DomainError.Code to the status and uses Message as the {error:...} body.
const (
	errMsgServerNotFound   = "Server not found"
	errMsgGuestsManagement = "Guests cannot access server management data"
)

// onboardingWizardSteps is the closed step set of the retired owner wizard
// (routes/servers.ts:104). It is a legacy UI preference, not setup truth.
var onboardingWizardSteps = map[string]bool{
	"add-computer":         true,
	"detect-runtime":       true,
	"create-agent":         true,
	"referral-source":      true,
	"invite-teammates":     true,
	"join-community":       true,
	"enable-notifications": true,
	"complete":             true,
}

// querier is satisfied by both *sql.DB and *sql.Tx so reads can join the
// caller's transaction.
type querier interface {
	QueryRowContext(ctx context.Context, query string, args ...any) *sql.Row
}

// GetSettings returns the aggregated settings payload:
// {settings:{onboardSettings:..., feedbackSettings:{enabled:...}}}.
// feedbackSettings.enabled comes from the frozen local policy vector (C0:
// unconfigured feedback => false); it is never inferred from other data.
func (s *Store) GetSettings(ctx context.Context, workspaceID, userID string) (map[string]any, error) {
	onboard, err := s.readOnboardingSettings(ctx, s.db, workspaceID, userID)
	if err != nil {
		return nil, err
	}
	return map[string]any{
		"settings": map[string]any{
			"onboardSettings":  onboard,
			"feedbackSettings": map[string]any{"enabled": s.policy.FeedbackEnabled},
		},
	}, nil
}

// GetOnboardingSettings returns the inner onboardSettings projection shared by
// the legacy GET /onboarding-settings endpoint and PATCH responses.
func (s *Store) GetOnboardingSettings(ctx context.Context, workspaceID, userID string) (map[string]any, error) {
	return s.readOnboardingSettings(ctx, s.db, workspaceID, userID)
}

// onboardingRead is one joined workspace+membership+preferences read.
type onboardingRead struct {
	role              string
	slug              string
	onboardingAgentID sql.NullString
	greeting          sql.NullInt64
	prefs             memberPrefs
}

// memberPrefs carries the stored per-member onboarding preference columns.
type memberPrefs struct {
	exists                bool
	setupReminderOptOut   sql.NullInt64
	dismissedAdd          sql.NullInt64
	dismissedCreate       sql.NullInt64
	dismissedInvite       sql.NullInt64
	dismissedCommunity    sql.NullInt64
	dismissedNotification sql.NullInt64
	wizardStep            sql.NullString
	dmSentAt              sql.NullInt64
	dmSentByAgentID       sql.NullString
	// reminderTrue is the 0/1 column resolved after the scan (the LEFT JOIN
	// yields NULL for a missing preference row).
	reminderTrue bool
}

// readOnboardingSettings loads the workspace onboarding columns and the
// caller's preference row in one query. Any missing fact (workspace deleted,
// membership gone, preferences row gone) is the legacy 404 "Server not found":
// the aggregated reader answers null in all those cases.
func (s *Store) readOnboardingSettings(ctx context.Context, q querier, workspaceID, userID string) (map[string]any, error) {
	var read onboardingRead
	var prefsPresent int
	err := q.QueryRowContext(ctx, `
		SELECT w.onboarding_agent_id, w.agent_all_channel_greeting_enabled, w.slug, m.role,
		       p.workspace_id IS NOT NULL,
		       p.setup_modal_reminder_opt_out,
		       p.dismissed_add_computer_step_at, p.dismissed_create_agent_step_at,
		       p.dismissed_invite_step_at, p.dismissed_community_step_at,
		       p.dismissed_notification_step_at,
		       p.onboarding_wizard_current_step,
		       p.onboarding_dm_sent_at, p.onboarding_dm_sent_by_agent_id
		FROM workspaces w
		JOIN workspace_memberships m ON m.workspace_id = w.id AND m.user_id = ?
		LEFT JOIN workspace_member_preferences p ON p.workspace_id = w.id AND p.user_id = m.user_id
		WHERE w.id = ? AND w.deleted_at IS NULL`,
		userID, workspaceID).
		Scan(&read.onboardingAgentID, &read.greeting, &read.slug, &read.role,
			&prefsPresent,
			&read.prefs.setupReminderOptOut,
			&read.prefs.dismissedAdd, &read.prefs.dismissedCreate,
			&read.prefs.dismissedInvite, &read.prefs.dismissedCommunity,
			&read.prefs.dismissedNotification,
			&read.prefs.wizardStep,
			&read.prefs.dmSentAt, &read.prefs.dmSentByAgentID)
	if err == sql.ErrNoRows {
		return nil, &DomainError{Code: CodeNotFound, Message: errMsgServerNotFound}
	} else if err != nil {
		return nil, err
	}
	read.prefs.exists = prefsPresent != 0
	if !read.prefs.exists {
		// Creation writes a preferences row for every membership, so a missing
		// row is integrity drift; fail with the legacy 404 rather than
		// inventing defaults.
		return nil, &DomainError{Code: CodeNotFound, Message: errMsgServerNotFound}
	}
	if read.role == "guest" {
		// Legacy TS gates guests off these surfaces in middleware; the domain
		// check keeps the same observable contract.
		return nil, &DomainError{Code: CodeForbidden, Message: errMsgGuestsManagement}
	}
	if read.prefs.setupReminderOptOut.Valid && read.prefs.setupReminderOptOut.Int64 != 0 {
		read.prefs.reminderTrue = true
	}
	return s.buildOnboardingSettings(read), nil
}

// buildOnboardingSettings renders the exact onboardSettings field set,
// including both reminder aliases and null (never absent) nullable fields.
func (s *Store) buildOnboardingSettings(read onboardingRead) map[string]any {
	var agentID any
	if read.onboardingAgentID.Valid {
		agentID = read.onboardingAgentID.String
	}
	// Legacy renders greeting with `!== false`: only an explicit false is
	// false; a missing/NULL column reads as true.
	greeting := true
	if read.greeting.Valid && read.greeting.Int64 == 0 {
		greeting = false
	}
	// The wizard flag is slug-gated community override + frozen policy flag
	// (feature missing => disabled, C0).
	wizardEnabled := s.policy.OnboardingOwnerWizardV0 &&
		read.slug != "community" && read.slug != "community-cn"

	var wizardStep any
	if read.prefs.wizardStep.Valid {
		wizardStep = read.prefs.wizardStep.String
	}
	var dmSentBy any
	if read.prefs.dmSentByAgentID.Valid {
		dmSentBy = read.prefs.dmSentByAgentID.String
	}
	return map[string]any{
		"onboardingAgentId":              agentID,
		"agentAllChannelGreetingEnabled": greeting,
		"onboardingWizardEnabled":        wizardEnabled,
		"setupModalReminderOptOut":       read.prefs.reminderTrue,
		// Backward-compatible alias for older clients: same stored fact.
		"onboardingReminderOptOut":    read.prefs.reminderTrue,
		"dismissedAddComputerStepAt":  formatMillis(read.prefs.dismissedAdd),
		"dismissedCreateAgentStepAt":  formatMillis(read.prefs.dismissedCreate),
		"dismissedInviteStepAt":       formatMillis(read.prefs.dismissedInvite),
		"dismissedCommunityStepAt":    formatMillis(read.prefs.dismissedCommunity),
		"dismissedNotificationStepAt": formatMillis(read.prefs.dismissedNotification),
		"onboardingWizardCurrentStep": wizardStep,
		"onboardingDmSentAt":          formatMillis(read.prefs.dmSentAt),
		"onboardingDmSentByAgentId":   dmSentBy,
	}
}

// UpdateOnboardingSettings applies one PATCH /onboarding-settings request.
// fields is the raw decoded JSON body: absent, null, false and "" are distinct
// inputs. All effects commit in one transaction; on any validation or write
// error nothing is persisted.
func (s *Store) UpdateOnboardingSettings(ctx context.Context, workspaceID, userID string, fields map[string]any) (map[string]any, error) {
	spec, derr := parseOnboardingSettingsPatch(fields)
	if derr != nil {
		return nil, derr
	}

	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback() }()

	var role, slug string
	var agentID sql.NullString
	var greeting sql.NullInt64
	err = tx.QueryRowContext(ctx, `
		SELECT m.role, w.slug, w.onboarding_agent_id, w.agent_all_channel_greeting_enabled
		FROM workspace_memberships m
		JOIN workspaces w ON w.id = m.workspace_id
		WHERE m.workspace_id = ? AND m.user_id = ? AND w.deleted_at IS NULL`,
		workspaceID, userID).Scan(&role, &slug, &agentID, &greeting)
	if err == sql.ErrNoRows {
		return nil, &DomainError{Code: CodeNotFound, Message: errMsgServerNotFound}
	} else if err != nil {
		return nil, err
	}
	if role == "guest" {
		return nil, &DomainError{Code: CodeForbidden, Message: errMsgGuestsManagement}
	}
	if spec.hasManagerFields && !CanManage(role) {
		return nil, &DomainError{Code: CodeForbidden, Message: "Only server owners and admins can update onboarding settings"}
	}

	// An empty (but present) onboardingAgentId reproduces the legacy uuid
	// failure path (release-reviewed decision): in TS the string passes the
	// route type checks and the falsy agent lookup is skipped, then the
	// PostgreSQL uuid column rejects "" inside the write transaction — the
	// route catch answers the ordinary endpoint 500 and nothing persists.
	// Return a plain error (transport maps it to that 500, never a business
	// 400/403 shape) before any write, so the whole PATCH — manager fields,
	// preferences and reconcile included — rolls back.
	if agentValue, ok := spec.agentValue.(string); ok && agentValue == "" {
		return nil, fmt.Errorf("onboarding_agent_id %q is not a valid uuid (legacy uuid-column failure)", agentValue)
	}

	// A non-empty agent id must resolve to a real, active, same-workspace
	// agent (the config-setter rule; official identity is NOT re-checked
	// here — that rule belongs to explicit setup complete only).
	if agentValue, ok := spec.agentValue.(string); ok && agentValue != "" {
		if err := validateConfiguredAgentTx(ctx, tx, workspaceID, agentValue); err != nil {
			var de *DomainError
			if errors.As(err, &de) {
				// Normalize to the exact W11 contract sentence regardless of
				// the helper's internal code (agreed with the setup worker).
				return nil, &DomainError{Code: CodeInvalidInput, Message: "Onboarding agent not found in this server"}
			}
			return nil, err
		}
	}

	if spec.hasManagerFields {
		now := s.now()
		sets := "updated_at = ?"
		args := []any{now.UnixMilli()}
		if spec.agentSet {
			// Distinguish absent (no write) from null (clear); the empty
			// string never reaches this write — the guard above fails the
			// request first, matching the legacy uuid-column failure.
			if v, ok := spec.agentValue.(string); ok {
				args = append(args, v)
			} else {
				args = append(args, nil)
			}
			sets += ", onboarding_agent_id = ?"
		}
		if spec.greetingSet {
			args = append(args, boolToInt(spec.greetingValue))
			sets += ", agent_all_channel_greeting_enabled = ?"
		}
		args = append(args, workspaceID)
		if _, err := tx.ExecContext(ctx, `UPDATE workspaces SET `+sets+` WHERE id = ? AND deleted_at IS NULL`, args...); err != nil {
			return nil, err
		}
		if agentValue, ok := spec.agentValue.(string); ok && agentValue != "" {
			// Crossing the Cindy checkpoint: sweep incomplete owners to
			// complete/grandfathered in the same transaction (legacy
			// reconcileOwnersToSetupCheckpoint; already-complete rows keep
			// their original reason).
			if err := reconcileOwnersTx(ctx, tx, workspaceID); err != nil {
				return nil, err
			}
		}
	}

	if spec.hasPrefFields {
		now := s.now().UnixMilli()
		sets := ""
		var args []any
		appendSet := func(column string, value any) {
			if sets != "" {
				sets += ", "
			}
			sets += column + " = ?"
			args = append(args, value)
		}
		if spec.reminderSet {
			appendSet("setup_modal_reminder_opt_out", spec.reminderValue)
		}
		// dismissal=true stamps now; false clears to null.
		appendDismissal := func(present bool, value bool, column string) {
			if present {
				if value {
					appendSet(column, now)
				} else {
					appendSet(column, nil)
				}
			}
		}
		appendDismissal(spec.addSet, spec.addValue, "dismissed_add_computer_step_at")
		appendDismissal(spec.createSet, spec.createValue, "dismissed_create_agent_step_at")
		appendDismissal(spec.inviteSet, spec.inviteValue, "dismissed_invite_step_at")
		appendDismissal(spec.communitySet, spec.communityValue, "dismissed_community_step_at")
		appendDismissal(spec.notificationSet, spec.notificationValue, "dismissed_notification_step_at")
		if spec.wizardSet {
			if v, ok := spec.wizardValue.(string); ok {
				appendSet("onboarding_wizard_current_step", v)
			} else {
				appendSet("onboarding_wizard_current_step", nil)
			}
		}
		args = append(args, workspaceID, userID)
		if _, err := tx.ExecContext(ctx,
			`UPDATE workspace_member_preferences SET `+sets+` WHERE workspace_id = ? AND user_id = ?`, args...); err != nil {
			return nil, err
		}
	}

	onboard, err := s.readOnboardingSettings(ctx, tx, workspaceID, userID)
	if err != nil {
		return nil, err
	}
	if err := tx.Commit(); err != nil {
		return nil, err
	}
	return onboard, nil
}

// onboardingPatchSpec is the validated intent of one PATCH body.
type onboardingPatchSpec struct {
	agentSet    bool
	agentValue  any // nil (JSON null) or string
	greetingSet bool
	// hasManagerFields mirrors "raw onboardingAgentId or greeting present".
	hasManagerFields bool
	greetingValue    bool

	reminderSet       bool
	reminderValue     bool
	addSet            bool
	addValue          bool
	createSet         bool
	createValue       bool
	inviteSet         bool
	inviteValue       bool
	communitySet      bool
	communityValue    bool
	notificationSet   bool
	notificationValue bool
	wizardSet         bool
	wizardValue       any // nil or closed-set string
	hasPrefFields     bool
}

// parseOnboardingSettingsPatch validates the raw body with the exact legacy
// sentences and check order (routes/servers.ts:1393-1453).
func parseOnboardingSettingsPatch(fields map[string]any) (*onboardingPatchSpec, *DomainError) {
	spec := &onboardingPatchSpec{}

	rawAgent, agentPresent := fields["onboardingAgentId"]
	rawGreeting, greetingPresent := fields["agentAllChannelGreetingEnabled"]
	rawReminder, reminderDefined := nilishCoalesce(fields, "setupModalReminderOptOut", "onboardingReminderOptOut")
	rawAdd, addPresent := fields["dismissedAddComputerStep"]
	rawCreate, createPresent := fields["dismissedCreateAgentStep"]
	rawInvite, invitePresent := fields["dismissedInviteStep"]
	rawCommunity, communityPresent := fields["dismissedCommunityStep"]
	rawNotification, notificationPresent := fields["dismissedNotificationStep"]
	rawWizard, wizardPresent := fields["onboardingWizardCurrentStep"]

	invalid := func(message string) *DomainError {
		return &DomainError{Code: CodeInvalidInput, Message: message}
	}
	asBool := func(v any) (bool, bool) { b, ok := v.(bool); return b, ok }
	asString := func(v any) (string, bool) { str, ok := v.(string); return str, ok }

	if agentPresent {
		if _, ok := rawAgent.(string); !ok && rawAgent != nil {
			return nil, invalid("onboardingAgentId must be a string or null")
		}
		spec.agentSet = true
		spec.agentValue = rawAgent
	}
	if reminderDefined {
		b, ok := asBool(rawReminder)
		if !ok {
			return nil, invalid("setupModalReminderOptOut must be a boolean")
		}
		spec.reminderSet = true
		spec.reminderValue = b
	}
	if greetingPresent {
		b, ok := asBool(rawGreeting)
		if !ok {
			return nil, invalid("agentAllChannelGreetingEnabled must be a boolean")
		}
		spec.greetingSet = true
		spec.greetingValue = b
	}
	if addPresent {
		b, ok := asBool(rawAdd)
		if !ok {
			return nil, invalid("dismissedAddComputerStep must be a boolean")
		}
		spec.addSet = true
		spec.addValue = b
	}
	if createPresent {
		b, ok := asBool(rawCreate)
		if !ok {
			return nil, invalid("dismissedCreateAgentStep must be a boolean")
		}
		spec.createSet = true
		spec.createValue = b
	}
	if invitePresent {
		b, ok := asBool(rawInvite)
		if !ok {
			return nil, invalid("dismissedInviteStep must be a boolean")
		}
		spec.inviteSet = true
		spec.inviteValue = b
	}
	if communityPresent {
		b, ok := asBool(rawCommunity)
		if !ok {
			return nil, invalid("dismissedCommunityStep must be a boolean")
		}
		spec.communitySet = true
		spec.communityValue = b
	}
	if notificationPresent {
		b, ok := asBool(rawNotification)
		if !ok {
			return nil, invalid("dismissedNotificationStep must be a boolean")
		}
		spec.notificationSet = true
		spec.notificationValue = b
	}
	if wizardPresent {
		str, isStr := asString(rawWizard)
		if rawWizard != nil && !isStr {
			return nil, invalid("onboardingWizardCurrentStep must be a valid onboarding wizard step or null")
		}
		if isStr && !onboardingWizardSteps[str] {
			return nil, invalid("onboardingWizardCurrentStep must be a valid onboarding wizard step or null")
		}
		spec.wizardSet = true
		spec.wizardValue = rawWizard
	}

	if !agentPresent && !reminderDefined && !greetingPresent && !addPresent &&
		!createPresent && !invitePresent && !communityPresent && !notificationPresent && !wizardPresent {
		return nil, invalid("At least one field is required")
	}

	spec.hasManagerFields = agentPresent || greetingPresent
	spec.hasPrefFields = spec.reminderSet || spec.addSet || spec.createSet ||
		spec.inviteSet || spec.communitySet || spec.notificationSet || spec.wizardSet
	return spec, nil
}

// nilishCoalesce mirrors JS `a ?? b` followed by a `!== undefined` gate:
// the primary value wins when it is present and non-null; otherwise the alias
// counts as defined whenever the key exists (even as JSON null).
func nilishCoalesce(fields map[string]any, primary, alias string) (any, bool) {
	if v, ok := fields[primary]; ok && v != nil {
		return v, true
	}
	if v, ok := fields[alias]; ok {
		return v, true
	}
	return nil, false
}

// formatMillis renders an optional unix-millisecond column as the legacy UTC
// ISO-8601 string, or nil for SQL NULL (null stays null, never absent).
func formatMillis(v sql.NullInt64) any {
	if !v.Valid {
		return nil
	}
	return time.UnixMilli(v.Int64).UTC().Format("2006-01-02T15:04:05.000Z")
}
