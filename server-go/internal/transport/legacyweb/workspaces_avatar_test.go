package legacyweb_test

// T11: POST /api/servers/:id/avatar — capability before decoding, the legacy
// multipart/errorCode shapes, content-addressed storage with a served URL,
// and no fake success when the database write fails.

import (
	"bytes"
	"io"
	"mime/multipart"
	"net/http"
	"strings"
	"testing"
)

// rawMultipart builds a multipart body with arbitrary bytes in the avatar
// field (for bad-format paths).
func rawMultipart(t *testing.T, data []byte) (io.Reader, string) {
	t.Helper()
	var buf bytes.Buffer
	writer := multipart.NewWriter(&buf)
	part, err := writer.CreateFormFile("avatar", "avatar.bin")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := part.Write(data); err != nil {
		t.Fatal(err)
	}
	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}
	return &buf, writer.FormDataContentType()
}

func TestServerAvatarUploadContract(t *testing.T) {
	e := newTestEnv(t)
	_, access, _ := e.fullAccount("avatar-owner@example.test", "avatarowner")
	memberID, memberAccess, _ := e.fullAccount("avatar-member@example.test", "avatarmember")
	ws := e.createServer(t, access, "Avatar Lab", "avatar-lab")
	e.addMember(t, ws, memberID, "member")

	// No file at all.
	res := e.serve("POST", "/api/servers/"+ws+"/avatar", map[string]any{}, scoped(access, ws))
	if res.status != http.StatusBadRequest || res.body["error"] != "No avatar file provided" {
		t.Fatalf("no file: %d %s", res.status, res.raw)
	}

	// Garbage multipart bytes are a bad-format errorCode body.
	garbage, garbageType := rawMultipart(t, []byte("not an image at all"))
	garbageHeaders := scoped(access, ws)
	garbageHeaders["Content-Type"] = garbageType
	res = e.serve("POST", "/api/servers/"+ws+"/avatar", garbage, garbageHeaders)
	if res.status != http.StatusBadRequest || res.body["errorCode"] != "PROFILE_AVATAR_BAD_FORMAT" {
		t.Fatalf("bad format: %d %s", res.status, res.raw)
	}

	// A member with an equally invalid body gets the capability 403 first.
	memberGarbage, memberType := rawMultipart(t, []byte("junk"))
	memberHeaders := scoped(memberAccess, ws)
	memberHeaders["Content-Type"] = memberType
	res = e.serve("POST", "/api/servers/"+ws+"/avatar", memberGarbage, memberHeaders)
	if res.status != http.StatusForbidden || res.body["error"] != "Only server owners and admins can edit the server profile" {
		t.Fatalf("member avatar: %d %s", res.status, res.raw)
	}

	// Real PNG: 200, bare ServerRecord with a served URL; the file fetches.
	body, contentType := pngBody(t, 0x40)
	headers := scoped(access, ws)
	headers["Content-Type"] = contentType
	res = e.serve("POST", "/api/servers/"+ws+"/avatar", body, headers)
	if res.status != http.StatusOK {
		t.Fatalf("upload: %d %s", res.status, res.raw)
	}
	avatarURL, _ := res.body["avatarUrl"].(string)
	if !strings.HasPrefix(avatarURL, "/api/avatars/servers/") || !strings.HasSuffix(avatarURL, ".png") {
		t.Fatalf("avatar URL shape: %v", res.body["avatarUrl"])
	}
	served := e.serve("GET", avatarURL, nil, nil)
	if served.status != http.StatusOK || served.header.Get("Content-Type") != "image/png" {
		t.Fatalf("served avatar: %d", served.status)
	}

	// The reference is persisted and survives a re-read.
	detail := e.serve("GET", "/api/servers/"+ws, nil, scoped(access, ws))
	if detail.body["avatarUrl"] != avatarURL {
		t.Fatalf("avatar not persisted: %s", detail.raw)
	}

	// Same pixels => same content address (idempotent publish).
	body2, contentType2 := pngBody(t, 0x40)
	headers2 := scoped(access, ws)
	headers2["Content-Type"] = contentType2
	res2 := e.serve("POST", "/api/servers/"+ws+"/avatar", body2, headers2)
	if res2.status != http.StatusOK || res2.body["avatarUrl"] != avatarURL {
		t.Fatalf("content addressing not idempotent: %d %s", res2.status, res2.raw)
	}
	_ = io.Discard
}

func TestServerAvatarDatabaseFailureIsNotFakeSuccess(t *testing.T) {
	e := newTestEnv(t)
	_, access, _ := e.fullAccount("avatar-db@example.test", "avatardb")
	ws := e.createServer(t, access, "Avatar DB Lab", "avatar-db-lab")

	// Inject a workspace-update failure (isolated SQLite trigger, the
	// established failure-injection pattern). The file may be published, but
	// the response must never claim success nor persist a stale reference.
	if _, err := e.app.DB.Exec(`CREATE TRIGGER reject_avatar_update BEFORE UPDATE OF avatar_url ON workspaces
		BEGIN SELECT RAISE(ABORT, 'injected avatar failure'); END`); err != nil {
		t.Fatal(err)
	}
	body, contentType := pngBody(t, 0x80)
	headers := scoped(access, ws)
	headers["Content-Type"] = contentType
	res := e.serve("POST", "/api/servers/"+ws+"/avatar", body, headers)
	if res.status != http.StatusInternalServerError || res.body["error"] != "Failed to upload avatar" {
		t.Fatalf("db failure must surface as the legacy 500: %d %s", res.status, res.raw)
	}
	detail := e.serve("GET", "/api/servers/"+ws, nil, scoped(access, ws))
	if detail.body["avatarUrl"] != nil {
		t.Fatalf("failed upload must not persist a reference: %s", detail.raw)
	}
}
