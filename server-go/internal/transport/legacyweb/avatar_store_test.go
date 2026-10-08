package legacyweb

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
)

func TestM2AvatarConcurrentPublicationIsImmutable(t *testing.T) {
	dir := t.TempDir()
	content := bytes.Repeat([]byte("validated-image-pixels"), 4096)
	const workers = 16
	results := make([]string, workers)
	errs := make([]error, workers)
	var wg sync.WaitGroup
	for i := range workers {
		wg.Add(1)
		go func() {
			defer wg.Done()
			results[i], errs[i] = publishAvatar(dir, "servers", content)
		}()
	}
	wg.Wait()
	for i := range workers {
		if errs[i] != nil || results[i] != results[0] {
			t.Fatalf("concurrent publish %d = %q, %v", i, results[i], errs[i])
		}
	}
	name := filepath.Base(results[0])
	stored, err := os.ReadFile(filepath.Join(dir, "servers", name))
	if err != nil || !bytes.Equal(stored, content) {
		t.Fatalf("published bytes are not complete: %v", err)
	}
	info, err := os.Stat(filepath.Join(dir, "servers", name))
	if err != nil || info.Mode().Perm() != 0o600 {
		t.Fatalf("published file must be private: %v", err)
	}
	entries, err := os.ReadDir(filepath.Join(dir, "servers"))
	if err != nil || len(entries) != 1 {
		t.Fatalf("temporary files leaked: %d entries, %v", len(entries), err)
	}
	req := httptest.NewRequest(http.MethodGet, results[0], nil)
	req.SetPathValue("file", name)
	response := httptest.NewRecorder()
	serveAvatarFile(response, req, dir, "servers")
	if response.Code != http.StatusOK || !bytes.Equal(response.Body.Bytes(), content) {
		t.Fatal("published immutable content could not be served intact")
	}
}

func TestM2AvatarRefusesSymlinkNamespaceAndContent(t *testing.T) {
	for _, namespaceLink := range []bool{false, true} {
		t.Run(map[bool]string{false: "content", true: "namespace"}[namespaceLink], func(t *testing.T) {
			dir, outside := t.TempDir(), t.TempDir()
			content := []byte("new pixels")
			sum := sha256.Sum256(content)
			name := hex.EncodeToString(sum[:16]) + ".png"
			secret := filepath.Join(outside, name)
			if err := os.WriteFile(secret, []byte("must not be exposed or overwritten"), 0o600); err != nil {
				t.Fatal(err)
			}
			if namespaceLink {
				if err := os.Symlink(outside, filepath.Join(dir, "servers")); err != nil {
					t.Fatal(err)
				}
			} else {
				if err := os.Mkdir(filepath.Join(dir, "servers"), 0o700); err != nil {
					t.Fatal(err)
				}
				if err := os.Symlink(secret, filepath.Join(dir, "servers", name)); err != nil {
					t.Fatal(err)
				}
			}
			if _, err := publishAvatar(dir, "servers", content); err == nil {
				t.Fatal("symlink publication must fail closed")
			}
			req := httptest.NewRequest(http.MethodGet, "/api/avatars/servers/"+name, nil)
			req.SetPathValue("file", name)
			response := httptest.NewRecorder()
			serveAvatarFile(response, req, dir, "servers")
			if response.Code != http.StatusNotFound || strings.Contains(response.Body.String(), "must not") {
				t.Fatal("symlink target was exposed")
			}
			preserved, err := os.ReadFile(secret)
			if err != nil || string(preserved) != "must not be exposed or overwritten" {
				t.Fatal("publication modified a symlink target")
			}
		})
	}
}

func TestM2AvatarNeverOverwritesMismatchedExistingContent(t *testing.T) {
	dir := t.TempDir()
	content := []byte("valid content")
	url, err := publishAvatar(dir, "users", content)
	if err != nil {
		t.Fatal(err)
	}
	file := filepath.Join(dir, "users", filepath.Base(url))
	if err := os.WriteFile(file, []byte("preexisting drift"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := publishAvatar(dir, "users", content); err == nil {
		t.Fatal("a corrupt existing content address must not be silently overwritten")
	}
	got, err := os.ReadFile(file)
	if err != nil || string(got) != "preexisting drift" {
		t.Fatal("existing file was changed")
	}
}
