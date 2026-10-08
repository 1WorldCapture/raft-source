// Command m1-upgrade creates an M1-only database for process acceptance.
// It ALWAYS allocates its own private temporary directory; it cannot target an
// existing deployment. Stdout contains test credentials for the parent harness
// and must be captured, never copied to ordinary test logs.
package main

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"image"
	"image/color"
	"image/png"
	"io"
	"log/slog"
	"net/url"
	"os"
	"path/filepath"
	"runtime"
	"time"

	_ "modernc.org/sqlite"
	"raft.local/server-go/internal/auth"
	"raft.local/server-go/internal/platform/keys"
)

type privateMailbox struct{ tokens map[string]string }

func (m *privateMailbox) Name() string { return "isolated-m1-fixture" }
func (m *privateMailbox) Send(_ context.Context, message auth.MailMessage) error {
	if message.Kind == "verify" {
		m.tokens[message.To] = message.Token
	}
	return nil
}

type fixtureAccount struct {
	UserID       string `json:"userId"`
	Email        string `json:"email"`
	Password     string `json:"password"`
	AccessToken  string `json:"accessToken"`
	RefreshToken string `json:"refreshToken"`
	VerifyToken  string `json:"verifyToken,omitempty"`
}

type fixture struct {
	DataDir     string         `json:"dataDir"`
	Owner       fixtureAccount `json:"owner"`
	CoOwner     fixtureAccount `json:"coOwner"`
	Pending     fixtureAccount `json:"pending"`
	WorkspaceID string         `json:"workspaceId"`
	Slug        string         `json:"slug"`
	AvatarURL   string         `json:"avatarUrl"`
	AvatarHash  string         `json:"avatarHash"`
	KeyHash     string         `json:"keyHash"`
}

func main() {
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, "M1 temporary fixture creation failed:", err)
		os.Exit(1)
	}
}

