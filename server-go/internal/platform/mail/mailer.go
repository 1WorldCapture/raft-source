// Package mail abstracts outgoing mail. Remote SMTP requires STARTTLS;
// development defaults to a private local file outbox
// so no external service is required and message contents never leave the
// machine. Tokens are never logged by either implementation.
package mail

import (
	"context"
	"crypto/rand"
	"crypto/tls"
	"encoding/json"
	"fmt"
	"net"
	"net/smtp"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"
)

// Message is one outbound email. Kind/Token (account emails only) let
// machine readers (tests, the mailbox CLI) recover the link payload without
// parsing HTML; they live in the private outbox file, never in logs.
type Message struct {
	From    string
	To      string
	Subject string
	HTML    string
	Text    string
	Kind    string // "verify" | "reset" when applicable
	Token   string
}

// Mailer sends messages. Implementations must be safe for concurrent use.
type Mailer interface {
	Send(ctx context.Context, msg Message) error
	// Name identifies the transport in diagnostics ("outbox", "smtp").
	Name() string
}

// OutboxMailer writes each message as a JSON file inside a private directory
// (0700 dir, 0600 files). It is the default dev transport and the fixture
// source for Go tests and the `raft-server mailbox` subcommand.
type OutboxMailer struct {
	dir string
	mu  sync.Mutex
}

// NewOutboxMailer prepares (creating if needed) the private outbox directory.
func NewOutboxMailer(dir string) (*OutboxMailer, error) {
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return nil, fmt.Errorf("create outbox dir: %w", err)
	}
	info, err := os.Lstat(dir)
	if err != nil {
		return nil, err
	}
	if !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		return nil, fmt.Errorf("outbox must be a non-symlink directory")
	}
	if err := os.Chmod(dir, 0o700); err != nil {
		return nil, fmt.Errorf("restrict outbox directory: %w", err)
	}
	return &OutboxMailer{dir: dir}, nil
}

// Dir returns the outbox directory path.
func (o *OutboxMailer) Dir() string { return o.dir }

// Name implements Mailer.
func (*OutboxMailer) Name() string { return "outbox" }

// Send writes the message to a new outbox file. Token-bearing links live only
// in the file, never in process logs.
func (o *OutboxMailer) Send(ctx context.Context, msg Message) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	buf := make([]byte, 6)
	if _, err := rand.Read(buf); err != nil {
		return err
	}
	name := fmt.Sprintf("%s-%s.json", time.Now().UTC().Format("20060102T150405.000000000"), hexEncode(buf))
	payload := marshalMessage(msg)
	o.mu.Lock()
	defer o.mu.Unlock()
	if err := ctx.Err(); err != nil {
		return err
	}
	f, err := os.CreateTemp(o.dir, ".mail-*")
	if err != nil {
		return err
	}
	tmp := f.Name()
	defer os.Remove(tmp)
	if _, err := f.Write(payload); err != nil {
		f.Close()
		return err
	}
	if err := f.Close(); err != nil {
		return err
	}
	return os.Rename(tmp, filepath.Join(o.dir, name))
}

func marshalMessage(msg Message) []byte {
	var b strings.Builder
	b.WriteString("{\n")
	fmt.Fprintf(&b, "  \"from\": %s,\n", jsonString(msg.From))
	fmt.Fprintf(&b, "  \"to\": %s,\n", jsonString(msg.To))
	fmt.Fprintf(&b, "  \"subject\": %s,\n", jsonString(msg.Subject))
	fmt.Fprintf(&b, "  \"receivedAt\": %s,\n", jsonString(time.Now().UTC().Format(time.RFC3339Nano)))
	if msg.Kind != "" {
		fmt.Fprintf(&b, "  \"kind\": %s,\n", jsonString(msg.Kind))
	}
	if msg.Token != "" {
		fmt.Fprintf(&b, "  \"token\": %s,\n", jsonString(msg.Token))
	}
	fmt.Fprintf(&b, "  \"html\": %s", jsonString(msg.HTML))
	if msg.Text != "" {
		fmt.Fprintf(&b, ",\n  \"text\": %s", jsonString(msg.Text))
	}
	b.WriteString("\n}\n")
	return []byte(b.String())
}

