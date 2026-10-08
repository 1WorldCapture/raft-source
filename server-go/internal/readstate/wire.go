package readstate

import (
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"math"
	"regexp"
	"sort"
	"strconv"
)

// Canonical UInt64 wire domain (activity-sync.tsp): decimal strings with no
// sign, no spaces, no leading zeros (except "0" alone), no fractions or
// exponents. Values are held as uint64; the SQLite counters backing them are
// bounded by non-negative signed 64-bit so every emitted value round-trips
// exactly, and inputs above the storage domain are surfaced as conflicts
// rather than truncated.
var canonicalUint64RE = regexp.MustCompile(`^(0|[1-9][0-9]*)$`)

// parseUint64String validates and parses a canonical UInt64 decimal string.
// ok=false for every non-canonical shape (empty, sign, spaces, leading zero,
// decimal point, exponent, letters).
func parseUint64String(raw string) (uint64, bool) {
	if !canonicalUint64RE.MatchString(raw) {
		return 0, false
	}
	value, err := strconv.ParseUint(raw, 10, 64)
	if err != nil {
		// Canonical shape but above uint64: still a rejected wire value.
		return 0, false
	}
	return value, true
}

// formatUint64 renders the canonical decimal string form.
func formatUint64(v uint64) string { return strconv.FormatUint(v, 10) }

// positiveCanonicalDecimal ports parsePositiveCanonicalDecimal: a canonical
// decimal string that is strictly greater than zero.
func positiveCanonicalDecimal(raw string) (uint64, bool) {
	v, ok := parseUint64String(raw)
	if !ok || v == 0 {
		return 0, false
	}
	return v, true
}

// jsonInt renders a legacy lossy counter: a JSON number that must stay an
// exact integer (message seq and versions are <= 2^53 by schema).
func jsonInt(v int64) json.Number { return json.Number(strconv.FormatInt(v, 10)) }

// int64FromUint64 narrows a parsed wire uint64 into the local signed-64
// storage domain; ok=false when the wire value exceeds it (the caller turns
// that into a conflict, never a truncation).
func int64FromUint64(v uint64) (int64, bool) {
	if v > math.MaxInt64 {
		return 0, false
	}
	return int64(v), true
}

// canonicalJSON renders a stable JSON document: object keys sorted
// lexicographically (the reference canonicalJson uses localeCompare over
// ASCII keys; byte sort is equivalent for the keys this package emits),
// arrays in order, no insignificant whitespace.
func canonicalJSON(value any) string {
	buf, err := jsonMarshalCanonical(value, nil)
	if err != nil {
		// Payload structs in this package are plain JSON-safe values.
		return fmt.Sprintf("%q", fmt.Sprintf("marshal-error: %v", err))
	}
	return string(buf)
}

func jsonMarshalCanonical(value any, buf []byte) ([]byte, error) {
	switch v := value.(type) {
	case nil:
		return append(buf, "null"...), nil
	case bool:
		return append(buf, strconv.FormatBool(v)...), nil
	case string:
		enc, err := json.Marshal(v)
		if err != nil {
			return nil, err
		}
		return append(buf, enc...), nil
	case json.Number:
		return append(buf, v.String()...), nil
	case int:
		return append(buf, strconv.Itoa(v)...), nil
	case int64:
		return append(buf, strconv.FormatInt(v, 10)...), nil
	case uint64:
		return append(buf, strconv.FormatUint(v, 10)...), nil
	case float64:
		enc, err := json.Marshal(v)
		if err != nil {
			return nil, err
		}
		return append(buf, enc...), nil
	case []any:
		buf = append(buf, '[')
		for i, item := range v {
			if i > 0 {
				buf = append(buf, ',')
			}
			var err error
			if buf, err = jsonMarshalCanonical(item, buf); err != nil {
				return nil, err
			}
		}
		return append(buf, ']'), nil
	case map[string]any:
		keys := make([]string, 0, len(v))
		for k := range v {
			keys = append(keys, k)
		}
		sort.Strings(keys)
		buf = append(buf, '{')
		for i, k := range keys {
			if i > 0 {
				buf = append(buf, ',')
			}
			var err error
			if buf, err = jsonMarshalCanonical(k, buf); err != nil {
				return nil, err
			}
			buf = append(buf, ':')
			if buf, err = jsonMarshalCanonical(v[k], buf); err != nil {
				return nil, err
			}
		}
		return append(buf, '}'), nil
	default:
		enc, err := json.Marshal(v)
		if err != nil {
			return nil, err
		}
		return append(buf, enc...), nil
	}
}

// digestHex ports the reference payload digest: sha256 over canonical JSON.
func digestHex(value any) string {
	sum := sha256.Sum256([]byte(canonicalJSON(value)))
	const hexDigits = "0123456789abcdef"
	out := make([]byte, 0, sha256.Size*2)
	for _, b := range sum {
		out = append(out, hexDigits[b>>4], hexDigits[b&0x0f])
	}
	return string(out)
}
