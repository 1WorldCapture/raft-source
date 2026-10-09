package message

import (
	"unicode/utf16"
	"unicode/utf8"
)

// Content and idempotency-key limits frozen by the TS parsers
// (packages/server/src/routes/messages.ts:57-58). The content bound is
// JavaScript UTF-16 code units, NOT bytes and NOT runes.
const (
	MaxContentCodeUnits = 32_000
	MaxRandomIDLength   = 128
	// MaxAgentRandomIDLength is the original agent send idempotencyKey bound
	// (agentApiMessageContract: trim 1–256). The agent send path accepts keys
	// up to this length; the human randomId keeps its 128-unit legacy bound.
	MaxAgentRandomIDLength = 256
	MaxMentionNameLen      = 128
)

// utf16Length returns the number of UTF-16 code units in s (JavaScript
// String.prototype.length). Invalid UTF-8 bytes never reach this function on
// the JSON path (encoding/json replaces them with U+FFFD), but any byte that
// does still decode is counted as one replacement unit.
func utf16Length(s string) int {
	units := 0
	for _, r := range s {
		n := utf16.RuneLen(r)
		if n < 0 {
			// Unencodable surrogate: decoding/json cannot produce it; if it
			// ever appears, count it as its replacement-character unit.
			n = 1
		}
		units += n
	}
	return units
}

// isJSWhitespace reports the ECMA-262 TrimString whitespace/line-terminator
// set. It deliberately differs from unicode.IsSpace: U+0085 is a Go space but
// NOT a JS trim character, and "all-whitespace" content must be judged by the
// original client-visible rule.
func isJSWhitespace(r rune) bool {
	switch r {
	case '\t', '\n', '\v', '\f', '\r', ' ', 0x00A0, 0x1680,
		0x2000, 0x2001, 0x2002, 0x2003, 0x2004, 0x2005, 0x2006, 0x2007,
		0x2008, 0x2009, 0x200A, 0x2028, 0x2029, 0x202F, 0x205F, 0x3000, 0xFEFF:
		return true
	}
	return false
}

// jsTrimStartEnd removes the ECMA-262 trim set from both ends.
func jsTrim(s string) string {
	start, end := 0, len(s)
	for start < end {
		r, size := utf8.DecodeRuneInString(s[start:])
		if !isJSWhitespace(r) {
			break
		}
		start += size
	}
	for end > start {
		r, size := utf8.DecodeLastRuneInString(s[:end])
		if !isJSWhitespace(r) {
			break
		}
		end -= size
	}
	return s[start:end]
}

// isUUID matches the legacy lowercase/uppercase v4-shaped UUID regex the TS
// parsers apply to channel ids, mention ids and attachment ids.
func isUUID(s string) bool {
	if len(s) != 36 {
		return false
	}
	for i, c := range s {
		switch i {
		case 8, 13, 18, 23:
			if c != '-' {
				return false
			}
		default:
			if !(c >= '0' && c <= '9' || c >= 'a' && c <= 'f' || c >= 'A' && c <= 'F') {
				return false
			}
		}
	}
	return true
}