func jsonString(s string) string {
	var b strings.Builder
	b.WriteByte('"')
	for _, r := range s {
		switch r {
		case '"':
			b.WriteString("\\\"")
		case '\\':
			b.WriteString("\\\\")
		case '\n':
			b.WriteString("\\n")
		case '\r':
			b.WriteString("\\r")
		case '\t':
			b.WriteString("\\t")
		default:
			if r < 0x20 {
				fmt.Fprintf(&b, "\\u%04x", r)
			} else {
				b.WriteRune(r)
			}
		}
	}
	b.WriteByte('"')
	return b.String()
}

func hexEncode(b []byte) string {
	const hexdigits = "0123456789abcdef"
	out := make([]byte, 0, len(b)*2)
	for _, v := range b {
		out = append(out, hexdigits[v>>4], hexdigits[v&0x0f])
	}
	return string(out)
}

// OutboxEntry is one parsed outbox message.
type OutboxEntry struct {
	File    string
	From    string
	To      string
	Subject string
	Kind    string
	Token   string
	HTML    string
	Text    string
}

// Links extracts http(s) URLs from the HTML body (href attributes), in order.
func (e OutboxEntry) Links() []string {
	links := make([]string, 0, 2)
	for _, part := range strings.Split(e.HTML, `href="`) {
		if len(part) == 0 || part == e.HTML {
			continue
		}
		if end := strings.IndexByte(part, '"'); end > 0 {
			candidate := part[:end]
			if strings.HasPrefix(candidate, "http://") || strings.HasPrefix(candidate, "https://") {
				links = append(links, candidate)
			}
		}
	}
	return links
}

// ReadOutbox lists outbox entries newest-first, optionally capped.
func ReadOutbox(dir string, limit int) ([]OutboxEntry, error) {
	entries, err := os.ReadDir(dir)
	if err != nil {
		if os.IsNotExist(err) {
			return nil, nil
		}
		return nil, err
	}
	names := make([]string, 0, len(entries))
	for _, e := range entries {
		if !e.IsDir() && strings.HasSuffix(e.Name(), ".json") {
			names = append(names, e.Name())
		}
	}
	sort.Sort(sort.Reverse(sort.StringSlice(names)))
	if limit > 0 && len(names) > limit {
		names = names[:limit]
	}
	out := make([]OutboxEntry, 0, len(names))
	for _, name := range names {
		data, err := os.ReadFile(filepath.Join(dir, name))
		if err != nil {
			continue
		}
		entry := OutboxEntry{File: name}
		// HTML contains escaped quotes. Parse the actual JSON contract instead
		// of stopping at the first quote inside an href attribute.
		if err := json.Unmarshal(data, &entry); err != nil {
			return nil, fmt.Errorf("decode outbox message %s: %w", name, err)
		}
		out = append(out, entry)
	}
	return out, nil
}

func extractJSONString(data []byte, key string) string {
	needle := "\n  \"" + key + "\": \""
	idx := strings.Index(string(data), needle)
	if idx < 0 {
		return ""
	}
	rest := string(data)[idx+len(needle):]
	end := strings.Index(rest, "\"")
	if end < 0 {
		return ""
	}
	value := rest[:end]
	// Unescape the escapes marshalMessage emits.
	value = strings.ReplaceAll(value, "\\n", "\n")
	value = strings.ReplaceAll(value, "\\r", "\r")
	value = strings.ReplaceAll(value, "\\t", "\t")
	value = strings.ReplaceAll(value, "\\\"", "\"")
	value = strings.ReplaceAll(value, "\\\\", "\\")
	return value
}

// SMTPMailer requires STARTTLS for remote submission and supports optional
// AUTH. Plaintext is restricted to loopback development SMTP sinks.
type SMTPMailer struct {
	host     string
	port     int
	username string
	password string
}

// NewSMTPMailer builds the production transport.
func NewSMTPMailer(host string, port int, username, password string) *SMTPMailer {
	return &SMTPMailer{host: host, port: port, username: username, password: password}
}

// Name implements Mailer.
func (*SMTPMailer) Name() string { return "smtp" }

