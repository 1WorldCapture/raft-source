package channel

import "testing"

func TestServerCapabilityMatrix(t *testing.T) {
	memberHas := []string{
		CapViewChannel, CapCreateChannels, CapViewChannelMembers, CapJoinPublicChannels,
		CapAddChannelMembers, "viewMembers", "viewAgents", "controlAgentRuntime",
		"viewMachines", "assignTasks",
	}
	for _, cap := range memberHas {
		if !HasServerCapability(RoleMember, cap) {
			t.Errorf("member missing %s", cap)
		}
	}
	memberLacks := []string{
		CapEditChannelMetadata, CapArchiveChannels, CapDeleteChannels, CapChangeChannelVis,
		CapManageGuestAccess, CapFederateChannels, CapRemoveChannelMembers, CapChangeChannelRoles,
		"manageBilling", "inviteMembers",
	}
	for _, cap := range memberLacks {
		if HasServerCapability(RoleMember, cap) {
			t.Errorf("member unexpectedly has %s", cap)
		}
	}
	for _, role := range []string{RoleOwner, RoleAdmin} {
		for _, cap := range []string{
			CapDeleteChannels, CapEditChannelMetadata, CapArchiveChannels, CapChangeChannelVis,
			CapFederateChannels, CapManageGuestAccess, CapRemoveChannelMembers, CapChangeChannelRoles,
		} {
			if !HasServerCapability(role, cap) {
				t.Errorf("%s missing %s", role, cap)
			}
		}
	}
	if HasServerCapability(RoleOwner, "manageBilling") || HasServerCapability(RoleAdmin, "manageBilling") {
		t.Fatal("manageBilling is outside this surface's matrix")
	}
	if HasServerCapability(RoleGuest, CapViewChannel) || HasServerCapability("nope", CapViewChannel) {
		t.Fatal("guest and unknown roles are empty")
	}
}

func TestEffectiveChannelCapability(t *testing.T) {
	adminCaps := []string{
		CapEditChannelMetadata, CapArchiveChannels, CapRemoveChannelMembers,
		CapChangeChannelRoles, CapManageGuestAccess,
	}
	// Stored channel-admin grant elevates an ordinary member on a role-bearing channel.
	for _, cap := range adminCaps {
		if !HasEffectiveChannelCapability(RoleMember, ChannelRoleAdmin, true, true, cap) {
			t.Errorf("channel admin missing %s", cap)
		}
	}
	for _, cap := range []string{CapDeleteChannels, CapChangeChannelVis, CapFederateChannels} {
		if HasEffectiveChannelCapability(RoleMember, ChannelRoleAdmin, true, true, cap) {
			t.Errorf("channel admin must not gain %s", cap)
		}
	}
	// Fail closed: a stale admin row never elevates a guest, and #all does not
	// carry stored roles.
	if HasEffectiveChannelCapability(RoleGuest, ChannelRoleAdmin, true, true, CapEditChannelMetadata) {
		t.Fatal("guest channel-admin grant must fail closed")
	}
	if HasEffectiveChannelCapability(RoleMember, ChannelRoleAdmin, true, false, CapArchiveChannels) {
		t.Fatal("#all must not honor a stored channel-admin grant")
	}
	if HasEffectiveChannelCapability(RoleMember, ChannelRoleMember, true, true, CapArchiveChannels) {
		t.Fatal("plain channel member has no archive grant")
	}
	if !HasEffectiveChannelCapability(RoleOwner, "", false, false, CapDeleteChannels) {
		t.Fatal("owner inherits delete without a channel row")
	}

	if got := GetChannelAdminBasis(RoleOwner, ChannelRoleAdmin, true, true); got != "both" {
		t.Fatalf("owner+channel admin basis: %q", got)
	}
	if got := GetChannelAdminBasis(RoleAdmin, ChannelRoleMember, true, true); got != "server_role" {
		t.Fatalf("admin basis: %q", got)
	}
	if got := GetChannelAdminBasis(RoleMember, ChannelRoleAdmin, true, true); got != "channel_role" {
		t.Fatalf("member channel-admin basis: %q", got)
	}
	if got := GetChannelAdminBasis(RoleGuest, ChannelRoleAdmin, true, true); got != "" {
		t.Fatalf("guest basis must be empty, got %q", got)
	}
	if got := GetChannelAdminBasis(RoleMember, ChannelRoleAdmin, true, false); got != "" {
		t.Fatalf("#all stored grant basis must be empty, got %q", got)
	}
}

