package config

import (
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
)

// loadOrCreateSecret publishes a fully written key exactly once. Rename would
// overwrite a racing creator's key; O_EXCL on the final name would expose a
// partially written file. Linking a synced temporary file avoids both races.
// The data directory must be on a local filesystem that supports hard links.
func loadOrCreateSecret(envSecret, path string) ([]byte, error) {
	if envSecret != "" {
		if len(envSecret) < 32 {
			return nil, fmt.Errorf("RAFT_GO_JWT_SECRET must be at least 32 bytes")
		}
		return []byte(envSecret), nil
	}
	if path == "" {
		return nil, fmt.Errorf("a signing key path is required when RAFT_GO_JWT_SECRET is unset")
	}
	dir, name := filepath.Dir(path), filepath.Base(path)
	if err := os.MkdirAll(dir, 0700); err != nil {
		return nil, fmt.Errorf("create key dir: %w", err)
	}
	info, err := os.Lstat(dir)
	if err != nil {
		return nil, err
	}
	if !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		return nil, fmt.Errorf("key directory must be a non-symlink directory")
	}
	root, err := os.OpenRoot(dir)
	if err != nil {
		return nil, err
	}
	defer root.Close()
	if err := root.Chmod(".", 0700); err != nil {
		return nil, fmt.Errorf("restrict key directory: %w", err)
	}
	if data, err := readSecret(root, name); err == nil {
		return data, nil
	} else if !errors.Is(err, os.ErrNotExist) {
		// Corruption, wrong permissions and I/O failures are not permission to
		// rotate a key. An operator must restore it from their private backup.
		return nil, err
	}
	secret, err := randomBytes(32)
	if err != nil {
		return nil, err
	}
	suffix, err := randomBytes(16)
	if err != nil {
		return nil, err
	}
	tmp := fmt.Sprintf(".jwt-secret-%x", suffix)
	f, err := root.OpenFile(tmp, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600)
	if err != nil {
		return nil, fmt.Errorf("prepare signing key: %w", err)
	}
	defer root.Remove(tmp)
	defer f.Close()
	if _, err := f.Write(secret); err != nil {
		return nil, fmt.Errorf("write signing key: %w", err)
	}
	if err := f.Sync(); err != nil {
		return nil, fmt.Errorf("sync signing key: %w", err)
	}
	if err := f.Close(); err != nil {
		return nil, err
	}
	if err := root.Link(tmp, name); err != nil && !errors.Is(err, os.ErrExist) {
		return nil, fmt.Errorf("publish signing key (local hard-link support required): %w", err)
	}
	// All starters read the winner, including when another process won.
	return readSecret(root, name)
}

func readSecret(root *os.Root, name string) ([]byte, error) {
	info, err := root.Lstat(name)
	if err != nil {
		return nil, err
	}
	if !info.Mode().IsRegular() {
		return nil, fmt.Errorf("signing key must be a regular non-symlink file")
	}
	f, err := root.Open(name)
	if err != nil {
		return nil, fmt.Errorf("open signing key: %w", err)
	}
	defer f.Close()
	opened, err := f.Stat()
	if err != nil {
		return nil, err
	}
	if !os.SameFile(info, opened) {
		return nil, fmt.Errorf("signing key changed while opening")
	}
	data, err := io.ReadAll(io.LimitReader(f, 4097))
	if err != nil {
		return nil, fmt.Errorf("read signing key: %w", err)
	}
	if len(data) < 32 || len(data) > 4096 {
		return nil, fmt.Errorf("invalid persisted signing key length; restore the original key, do not regenerate it")
	}
	if err := f.Chmod(0600); err != nil {
		return nil, fmt.Errorf("restrict signing key: %w", err)
	}
	return data, nil
}