// Send delivers msg. The whole submission honors ctx's cancellation.
func (m *SMTPMailer) Send(ctx context.Context, msg Message) error {
	addr := net.JoinHostPort(m.host, fmt.Sprintf("%d", m.port))
	dialer := &net.Dialer{Timeout: 10 * time.Second}
	conn, err := dialer.DialContext(ctx, "tcp", addr)
	if err != nil {
		return fmt.Errorf("smtp dial: %w", err)
	}
	deadline := time.Now().Add(10 * time.Second)
	if d, ok := ctx.Deadline(); ok && d.Before(deadline) {
		deadline = d
	}
	if err := conn.SetDeadline(deadline); err != nil {
		conn.Close()
		return err
	}
	stop := context.AfterFunc(ctx, func() { _ = conn.Close() })
	defer stop()
	client, err := smtp.NewClient(conn, m.host)
	if err != nil {
		conn.Close()
		return fmt.Errorf("smtp client: %w", err)
	}
	defer client.Close()
	if ok, _ := client.Extension("STARTTLS"); ok {
		if err := client.StartTLS(&tls.Config{ServerName: m.host, MinVersion: tls.VersionTLS12}); err != nil {
			return fmt.Errorf("smtp starttls: %w", err)
		}
	} else {
		// Plaintext is allowed only for a local development SMTP sink.
		ip := net.ParseIP(m.host)
		if m.host != "localhost" && (ip == nil || !ip.IsLoopback()) {
			return fmt.Errorf("remote SMTP server must support STARTTLS")
		}
	}
	if m.username != "" {
		if ok, mech := client.Extension("AUTH"); !ok || mech == "" {
			return fmt.Errorf("configured SMTP authentication is unavailable")
		}
		if err := client.Auth(smtp.PlainAuth("", m.username, m.password, m.host)); err != nil {
			return fmt.Errorf("smtp auth: %w", err)
		}
	}
	if err := client.Mail(addrSpec(msg.From)); err != nil {
		return fmt.Errorf("smtp mail: %w", err)
	}
	if err := client.Rcpt(msg.To); err != nil {
		return fmt.Errorf("smtp rcpt: %w", err)
	}
	w, err := client.Data()
	if err != nil {
		return fmt.Errorf("smtp data: %w", err)
	}
	if _, err := w.Write([]byte(msg.renderRFC5322())); err != nil {
		w.Close()
		return fmt.Errorf("smtp write: %w", err)
	}
	if err := w.Close(); err != nil {
		return fmt.Errorf("smtp close data: %w", err)
	}
	return client.Quit()
}

// addrSpec extracts the bare address from a "Name <addr>" header value.
func addrSpec(from string) string {
	if start := strings.LastIndexByte(from, '<'); start >= 0 {
		if end := strings.IndexByte(from[start:], '>'); end > 0 {
			return from[start+1 : start+end]
		}
	}
	return strings.TrimSpace(from)
}

func (m Message) renderRFC5322() string {
	var b strings.Builder
	fmt.Fprintf(&b, "From: %s\r\n", sanitizeHeader(m.From))
	fmt.Fprintf(&b, "To: %s\r\n", sanitizeHeader(m.To))
	fmt.Fprintf(&b, "Subject: %s\r\n", sanitizeHeader(m.Subject))
	fmt.Fprintf(&b, "Date: %s\r\n", time.Now().UTC().Format(time.RFC1123Z))
	fmt.Fprintf(&b, "MIME-Version: 1.0\r\n")
	if m.Text != "" {
		b.WriteString("Content-Type: multipart/alternative; boundary=raft-go-alt\r\n\r\n")
		b.WriteString("--raft-go-alt\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n")
		b.WriteString(m.Text)
		b.WriteString("\r\n--raft-go-alt\r\nContent-Type: text/html; charset=utf-8\r\n\r\n")
		b.WriteString(m.HTML)
		b.WriteString("\r\n--raft-go-alt--\r\n")
	} else {
		b.WriteString("Content-Type: text/html; charset=utf-8\r\n\r\n")
		b.WriteString(m.HTML)
	}
	return b.String()
}

func sanitizeHeader(v string) string {
	// Strip CR/LF to prevent header injection from user-controlled names.
	v = strings.ReplaceAll(v, "\r", " ")
	v = strings.ReplaceAll(v, "\n", " ")
	return v
}
