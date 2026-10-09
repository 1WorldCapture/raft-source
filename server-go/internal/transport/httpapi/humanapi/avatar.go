// Avatar upload with strict validation (declared + sniffed type, dimension
// caps, size caps) and re-encoding to PNG so nothing but pixels persists.
// Uploaded bytes live under the private data dir; served paths are
// content-addressed and immutable. The same pipeline serves user avatars
// (/api/avatars/users) and workspace avatars (/api/avatars/servers).
package humanapi

import (
	"bytes"
	"errors"
	"image"
	"image/png"
	"io"
	"net/http"
	"raft.local/server-go/internal/transport/httpapi/authn"
	"raft.local/server-go/internal/transport/httpapi/httpx"
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
	Users    authn.UserLookup
}

// decodeValidatedAvatarPNG parses the multipart "avatar" field, enforces the
// legacy size/content/dimension caps and re-encodes the pixels to PNG. Error
// responses (including the legacy errorCode shapes) are written here; the
// caller only checks ok.
func decodeValidatedAvatarPNG(w http.ResponseWriter, r *http.Request, maxBytes int64, maxSide int) ([]byte, bool) {
	if maxBytes <= 0 {
		maxBytes = maxAvatarBytesDefault
	}
	r.Body = http.MaxBytesReader(w, r.Body, maxBytes+(64*1024))
	if err := r.ParseMultipartForm(1 << 20); err != nil {
		var tooLarge *http.MaxBytesError
		if errors.As(err, &tooLarge) {
			writeAvatarTooLarge(w, maxBytes)
			return nil, false
		}
		httpx.WriteError(w, http.StatusBadRequest, "No avatar file provided")
		return nil, false
	}
	file, _, err := r.FormFile("avatar")
	if err != nil {
		httpx.WriteError(w, http.StatusBadRequest, "No avatar file provided")
		return nil, false
	}
	defer file.Close()

	buf, err := io.ReadAll(io.LimitReader(file, maxBytes+1))
	if err != nil {
		httpx.WriteError(w, http.StatusBadRequest, avatarBadFormatMsg)
		return nil, false
	}
	if int64(len(buf)) > maxBytes {
		writeAvatarTooLarge(w, maxBytes)
		return nil, false
	}
	if len(buf) == 0 {
		httpx.WriteError(w, http.StatusBadRequest, avatarBadFormatMsg)
		return nil, false
	}

	sniffed := http.DetectContentType(buf)
	switch sniffed {
	case "image/jpeg", "image/png", "image/gif", "image/webp":
	default:
		writeAvatarBadFormat(w)
		return nil, false
	}

	config, _, err := image.DecodeConfig(bytes.NewReader(buf))
	if err != nil {
		writeAvatarBadFormat(w)
		return nil, false
	}
	if maxSide <= 0 {
		maxSide = maxAvatarSideDefault
	}
	if config.Width <= 0 || config.Height <= 0 || config.Width > maxSide || config.Height > maxSide {
		writeAvatarBadFormat(w)
		return nil, false
	}
	// Full decode validates integrity (truncated files fail here) and feeds
	// the re-encode below.
	decoded, _, err := image.Decode(bytes.NewReader(buf))
	if err != nil {
		writeAvatarBadFormat(w)
		return nil, false
	}

	var pngBuf bytes.Buffer
	if err := png.Encode(&pngBuf, decoded); err != nil {
		httpx.WriteError(w, http.StatusInternalServerError, "Failed to upload avatar")
		return nil, false
	}
	return pngBuf.Bytes(), true
}

// publishServerAvatar stores a workspace avatar under <dir>/servers.
func publishServerAvatar(dir string, png []byte) (string, error) {
	return publishAvatar(dir, "servers", png)
}

// Upload validates and stores the multipart "avatar" file, then persists the
// stored path as the user's avatarUrl.
func (h *AvatarHandlers) Upload(w http.ResponseWriter, r *http.Request) {
	if _, ok := authn.RequestUser(h.Users, w, r, authn.UserID(r)); !ok {
		return
	}
	png, ok := decodeValidatedAvatarPNG(w, r, h.MaxBytes, h.MaxSide)
	if !ok {
		return
	}
	avatarURL, err := publishAvatar(h.Dir, "users", png)
	if err != nil {
		httpx.WriteError(w, http.StatusInternalServerError, "Failed to upload avatar")
		return
	}
	user, err := h.Auth.SetAvatarURL(r.Context(), authn.UserID(r), avatarURL)
	if err != nil && !errors.Is(err, auth.ErrNotFound) {
		httpx.WriteAuthUnavailable(w)
		return
	}
	if user == nil {
		httpx.WriteInvalidToken(w)
		return
	}
	httpx.WriteJSON(w, http.StatusOK, UserToDTO(user))
}

// Serve returns a stored user avatar with immutable caching.
func (h *AvatarHandlers) Serve(w http.ResponseWriter, r *http.Request) {
	serveAvatarFile(w, r, h.Dir, "users")
}

// ServeServer returns a stored workspace avatar with immutable caching.
func (h *AvatarHandlers) ServeServer(w http.ResponseWriter, r *http.Request) {
	serveAvatarFile(w, r, h.Dir, "servers")
}

// serveAvatarFile streams one immutable content-addressed avatar file. The
// name pattern and traversal guards keep the namespace fixed.
func serveAvatarFile(w http.ResponseWriter, r *http.Request, dir, namespace string) {
	name := r.PathValue("file")
	if !avatarFilePattern.MatchString(name) || strings.Contains(name, "/") || strings.Contains(name, "..") {
		httpx.WriteError(w, http.StatusNotFound, "Not found")
		return
	}
	root, err := openAvatarNamespace(dir, namespace, false)
	if err != nil {
		httpx.WriteError(w, http.StatusNotFound, "Not found")
		return
	}
	defer root.Close()
	file, err := openRegularAvatar(root, name)
	if err != nil {
		httpx.WriteError(w, http.StatusNotFound, "Not found")
		return
	}
	defer file.Close()
	w.Header().Set("Content-Type", "image/png")
	w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.WriteHeader(http.StatusOK)
	_, _ = io.Copy(w, file)
}

func writeAvatarTooLarge(w http.ResponseWriter, maxBytes int64) {
	httpx.WriteJSON(w, http.StatusBadRequest, httpx.ErrorBody{
		"error":     avatarTooLargeMsg,
		"errorCode": "PROFILE_AVATAR_TOO_LARGE",
		"maxBytes":  maxBytes,
	})
}

func writeAvatarBadFormat(w http.ResponseWriter) {
	httpx.WriteJSON(w, http.StatusBadRequest, httpx.ErrorBody{
		"error":     avatarBadFormatMsg,
		"errorCode": "PROFILE_AVATAR_BAD_FORMAT",
	})
}