func TestAddAndGuestPolicy(t *testing.T) {
	if !CanAddChannelMembers(RoleOwner, false, TypePrivate, "ops", false, false) {
		t.Fatal("owner may add to a private channel without joining")
	}
	if !CanAddChannelMembers(RoleMember, true, TypeChannel, "ops", false, false) {
		t.Fatal("joined member may add")
	}
	if CanAddChannelMembers(RoleMember, false, TypeChannel, "ops", false, false) {
		t.Fatal("unjoined member may not add")
	}
	if CanAddChannelMembers(RoleGuest, true, TypeChannel, "ops", false, false) ||
		CanAddChannelMembers(RoleOwner, true, TypeChannel, systemAllName, false, false) ||
		CanAddChannelMembers(RoleOwner, true, TypeChannel, "ops", true, false) ||
		CanAddChannelMembers(RoleOwner, true, TypeDM, "ops", false, false) {
		t.Fatal("guest, #all, archived and DM channels are not addable")
	}

	// Frozen policy: the guest gate is off, so both helpers fail closed.
	if CanGuestReadChannel(false, RoleGuest, TypeChannel, "ops", false, true, true, false, false, false) ||
		CanGuestJoinChannel(false, RoleGuest, TypeChannel, "ops", false, true, true, false, false, false) {
		t.Fatal("disabled guest gate must fail closed")
	}
	if !CanGuestReadChannel(true, RoleGuest, TypeChannel, "ops", false, true, false, false, false, false) {
		t.Fatal("enabled gate allows guest-visible public reads")
	}
	if CanGuestJoinChannel(true, RoleGuest, TypeChannel, "ops", false, true, false, false, false, false) {
		t.Fatal("join also requires guestJoinable")
	}
	if !CanGuestJoinChannel(true, RoleGuest, TypeChannel, "ops", false, true, true, false, false, false) {
		t.Fatal("guest-visible and guest-joinable public channel is joinable")
	}
	if CanGuestJoinChannel(true, RoleGuest, TypeChannel, systemAllName, false, true, true, false, false, false) {
		t.Fatal("#all is never guest-joinable")
	}
}

func TestValidateChannelNameSentences(t *testing.T) {
	cases := []struct {
		name string
		want string
	}{
		{"", "Channel name is required"},
		{"   ", "Channel name is required"},
		{"1abc", "Channel name must start with a letter and can only contain letters, numbers, hyphens, and underscores"},
		{"a b", "Channel name must start with a letter and can only contain letters, numbers, hyphens, and underscores"},
		{"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "Channel name must be at most 32 characters"}, // 33
		{"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", ""}, // 32
		{"a", ""},
		{"a-b_c1", ""},
		{"频道", ""},
		{" all ", ""}, // trim happens before the pattern; reserved is a separate check
	}
	for _, tc := range cases {
		if got := ValidateChannelName(tc.name); got != tc.want {
			t.Errorf("ValidateChannelName(%q) = %q, want %q", tc.name, got, tc.want)
		}
	}
	// min length is 1, so the "at least" sentence is unreachable: empty input
	// is "required" and every non-empty trimmed value is already >= 1 UTF-16 unit.
	if got := ValidateChannelName("x"); got != "" {
		t.Fatalf("single letter: %q", got)
	}
	// A supplementary-plane character is two UTF-16 units. 17 of them exceed 32.
	unit := "𐀀"
	long := ""
	for i := 0; i < 17; i++ {
		long += unit
	}
	if got := ValidateChannelName(long); got != "Channel name must be at most 32 characters" {
		t.Fatalf("utf16 length: %q", got)
	}
	if !SupportsChannelRoles(TypeChannel, "ops") || !SupportsChannelRoles(TypePrivate, "ops") {
		t.Fatal("regular channels support roles")
	}
	if SupportsChannelRoles(TypeChannel, systemAllName) || SupportsChannelRoles(TypeDM, "ops") {
		t.Fatal("#all and DMs do not support stored roles")
	}
	if !SupportsActivityMute(TypeChannel) || !SupportsActivityMute(TypePrivate) || !SupportsActivityMute(TypeJoint) {
		t.Fatal("activity mute covers channel, private and joint")
	}
	if SupportsActivityMute(TypeDM) || SupportsActivityMute(TypeThread) {
		t.Fatal("DM and thread do not support activity mute")
	}
}
