// Bearer authentication against live account + session-family state, plus the
// verified/profile gates that mirror the legacy middleware chain.
package legacyweb

import (
	"context"
	"errors"
	"net/http"
	"strings"

	"raft.local/server-go/internal/auth"
)

// UserLookup preserves request cancellation while waiting for storage.
type UserLookup func(context.Context, string) (*auth.User, error)

// AuthGate verifies access tokens AND the live server-side state (user row +
// family revocation) on every request, mirroring verifyActiveAccessToken.
type AuthGate struct {
	Signer   *auth.TokenSigner
	Sessions *auth.SessionService
	Users    UserLookup
}

// Require wraps handlers that need an authenticated user.
func (g *AuthGate) Require(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		header := r.Header.Get("Authorization")
		if !strings.HasPrefix(header, "Bearer ") {
			writeErrorCode(w, http.StatusUnauthorized, "auth_required", "Missing or invalid Authorization header")
			return
		}
		token := strings.TrimPrefix(header, "Bearer ")
		claims, err := g.Signer.VerifyAccessToken(token)
		if err != nil {
			writeInvalidToken(w)
			return
		}
		user, ok := requestUser(g.Users, w, r, claims.Subject)
		if !ok {
			return
		}
		if claims.FamilyID != "" {
			revoked, err := g.Sessions.FamilyRevoked(r.Context(), claims.FamilyID)
			if err != nil {
				writeAuthUnavailable(w)
				return
			}
			if revoked {
				writeInvalidToken(w)
				return
			}
		}
		ctx := context.WithValue(r.Context(), ctxUserID, user.ID)
		// Preserve the verified proof for M4's in-transaction revalidation.
		// Never reconstruct it from client-supplied sender/family fields.
		ctx = context.WithValue(ctx, accessClaimsContextKey{}, *claims)
		if claims.FamilyID != "" {
			ctx = context.WithValue(ctx, ctxFamilyID, claims.FamilyID)
		}
		next(w, r.WithContext(ctx))
	}
}

// Storage failures do not mean the user's credentials have been revoked.
// Keep 401 for authoritative invalid-session decisions so clients retain
// their session during lock contention, cancellation and database outages.
func writeAuthUnavailable(w http.ResponseWriter) {
	w.Header().Set("Retry-After", "1")
	writeErrorCode(w, http.StatusServiceUnavailable, "auth_temporarily_unavailable", "Authentication temporarily unavailable")
}

func requestUser(lookup UserLookup, w http.ResponseWriter, r *http.Request, id string) (*auth.User, bool) {
	user, err := lookup(r.Context(), id)
	if errors.Is(err, auth.ErrNotFound) || err == nil && user == nil {
		writeInvalidToken(w)
		return nil, false
	}
	if err != nil {
		writeAuthUnavailable(w)
		return nil, false
	}
	return user, true
}

func writeInvalidToken(w http.ResponseWriter) {
	writeErrorCode(w, http.StatusUnauthorized, "auth_required", "Invalid or expired token")
}

func userID(r *http.Request) string {
	v, _ := r.Context().Value(ctxUserID).(string)
	return v
}

type accessClaimsContextKey struct{}

// A missing proof fails closed in auth.ValidateHumanTx.
func accessClaims(r *http.Request) auth.AccessTokenClaims {
	claims, _ := r.Context().Value(accessClaimsContextKey{}).(auth.AccessTokenClaims)
	return claims
}

// RequireVerified mirrors the TS function with this name: email verification
// is followed by account-global identity setup, not just the email check.
func (g *AuthGate) RequireVerified(next http.HandlerFunc) http.HandlerFunc {
	return g.RequireVerifiedProfileComplete(next)
}

// RequireVerifiedProfileComplete preserves both gates from the legacy chain.
func (g *AuthGate) RequireVerifiedProfileComplete(next http.HandlerFunc) http.HandlerFunc {
	return g.Require(func(w http.ResponseWriter, r *http.Request) {
		user, ok := requestUser(g.Users, w, r, userID(r))
		if !ok {
			return
		}
		if !user.EmailVerified {
			writeError(w, http.StatusForbidden, "Email verification required")
			return
		}
		if user.NeedsIdentitySetup() {
			writeErrorCode(w, http.StatusForbidden, "PROFILE_SETUP_REQUIRED", "Profile setup required")
			return
		}
		next(w, r)
	})
}
