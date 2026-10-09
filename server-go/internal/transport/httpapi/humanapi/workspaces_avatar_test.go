package humanapi_test

// T11: POST /api/servers/:id/avatar — capability before decoding, the legacy
// multipart/errorCode shapes, content-addressed storage with a served URL,
// and no fake success when the database write fails.

import (
	"bytes"
	"io"
	"mime/multipart"
	"net/http"
	"raft.local/server-go/tests/testkit"
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
	e := testkit.NewTestEnv(t)
	_, access, _ := e.FullAccount("avatar-owner@example.test", "avatarowner")
	memberID, memberAccess, _ := e.FullAccount("avatar-member@example.test", "avatarmember")
	ws := e.CreateServer(t, access, "Avatar Lab", "avatar-lab")
	e.AddMember(t, ws, memberID, "member")

	// No file at all.
	res := e.Serve("POST", "/api/servers/"+ws+"/avatar", map[string]any{}, testkit.Scoped(access, ws))
	if res.Status != http.StatusBadRequest || res.Body["error"] != "No avatar file provided" {
		t.Fatalf("no file: %d %s", res.Status, res.Raw)
	}

	// Garbage multipart bytes are a bad-format errorCode body.
	garbage, garbageType := rawMultipart(t, []byte("not an image at all"))
	garbageHeaders := testkit.Scoped(access, ws)
	garbageHeaders["Content-Type"] = garbageType
	res = e.Serve("POST", "/api/servers/"+ws+"/avatar", garbage, garbageHeaders)
	if res.Status != http.StatusBadRequest || res.Body["errorCode"] != "PROFILE_AVATAR_BAD_FORMAT" {
		t.Fatalf("bad format: %d %s", res.Status, res.Raw)
	}

	// A member with an equally invalid body gets the capability 403 first.
	memberGarbage, memberType := rawMultipart(t, []byte("junk"))
	memberHeaders := testkit.Scoped(memberAccess, ws)
	memberHeaders["Content-Type"] = memberType
	res = e.Serve("POST", "/api/servers/"+ws+"/avatar", memberGarbage, memberHeaders)
	if res.Status != http.StatusForbidden || res.Body["error"] != "Only server owners and admins can edit the server profile" {
		t.Fatalf("member avatar: %d %s", res.Status, res.Raw)
	}

	// Real PNG: 200, bare ServerRecord with a served URL; the file fetches.
	body, contentType := testkit.PngBody(t, 0x40)
	headers := testkit.Scoped(access, ws)
	headers["Content-Type"] = contentType
	res = e.Serve("POST", "/api/servers/"+ws+"/avatar", body, headers)
	if res.Status != http.StatusOK {
		t.Fatalf("upload: %d %s", res.Status, res.Raw)
	}
	avatarURL, _ := res.Body["avatarUrl"].(string)
	if !strings.HasPrefix(avatarURL, "/api/avatars/servers/") || !strings.HasSuffix(avatarURL, ".png") {
		t.Fatalf("avatar URL shape: %v", res.Body["avatarUrl"])
	}
	served := e.Serve("GET", avatarURL, nil, nil)
	if served.Status != http.StatusOK || served.Header.Get("Content-Type") != "image/png" {
		t.Fatalf("served avatar: %d", served.Status)
	}

	// The reference is persisted and survives a re-read.
	detail := e.Serve("GET", "/api/servers/"+ws, nil, testkit.Scoped(access, ws))
	if detail.Body["avatarUrl"] != avatarURL {
		t.Fatalf("avatar not persisted: %s", detail.Raw)
	}

	// Same pixels => same content address (idempotent publish).
	body2, contentType2 := testkit.PngBody(t, 0x40)
	headers2 := testkit.Scoped(access, ws)
	headers2["Content-Type"] = contentType2
	res2 := e.Serve("POST", "/api/servers/"+ws+"/avatar", body2, headers2)
	if res2.Status != http.StatusOK || res2.Body["avatarUrl"] != avatarURL {
		t.Fatalf("content addressing not idempotent: %d %s", res2.Status, res2.Raw)
	}
	_ = io.Discard
}

func TestServerAvatarDatabaseFailureIsNotFakeSuccess(t *testing.T) {
	e := testkit.NewTestEnv(t)
	_, access, _ := e.FullAccount("avatar-db@example.test", "avatardb")
	ws := e.CreateServer(t, access, "Avatar DB Lab", "avatar-db-lab")

	// Inject a workspace-update failure (isolated SQLite trigger, the
	// established failure-injection pattern). The file may be published, but
	// the rec must never claim success nor persist a stale reference.
	if _, err := e.App.DB.Exec(`CREATE TRIGGER reject_avatar_update BEFORE UPDATE OF avatar_url ON workspaces
		BEGIN SELECT RAISE(ABORT, 'injected avatar failure'); END`); err != nil {
		t.Fatal(err)
	}
	body, contentType := testkit.PngBody(t, 0x80)
	headers := testkit.Scoped(access, ws)
	headers["Content-Type"] = contentType
	res := e.Serve("POST", "/api/servers/"+ws+"/avatar", body, headers)
	if res.Status != http.StatusInternalServerError || res.Body["error"] != "Failed to upload avatar" {
		t.Fatalf("db failure must surface as the legacy 500: %d %s", res.Status, res.Raw)
	}
	detail := e.Serve("GET", "/api/servers/"+ws, nil, testkit.Scoped(access, ws))
	if detail.Body["avatarUrl"] != nil {
		t.Fatalf("failed upload must not persist a reference: %s", detail.Raw)
	}
}
