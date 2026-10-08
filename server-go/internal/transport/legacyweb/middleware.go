// HTTP middleware: request identity/logging, body limits, bearer auth with
// live account/session checks, and the verified/profile gates.
package legacyweb

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"strings"
	"time"
)

type ctxKey int

const (
	ctxUserID ctxKey = iota
	ctxFamilyID
	ctxRequestID
)

// RequestID assigns a short random id and logs the request line. Bodies,
// credentials and tokens are never logged.
func RequestID(logger *slog.Logger) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			buf := make([]byte, 8)
			_, _ = rand.Read(buf)
			requestID := hex.EncodeToString(buf)
			ctx := context.WithValue(r.Context(), ctxRequestID, requestID)
			w.Header().Set("X-Request-Id", requestID)
			rec := &statusRecorder{ResponseWriter: w, status: http.StatusOK}
			start := time.Now()
			request := r.WithContext(ctx)
			next.ServeHTTP(rec, request)
			route := request.Pattern
			if route == "" {
				route = "unmatched"
			}
			logger.Info("http request",
				"request_id", requestID,
				"method", r.Method,
				"route", route,
				"status", rec.status,
				"duration_ms", time.Since(start).Milliseconds(),
			)
		})
	}
}

type statusRecorder struct {
	http.ResponseWriter
	status int
}

// Unwrap lets http.ResponseController and WebSocket libraries reach the
// underlying Hijacker/Flusher without bypassing the request logging chain.
func (r *statusRecorder) Unwrap() http.ResponseWriter { return r.ResponseWriter }

func (r *statusRecorder) WriteHeader(code int) {
	r.status = code
	r.ResponseWriter.WriteHeader(code)
}

// SecurityHeaders sets baseline response headers for API surfaces.
func SecurityHeaders(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		h := w.Header()
		h.Set("X-Content-Type-Options", "nosniff")
		h.Set("Referrer-Policy", "no-referrer")
		if strings.HasPrefix(r.URL.Path, "/api/") {
			h.Set("Cache-Control", "no-store")
		}
		next.ServeHTTP(w, r)
	})
}

// maxBytesJSON enforces the legacy ~100kb JSON budget per request.
const maxJSONBodyBytes = 128 * 1024

func decodeJSONBody(w http.ResponseWriter, r *http.Request, dest any) bool {
	r.Body = http.MaxBytesReader(w, r.Body, maxJSONBodyBytes)
	decoder := json.NewDecoder(r.Body)
	err := decoder.Decode(dest)
	if err == nil {
		// Consume through EOF so a second document, junk or oversized trailing
		// whitespace cannot bypass parsing or the total request-body budget.
		var extra any
		err = decoder.Decode(&extra)
		if errors.Is(err, io.EOF) {
			return true
		}
		if err == nil {
			err = errors.New("multiple JSON documents")
		}
	}
	switch {
	case errors.Is(err, io.EOF):
		// An absent body parses as {} upstream (zod rawBody ?? {}).
		if m, ok := dest.(*map[string]any); ok {
			*m = map[string]any{}
		}
		return true
	default:
		var tooLarge *http.MaxBytesError
		if errors.As(err, &tooLarge) {
			writeError(w, http.StatusRequestEntityTooLarge, "Payload too large")
			return false
		}
		writeError(w, http.StatusBadRequest, "Invalid JSON body")
		return false
	}
}
