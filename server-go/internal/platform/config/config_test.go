package config

import (
	"bytes"
	"os"
	"path/filepath"
	"runtime"
	"sync"
	"testing"
)

func lookup(values map[string]string) LookupFunc {
	return func(name string) (string, bool) { value, ok := values[name]; return value, ok }
}

func TestSecretSurvivesConcurrentFirstStart(t *testing.T) {
	path := filepath.Join(t.TempDir(), "keys", "jwt-secret")
	const workers = 32
	start := make(chan struct{})
	secrets := make([][]byte, workers)
	errs := make([]error, workers)
	var wg sync.WaitGroup
	for i := range workers {
		wg.Add(1)
		go func() {
			defer wg.Done()
			<-start
			secrets[i], errs[i] = loadOrCreateSecret("", path)
		}()
	}
	close(start)
	wg.Wait()
	persisted, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	for i := range workers {
		if errs[i] != nil {
			t.Errorf("startup %d: %v", i, errs[i])
		}
		if !bytes.Equal(secrets[i], persisted) {
			t.Errorf("startup %d got a different signing key", i)
		}
	}
	if len(persisted) != 32 {
		t.Errorf("generated key length = %d, want 32", len(persisted))
	}
	again, err := loadOrCreateSecret("", path)
	if err != nil || !bytes.Equal(again, persisted) {
		t.Fatalf("restart must preserve the signing key: %v", err)
	}
	entries, err := os.ReadDir(filepath.Dir(path))
	if err != nil || len(entries) != 1 {
		t.Fatalf("startup left temporary secret files: count=%d, err=%v", len(entries), err)
	}
}

func TestSecretInvalidFileFailsWithoutReplacement(t *testing.T) {
	for _, contents := range [][]byte{nil, []byte("truncated"), bytes.Repeat([]byte("x"), 4097)} {
		t.Run(string(rune('a'+len(contents)%26)), func(t *testing.T) {
			path := filepath.Join(t.TempDir(), "jwt-secret")
			if err := os.WriteFile(path, contents, 0600); err != nil {
				t.Fatal(err)
			}
			if _, err := loadOrCreateSecret("", path); err == nil {
				t.Fatal("invalid existing key must fail closed, never silently rotate")
			}
			after, err := os.ReadFile(path)
			if err != nil || !bytes.Equal(after, contents) {
				t.Fatalf("invalid key was modified: %v", err)
			}
		})
	}
}

func TestSecretRejectsSymlinkAndDirectory(t *testing.T) {
	dir := t.TempDir()
	target := filepath.Join(dir, "target")
	original := bytes.Repeat([]byte("k"), 32)
	if err := os.WriteFile(target, original, 0600); err != nil {
		t.Fatal(err)
	}
	link := filepath.Join(dir, "linked-key")
	if err := os.Symlink(target, link); err != nil {
		if runtime.GOOS == "windows" {
			t.Skip("creating symlinks requires Windows privileges")
		}
		t.Fatal(err)
	}
	if _, err := loadOrCreateSecret("", link); err == nil {
		t.Error("symlink must not be accepted as a signing key")
	}
	if _, err := loadOrCreateSecret("", dir); err == nil {
		t.Error("directory must not be accepted as a signing key")
	}
	after, err := os.ReadFile(target)
	if err != nil || !bytes.Equal(after, original) {
		t.Fatalf("symlink target changed: %v", err)
	}
}

func TestSecretRestrictsExistingFilePermissions(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("POSIX mode bits do not describe Windows ACLs")
	}
	dir := filepath.Join(t.TempDir(), "keys")
	if err := os.Mkdir(dir, 0755); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(dir, "jwt-secret")
	if err := os.WriteFile(path, bytes.Repeat([]byte("k"), 32), 0644); err != nil {
		t.Fatal(err)
	}
	if _, err := loadOrCreateSecret("", path); err != nil {
		t.Fatal(err)
	}
	for path, want := range map[string]os.FileMode{dir: 0700, path: 0600} {
		info, err := os.Stat(path)
		if err != nil || info.Mode().Perm() != want {
			t.Errorf("%s must have private permissions %o: %v", path, want, err)
		}
	}
}

func TestInvalidConfigurationDoesNotCreateKey(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "keys", "jwt-secret")
	_, err := Load(lookup(map[string]string{"RAFT_GO_MAIL_MODE": "invalid"}), dir, path)
	if err == nil {
		t.Fatal("invalid configuration accepted")
	}
	if _, err := os.Stat(path); !os.IsNotExist(err) {
		t.Fatal("invalid configuration must not generate a signing key")
	}
}

func TestWebOriginRejectsCredentialsAndInvalidPorts(t *testing.T) {
	for _, origin := range []string{
		"https://user:password@example.test", "https://example.test?", "https://example.test:0",
		"https://example.test:65536", "https://example.test/path", "javascript:alert(1)",
	} {
		t.Run(origin, func(t *testing.T) {
			if _, err := parseHTTPOrigin(origin); err == nil {
				t.Fatal("invalid public origin accepted")
			}
		})
	}
	for _, origin := range []string{"http://127.0.0.1:5175", "http://[::1]:5175", "https://example.test/"} {
		if _, err := parseHTTPOrigin(origin); err != nil {
			t.Errorf("valid origin %q rejected: %v", origin, err)
		}
	}
}

func TestExplicitSecretDoesNotTouchDisk(t *testing.T) {
	path := filepath.Join(t.TempDir(), "unused", "jwt-secret")
	secret := string(bytes.Repeat([]byte("e"), 32))
	got, err := loadOrCreateSecret(secret, path)
	if err != nil || string(got) != secret {
		t.Fatalf("explicit secret: %v", err)
	}
	if _, err := os.Stat(filepath.Dir(path)); !os.IsNotExist(err) {
		t.Fatal("explicit key must not create a key directory")
	}
}
