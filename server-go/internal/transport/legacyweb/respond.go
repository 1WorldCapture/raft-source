// Response helpers: exact legacy JSON error bodies and safe header handling.
package legacyweb

import (
	"encoding/json"
	"net/http"
)

// Issue mirrors one zod issue entry for body-schema failures.
type Issue struct {
	Path    string `json:"path"`
	Message string `json:"message"`
}

func writeJSON(w http.ResponseWriter, status int, body any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.WriteHeader(status)
	enc := json.NewEncoder(w)
	_ = enc.Encode(body)
}

// errorBody is the legacy { error, code?, ...extras } shape.
type errorBody map[string]any

func writeError(w http.ResponseWriter, status int, message string) {
	writeJSON(w, status, errorBody{"error": message})
}

func writeErrorCode(w http.ResponseWriter, status int, code, message string) {
	writeJSON(w, status, errorBody{"error": message, "code": code})
}

func writeErrorIssues(w http.ResponseWriter, status int, message, code string, issues []Issue) {
	writeJSON(w, status, errorBody{"error": message, "code": code, "issues": issues})
}

// okTrue writes the legacy {"ok":true} responses.
func okTrue(w http.ResponseWriter) {
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}
