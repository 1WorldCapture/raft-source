// Role and feature-policy primitives for the workspace domain. The policy
// struct is the local C0 provider required by docs/phase-2-workspaces.md §1.3:
// every flag defaults to false (TS missing_flag → enabled:false); unsupported
// push/platform flags must not be added here.

package workspace

// Membership roles (TS ServerRole).
const (
	RoleOwner  = "owner"
	RoleAdmin  = "admin"
	RoleMember = "member"
	RoleGuest  = "guest"
)

// Policy is the frozen local feature-flag vector. OnboardingOpenerV2 changes
// the #all channel type and creates the private owner channel at creation;
// OnboardingOwnerWizardV0 is the legacy wizard switch (not the setup gate);
// FeedbackEnabled only truthfully reports the feedback settings surface.
type Policy struct {
	OnboardingOpenerV2      bool
	OnboardingOwnerWizardV0 bool
	FeedbackEnabled         bool
}

// CanManage reports whether the membership role carries the
// editServerSettings capability (owner or admin; TS hasServerCapability).
func CanManage(role string) bool {
	return role == RoleOwner || role == RoleAdmin
}
