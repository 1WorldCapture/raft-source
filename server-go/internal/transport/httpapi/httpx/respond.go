// Response helpers: exact legacy JSON error bodies and safe header handling.
package httpx

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"net/http"
)

// Issue mirrors one zod issue entry for body-schema failures.
type Issue struct {
	Path    string `json:"path"`
	Message string `json:"message"`
}

func WriteJSON(w http.ResponseWriter, status int, body any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.WriteHeader(status)
	enc := json.NewEncoder(w)
	_ = enc.Encode(body)
}

// ErrorBody is the legacy { error, code?, ...extras } shape.
type ErrorBody map[string]any

func WriteError(w http.ResponseWriter, status int, message string) {
	WriteJSON(w, status, ErrorBody{"error": message})
}

func WriteErrorCode(w http.ResponseWriter, status int, code, message string) {
	WriteJSON(w, status, ErrorBody{"error": message, "code": code})
}

func WriteErrorIssues(w http.ResponseWriter, status int, message, code string, issues []Issue) {
	WriteJSON(w, status, ErrorBody{"error": message, "code": code, "issues": issues})
}

// OKTrue writes the legacy {"ok":true} responses.
func OKTrue(w http.ResponseWriter) {
	WriteJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

// WriteAuthUnavailable answers an authentication infrastructure failure:
// storage trouble is not a credential revocation, so the client keeps its
// session and retries.
func WriteAuthUnavailable(w http.ResponseWriter) {
	w.Header().Set("Retry-After", "1")
	WriteErrorCode(w, http.StatusServiceUnavailable, "auth_temporarily_unavailable", "Authentication temporarily unavailable")
}

// WriteInvalidToken answers an authoritative invalid/expired credential.
func WriteInvalidToken(w http.ResponseWriter) {
	WriteErrorCode(w, http.StatusUnauthorized, "auth_required", "Invalid or expired token")
}

// NotImplemented is the honest not-enabled answer: no fake success.
func NotImplemented(message string) http.HandlerFunc {
	return func(w http.ResponseWriter, _ *http.Request) {
		WriteErrorCode(w, http.StatusNotImplemented, "feature_not_implemented", message)
	}
}

// ReadJSONObject reads a bounded JSON object body into raw fields, keeping
// every legacy type distinction (missing vs null vs wrong type) for the
// parser that follows.
func ReadJSONObject(r *http.Request) (map[string]json.RawMessage, error) {
	raw, err := io.ReadAll(io.LimitReader(r.Body, 1<<20+1))
	if err != nil {
		return nil, err
	}
	if len(raw) > 1<<20 {
		return nil, errors.New("body too large")
	}
	if len(bytes.TrimSpace(raw)) == 0 || string(bytes.TrimSpace(raw)) == "null" {
		return map[string]json.RawMessage{}, nil
	}
	var obj map[string]json.RawMessage
	if err := json.Unmarshal(raw, &obj); err != nil {
		return nil, err
	}
	if obj == nil {
		return map[string]json.RawMessage{}, nil
	}
	return obj, nil
}
