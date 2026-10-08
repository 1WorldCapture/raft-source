// Avatar upload with strict validation (declared + sniffed type, dimension
// caps, size caps) and re-encoding to PNG so nothing but pixels persists.
// Uploaded bytes live under the private data dir; served paths are
// content-addressed and immutable.
package legacyweb

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"image"
	"image/png"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strings"

	// Register the decoders for validation; WebP arrives via x/image.
	_ "golang.org/x/image/webp"
	_ "image/gif"
	_ "image/jpeg"
	_ "image/png"

	"raft.local/server-go/internal/auth"
)

const (
	maxAvatarBytesDefault = 5 * 1024 * 1024
	avatarBadFormatMsg    = "Only image files are allowed (JPEG, PNG, GIF, WebP)"
	avatarTooLargeMsg     = "Avatar image must be 5 MB or smaller"
	maxAvatarSideDefault  = 8000
)

var avatarFilePattern = regexp.MustCompile(`^[0-9a-f]{32}\.(png|webp|gif|jpeg|jpg)$`)

// AvatarHandlers stores and serves user avatars.
type AvatarHandlers struct {
	Dir      string
	MaxBytes int64
	MaxSide  int
	Auth     *auth.Service
	Users    UserLookup
}

// Upload validates and stores the multipart "avatar" file, then persists the
// stored path as the user's avatarUrl.
func (h *AvatarHandlers) Upload(w http.ResponseWriter, r *http.Request) {
	if _, ok := requestUser(h.Users, w, r, userID(r)); !ok {
		return
	}
	maxBytes := h.MaxBytes
	if maxBytes <= 0 {
		maxBytes = maxAvatarBytesDefault
	}
	r.Body = http.MaxBytesReader(w, r.Body, maxBytes+(64*1024))
	if err := r.ParseMultipartForm(1 << 20); err != nil {
		var tooLarge *http.MaxBytesError
		if errors.As(err, &tooLarge) {
			writeAvatarTooLarge(w, maxBytes)
			return
		}
		writeError(w, http.StatusBadRequest, "No avatar file provided")
		return
	}
	file, _, err := r.FormFile("avatar")
	if err != nil {
		writeError(w, http.StatusBadRequest, "No avatar file provided")
		return
	}
	defer file.Close()

	buf, err := io.ReadAll(io.LimitReader(file, maxBytes+1))
	if err != nil {
		writeError(w, http.StatusBadRequest, avatarBadFormatMsg)
		return
	}
	if int64(len(buf)) > maxBytes {
		writeAvatarTooLarge(w, maxBytes)
		return
	}
	if len(buf) == 0 {
		writeError(w, http.StatusBadRequest, avatarBadFormatMsg)
		return
	}

	sniffed := http.DetectContentType(buf)
	switch sniffed {
	case "image/jpeg", "image/png", "image/gif", "image/webp":
	default:
		writeAvatarBadFormat(w)
		return
	}

	config, _, err := image.DecodeConfig(bytes.NewReader(buf))
	if err != nil {
		writeAvatarBadFormat(w)
		return
	}
	maxSide := h.MaxSide
	if maxSide <= 0 {
		maxSide = maxAvatarSideDefault
	}
	if config.Width <= 0 || config.Height <= 0 || config.Width > maxSide || config.Height > maxSide {
		writeAvatarBadFormat(w)
		return
	}
	// Full decode validates integrity (truncated files fail here) and feeds
	// the re-encode below.
	decoded, _, err := image.Decode(bytes.NewReader(buf))
	if err != nil {
		writeAvatarBadFormat(w)
		return
	}

	var pngBuf bytes.Buffer
	if err := png.Encode(&pngBuf, decoded); err != nil {
		writeError(w, http.StatusInternalServerError, "Failed to upload avatar")
		return
	}
	sum := sha256.Sum256(pngBuf.Bytes())
	name := hex.EncodeToString(sum[:16]) + ".png"
	if err := os.MkdirAll(filepath.Join(h.Dir, "users"), 0o700); err != nil {
		writeError(w, http.StatusInternalServerError, "Failed to upload avatar")
		return
	}
	target := filepath.Join(h.Dir, "users", name)
	if err := os.WriteFile(target, pngBuf.Bytes(), 0o600); err != nil {
		writeError(w, http.StatusInternalServerError, "Failed to upload avatar")
		return
	}
	user, err := h.Auth.SetAvatarURL(r.Context(), userID(r), "/api/avatars/users/"+name)
	if err != nil && !errors.Is(err, auth.ErrNotFound) {
		writeAuthUnavailable(w)
		return
	}
	if user == nil {
		writeInvalidToken(w)
		return
	}
	writeJSON(w, http.StatusOK, UserToDTO(user))
}

// Serve returns a stored avatar with immutable caching.
func (h *AvatarHandlers) Serve(w http.ResponseWriter, r *http.Request) {
	name := r.PathValue("file")
	if !avatarFilePattern.MatchString(name) || strings.Contains(name, "/") || strings.Contains(name, "..") {
		writeError(w, http.StatusNotFound, "Not found")
		return
	}
	target := filepath.Join(h.Dir, "users", filepath.Base(name))
	data, err := os.ReadFile(target)
	if err != nil {
		writeError(w, http.StatusNotFound, "Not found")
		return
	}
	w.Header().Set("Content-Type", "image/png")
	w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(data)
}

func writeAvatarTooLarge(w http.ResponseWriter, maxBytes int64) {
	writeJSON(w, http.StatusBadRequest, errorBody{
		"error":     avatarTooLargeMsg,
		"errorCode": "PROFILE_AVATAR_TOO_LARGE",
		"maxBytes":  maxBytes,
	})
}

func writeAvatarBadFormat(w http.ResponseWriter) {
	writeJSON(w, http.StatusBadRequest, errorBody{
		"error":     avatarBadFormatMsg,
		"errorCode": "PROFILE_AVATAR_BAD_FORMAT",
	})
}
