// Small helpers for nullable column scanning and writing.
package auth

import "database/sql"

// NullStr reads a nullable string.
func NullStr(ns sql.NullString) *string {
	if !ns.Valid {
		return nil
	}
	v := ns.String
	return &v
}

// StrPtr makes a copy of s as a pointer.
func StrPtr(s string) *string { return &s }

// Deref returns the pointed-to string or "".
func Deref(s *string) string {
	if s == nil {
		return ""
	}
	return *s
}
