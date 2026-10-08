package auth

import "testing"

func TestValidateNameReason(t *testing.T) {
	cases := []struct {
		name      string
		minLength int
		want      string
	}{
		{"", 5, "required"},
		{"   ", 5, "required"},
		{"abc", 5, "tooShort"},
		{"abcdef", 5, ""},
		{"a", 1, ""},
		{"1abcdef", 1, "pattern"},
		{"_abcdef", 1, "pattern"},
		{"ab cdef", 1, "pattern"},
		{"ab@cdef", 1, "pattern"},
		{"ab-cd_ef", 1, ""},
		{"übermensch", 1, ""},
		{"这个用户名是不可能的因为太长", 1, ""},
	}
	for _, tc := range cases {
		reason := ValidateNameReason(tc.name, tc.minLength)
		got := ""
		if reason != nil {
			got = reason.Code
		}
		if got != tc.want {
			t.Errorf("ValidateNameReason(%q, %d) = %q, want %q", tc.name, tc.minLength, got, tc.want)
		}
	}
}

func TestValidateNameTooLong(t *testing.T) {
	long := "abcdefghijklmnopqrstuvwxyz0123456" // 33 chars
	reason := ValidateNameReason(long, 5)
	if reason == nil || reason.Code != "tooLong" {
		t.Fatalf("expected tooLong, got %+v", reason)
	}
}

func TestReservedAndPlaceholder(t *testing.T) {
	for _, name := range []string{"all", "ALL", "@system", "Here"} {
		if !IsReservedAgentName(name) {
			t.Errorf("%q should be reserved", name)
		}
	}
	for _, name := range []string{"alvin", "hal", "systems"} {
		if IsReservedAgentName(name) {
			t.Errorf("%q should not be reserved", name)
		}
	}
	if !HasPlaceholderHandle("pending_deadbeef") {
		t.Error("placeholder handle not detected")
	}
	if HasPlaceholderHandle("pendingless") || HasPlaceholderHandle("") {
		t.Error("non-placeholder misclassified")
	}
	if !AccountNeedsIdentitySetup("", nil) || !AccountNeedsIdentitySetup("pending_aa", nil) {
		t.Error("identity setup required misread")
	}
	if AccountNeedsIdentitySetup("realname", nil) {
		t.Error("real handle flagged as needing setup")
	}
}

func TestEmailNormalizationAndValidation(t *testing.T) {
	if NormalizeEmail("  MiXeD@Example.COM ") != "mixed@example.com" {
		t.Error("normalization mismatch")
	}
	if ValidateEmailAddress("") == "" || ValidateEmailAddress("not-an-email") == "" ||
		ValidateEmailAddress("a@b") == "" || ValidateEmailAddress("a b@c.d") == "" {
		t.Error("invalid emails accepted")
	}
	if ValidateEmailAddress("a@b.co") != "" || ValidateEmailAddress("user.name+tag@sub.example.org") != "" {
		t.Error("valid email rejected")
	}
}

func TestLanguageAndLocaleTaxonomies(t *testing.T) {
	if NormalizeTranslationLanguageCode("zh") != "zh-cn" ||
		NormalizeTranslationLanguageCode("ZH-Hans") != "zh-cn" ||
		NormalizeTranslationLanguageCode("pt-BR") != "pt-br" ||
		NormalizeTranslationLanguageCode("en-US") != "en" ||
		NormalizeTranslationLanguageCode("") != "" ||
		NormalizeTranslationLanguageCode("xx") != "" {
		t.Error("translation language normalization mismatch")
	}
	if NormalizeDisplayLocale("en-GB") != "en" || NormalizeDisplayLocale("zh-Hans") != "zh-cn" ||
		NormalizeDisplayLocale("fr-FR") != "" || NormalizeDisplayLocale("zh-TW") != "" {
		t.Error("display locale normalization mismatch")
	}
	if NormalizeTimeFormatPreference(" 24H ") != "24h" || NormalizeTimeFormatPreference("48h") != "" {
		t.Error("time format normalization mismatch")
	}
}

func TestReferralAndRoleTaxonomies(t *testing.T) {
	if !IsAcceptedReferralSource("hn_reddit") || IsAcceptedReferralSource("myspace") {
		t.Error("referral taxonomy mismatch")
	}
	if !IsSignupRole("software_engineer") || IsSignupRole("astronaut") {
		t.Error("signup role taxonomy mismatch")
	}
}

func TestParseCanonicalBrowserTimezone(t *testing.T) {
	if tz, err := ParseCanonicalBrowserTimezone("Asia/Shanghai"); err != nil || tz != "Asia/Shanghai" {
		t.Errorf("canonical tz: %v %v", tz, err)
	}
	if _, err := ParseCanonicalBrowserTimezone("UTC"); err != nil {
		t.Errorf("UTC rejected: %v", err)
	}
	for _, bad := range []string{"", "Not/A Zone", "America", "   ", "Mars/Olympus_Mons"} {
		if _, err := ParseCanonicalBrowserTimezone(bad); err == nil {
			t.Errorf("%q accepted", bad)
		}
	}
}

func TestSlugifyUserName(t *testing.T) {
	cases := map[string]string{
		"  Alice Wonderland ": "alice-wonderland",
		"Über Driver":         "ber-driver",
		"123 456":             "user-123-456",
		"bob":                 "bob-user",
		"a!!b??c":             "a-b-c",
	}
	for in, want := range cases {
		if got := SlugifyUserName(in); got != want {
			t.Errorf("SlugifyUserName(%q) = %q, want %q", in, got, want)
		}
	}
}
