package humanapi

import (
	"bytes"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"os"
)

// openAvatarNamespace confines every file operation to a real, private avatar
// namespace. Symlinks at the namespace or content-file boundary are rejected.
func openAvatarNamespace(dir, namespace string, create bool) (*os.Root, error) {
	if namespace != "users" && namespace != "servers" {
		return nil, fmt.Errorf("invalid avatar namespace")
	}
	if create {
		if err := os.MkdirAll(dir, 0o700); err != nil {
			return nil, err
		}
	}
	info, err := os.Lstat(dir)
	if err != nil {
		return nil, err
	}
	if !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		return nil, fmt.Errorf("avatar directory is not a real directory")
	}
	root, err := os.OpenRoot(dir)
	if err != nil {
		return nil, err
	}
	defer root.Close()
	if create {
		if err := root.Mkdir(namespace, 0o700); err != nil && !errors.Is(err, os.ErrExist) {
			return nil, err
		}
	}
	info, err = root.Lstat(namespace)
	if err != nil {
		return nil, err
	}
	if !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		return nil, fmt.Errorf("avatar namespace is not a real directory")
	}
	return root.OpenRoot(namespace)
}

func openRegularAvatar(root *os.Root, name string) (*os.File, error) {
	info, err := root.Lstat(name)
	if err != nil {
		return nil, err
	}
	if !info.Mode().IsRegular() {
		return nil, fmt.Errorf("avatar is not a regular file")
	}
	file, err := root.Open(name)
	if err != nil {
		return nil, err
	}
	openedInfo, err := file.Stat()
	if err != nil || !openedInfo.Mode().IsRegular() || !os.SameFile(info, openedInfo) {
		file.Close()
		return nil, fmt.Errorf("avatar file changed while opening")
	}
	return file, nil
}

// publishAvatar keeps the M1 content-address URL (first 128 bits of SHA-256).
// Write/sync/close a private exclusive temporary file before atomically linking
// its complete bytes into the immutable namespace. Concurrent identical uploads
// reuse the existing verified file; nothing truncates a file already referenced
// by a user/workspace. Database failure may leave an orphan, never deletes it.
// This requires a filesystem supporting same-directory hard links; a failure
// stays a failure rather than falling back to an unsafe in-place write.
func publishAvatar(dir, namespace string, png []byte) (string, error) {
	root, err := openAvatarNamespace(dir, namespace, true)
	if err != nil {
		return "", err
	}
	defer root.Close()
	sum := sha256.Sum256(png)
	name := hex.EncodeToString(sum[:16]) + ".png"
	var nonce [16]byte
	if _, err := rand.Read(nonce[:]); err != nil {
		return "", err
	}
	temporary := ".pending-" + hex.EncodeToString(nonce[:])
	file, err := root.OpenFile(temporary, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
	if err != nil {
		return "", err
	}
	defer root.Remove(temporary)
	defer file.Close()
	if n, err := file.Write(png); err != nil {
		return "", err
	} else if n != len(png) {
		return "", io.ErrShortWrite
	}
	if err := file.Sync(); err != nil {
		return "", err
	}
	if err := file.Close(); err != nil {
		return "", err
	}
	if err := root.Link(temporary, name); err != nil {
		if !errors.Is(err, os.ErrExist) {
			return "", err
		}
		existing, err := openRegularAvatar(root, name)
		if err != nil {
			return "", err
		}
		defer existing.Close()
		content, err := io.ReadAll(io.LimitReader(existing, int64(len(png))+1))
		if err != nil || !bytes.Equal(content, png) {
			return "", fmt.Errorf("existing avatar does not match its content address")
		}
	}
	return "/api/avatars/" + namespace + "/" + name, nil
}
