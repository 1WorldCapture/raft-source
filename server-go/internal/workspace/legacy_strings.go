package workspace

import "strings"

// trimECMAScriptSpace matches the reference server's String.prototype.trim.
// Go's Unicode White_Space differs: U+FEFF belongs here, U+0085 does not.
func trimECMAScriptSpace(value string) string {
	return strings.TrimFunc(value, func(r rune) bool {
		switch r {
		case '\t', '\n', '\v', '\f', '\r', ' ', '\u00a0', '\u1680',
			'\u2028', '\u2029', '\u202f', '\u205f', '\u3000', '\ufeff':
			return true
		default:
			return r >= '\u2000' && r <= '\u200a'
		}
	})
}
