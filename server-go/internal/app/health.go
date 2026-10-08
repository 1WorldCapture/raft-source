// Health/readiness endpoints. /healthz only proves the process serves HTTP;
// /readyz reflects the real dependency state.
package app

import (
	"context"
	"encoding/json"
	"net/http"
	"time"
)

func contextWithTimeout(parent context.Context, d time.Duration) (context.Context, context.CancelFunc) {
	return context.WithTimeout(parent, d)
}

// LivenessHandler proves only that the process serves HTTP.
func (a *App) LivenessHandler() http.HandlerFunc {
	return func(w http.ResponseWriter, _ *http.Request) {
		writeHealthJSON(w, http.StatusOK, map[string]string{"status": "alive", "stage": "account_phase"})
	}
}

// ReadinessHandler reflects the real dependency state (database reachable and
// migrated); it never reports readiness for capabilities this phase lacks.
func (a *App) ReadinessHandler() http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		ctx, cancel := contextWithTimeout(r.Context(), 3*time.Second)
		defer cancel()
		if err := a.Ready(ctx); err != nil {
			writeHealthJSON(w, http.StatusServiceUnavailable, map[string]string{
				"status": "not_ready",
				"reason": err.Error(),
			})
			return
		}
		writeHealthJSON(w, http.StatusOK, map[string]string{"status": "ready"})
	}
}

func writeHealthJSON(w http.ResponseWriter, status int, body map[string]string) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(body)
}