func run() error {
	dir, err := os.MkdirTemp("", "raft-go-m1-upgrade-")
	if err != nil {
		return err
	}
	keep := false
	defer func() {
		if !keep {
			_ = os.RemoveAll(dir)
		}
	}()
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	u := url.URL{Scheme: "file", Path: filepath.ToSlash(filepath.Join(dir, "raft.db"))}
	q := url.Values{"_txlock": {"immediate"}, "_pragma": {"foreign_keys(1)", "journal_mode(WAL)", "busy_timeout(10000)"}}
	u.RawQuery = q.Encode()
	handle, err := sql.Open("sqlite", u.String())
	if err != nil {
		return err
	}
	defer handle.Close()
	if _, err := handle.ExecContext(ctx, `CREATE TABLE schema_migrations(version TEXT PRIMARY KEY,applied_at INTEGER NOT NULL)`); err != nil {
		return err
	}
	_, currentFile, _, ok := runtime.Caller(0)
	if !ok {
		return fmt.Errorf("cannot locate immutable M1 migration sources")
	}
	root := filepath.Clean(filepath.Join(filepath.Dir(currentFile), "../../.."))
	for _, name := range []string{"0001_init.sql", "0002_account_email_requests.sql"} {
		body, err := os.ReadFile(filepath.Join(root, "internal/platform/db/migrations", name))
		if err != nil {
			return err
		}
		tx, err := handle.BeginTx(ctx, nil)
		if err != nil {
			return err
		}
		if _, err := tx.ExecContext(ctx, string(body)); err != nil {
			_ = tx.Rollback()
			return err
		}
		if _, err := tx.ExecContext(ctx, `INSERT INTO schema_migrations VALUES (?,?)`, name, time.Now().UnixMilli()); err != nil {
			_ = tx.Rollback()
			return err
		}
		if err := tx.Commit(); err != nil {
			return err
		}
	}
	secret := make([]byte, 32)
	if _, err := rand.Read(secret); err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Join(dir, "keys"), 0o700); err != nil {
		return err
	}
	if err := os.WriteFile(filepath.Join(dir, "keys/jwt-secret"), secret, 0o600); err != nil {
		return err
	}
	receiptKey, err := keys.NewRoot(secret).RefreshReceiptKey()
	if err != nil {
		return err
	}
	store := auth.NewStore(handle)
	signer := auth.NewTokenSigner(secret, 15*time.Minute)
	sessions := auth.NewSessionService(handle, store, signer, receiptKey, 30*24*time.Hour, 10*time.Second, 24*time.Hour)
	mailbox := &privateMailbox{tokens: make(map[string]string)}
	service := auth.NewService(store, sessions, auth.NewPasswordHasher(65536, 3, 1, 2), mailbox, slog.New(slog.NewTextHandler(io.Discard, nil)), nil, "Raft <noreply@example.test>", 24*time.Hour, time.Hour)
	create := func(label string, complete bool) (fixtureAccount, error) {
		account := fixtureAccount{Email: label + "@example.test", Password: "Temporary-M1-" + auth.NewOpaqueToken() + "!"}
		user, session, err := service.Register(ctx, auth.RegisterInput{Email: account.Email, Password: account.Password, Legal: auth.LegalAcceptanceInput{AcceptTerms: true, TermsVersion: auth.TermsVersionCurrent, PrivacyVersion: auth.PrivacyVersionCurrent}})
		if err != nil {
			return account, err
		}
		account.UserID, account.RefreshToken = user.ID, session.RefreshToken
		account.AccessToken, err = signer.SignAccessToken(user.ID, session.FamilyID)
		if err != nil {
			return account, err
		}
		account.VerifyToken = mailbox.tokens[account.Email]
		if account.VerifyToken == "" {
			return account, fmt.Errorf("M1 account did not issue a verification message")
		}
		if complete {
			if err := service.VerifyEmail(ctx, account.VerifyToken); err != nil {
				return account, err
			}
			if _, err := service.CompleteProfile(ctx, user.ID, "m1_"+label, "M1 "+label); err != nil {
				return account, err
			}
			account.VerifyToken = ""
		}
		return account, nil
	}
	owner, err := create("owner", true)
	if err != nil {
		return err
	}
	coOwner, err := create("coowner", true)
	if err != nil {
		return err
	}
	pending, err := create("pending", false)
	if err != nil {
		return err
	}
	picture := image.NewRGBA(image.Rect(0, 0, 2, 2))
	picture.Set(0, 0, color.RGBA{R: 34, G: 80, B: 150, A: 255})
	var imageBytes bytes.Buffer
	if err := png.Encode(&imageBytes, picture); err != nil {
		return err
	}
	imageHash := sha256.Sum256(imageBytes.Bytes())
	avatarHash := hex.EncodeToString(imageHash[:])
	file := avatarHash[:32] + ".png"
	if err := os.MkdirAll(filepath.Join(dir, "avatars", "users"), 0o700); err != nil {
		return err
	}
	if err := os.WriteFile(filepath.Join(dir, "avatars", "users", file), imageBytes.Bytes(), 0o600); err != nil {
		return err
	}
	avatarURL := "/api/avatars/users/" + file
	if _, err := service.SetAvatarURL(ctx, owner.UserID, avatarURL); err != nil {
		return err
	}
	workspaceID := auth.NewUUID()
	now := time.Now().UnixMilli()
	if _, err := handle.ExecContext(ctx, `INSERT INTO workspaces(id,name,slug,owner_id,avatar_url,created_at) VALUES(?,?,?,?,?,?)`, workspaceID, "Existing M1 workspace", "existing-m1-space", owner.UserID, avatarURL, now); err != nil {
		return err
	}
	// The original schema default, not an explicit role assignment. Both rows
	// must remain owner when M2 changes FUTURE inserts to default member.
	for i, account := range []fixtureAccount{owner, coOwner} {
		if _, err := handle.ExecContext(ctx, `INSERT INTO workspace_memberships(workspace_id,user_id,joined_at) VALUES(?,?,?)`, workspaceID, account.UserID, now+int64(i)); err != nil {
			return err
		}
	}
	if err := handle.Close(); err != nil {
		return err
	}
	keyHash := sha256.Sum256(secret)
	result := fixture{DataDir: dir, Owner: owner, CoOwner: coOwner, Pending: pending, WorkspaceID: workspaceID, Slug: "existing-m1-space", AvatarURL: avatarURL, AvatarHash: avatarHash, KeyHash: hex.EncodeToString(keyHash[:])}
	if err := json.NewEncoder(os.Stdout).Encode(result); err != nil {
		return err
	}
	keep = true // caller owns only this newly allocated directory after success
	return nil
}
