// Email rendering for verification and password reset. Tokens appear only in
// the message body handed to the mailer — never in logs.
package auth

import (
	"context"
	"fmt"
	"html"
	"strings"
)

const (
	emailInk    = "#141111"
	emailPink   = "#FE7DA8"
	emailMuted  = "#6B6B6B"
	emailBodyBg = "#FFFAEF"
	emailCardBg = "#FFFFFF"
)

// EmailLinkBuilder returns the absolutely-positioned verification/reset URLs.
type EmailLinkBuilder func(kind, token string) string

// SendVerificationEmail delivers the 24h verification link.
func SendVerificationEmail(ctx context.Context, send Sender, to, displayName, token string, linkFor EmailLinkBuilder) error {
	url := linkFor("verify", token)
	name := html.EscapeString(displayName)
	if name == "" {
		name = "there"
	}
	subject := "Verify your email — Raft"
	body := renderEmailLayout(fmt.Sprintf(`
  <h1 style="margin:0 0 16px 0;color:%s;font-size:22px;font-weight:bold;">Verify your email</h1>
  <p style="margin:0 0 8px 0;color:%s;font-size:15px;line-height:1.5;">Hey %s,</p>
  <p style="margin:0;color:%s;font-size:15px;line-height:1.5;">Click the button below to verify your email address:</p>
  %s
  <p style="margin:0 0 4px 0;color:%s;font-size:13px;line-height:1.5;">Or copy this link: <a href="%s" style="color:%s;word-break:break-all;">%s</a></p>
  <p style="margin:0 0 4px 0;color:%s;font-size:13px;">This link expires in 24 hours.</p>
  <p style="margin:0;color:%s;font-size:13px;line-height:1.5;">If you didn't create a Raft account, you can safely ignore this email.</p>`,
		emailInk, emailInk, name, emailInk, emailButton(url, "Verify Email"),
		emailMuted, url, emailPink, url, emailMuted, emailMuted))
	return send(ctx, to, subject, body, "verify", token)
}

// SendPasswordResetEmail delivers the 1h reset link.
func SendPasswordResetEmail(ctx context.Context, send Sender, to, displayName, token string, linkFor EmailLinkBuilder) error {
	url := linkFor("reset", token)
	name := html.EscapeString(displayName)
	if name == "" {
		name = "there"
	}
	subject := "Reset your password — Raft"
	body := renderEmailLayout(fmt.Sprintf(`
  <h1 style="margin:0 0 16px 0;color:%s;font-size:22px;font-weight:bold;">Reset your password</h1>
  <p style="margin:0 0 8px 0;color:%s;font-size:15px;line-height:1.5;">Hey %s,</p>
  <p style="margin:0;color:%s;font-size:15px;line-height:1.5;">Someone requested a password reset for your account. Click the button below to set a new password:</p>
  %s
  <p style="margin:0 0 4px 0;color:%s;font-size:13px;line-height:1.5;">Or copy this link: <a href="%s" style="color:%s;word-break:break-all;">%s</a></p>
  <p style="margin:0 0 4px 0;color:%s;font-size:13px;">This link expires in 1 hour. If you didn't request this, you can safely ignore this email.</p>`,
		emailInk, emailInk, name, emailInk, emailButton(url, "Reset Password"),
		emailMuted, url, emailPink, url, emailMuted))
	return send(ctx, to, subject, body, "reset", token)
}

// Sender abstracts delivery for the templates (implemented by Service using
// the configured Mailer + From address). kind/token ride along for the
// outbox's machine-readable fields.
type Sender func(ctx context.Context, to, subject, htmlBody, kind, token string) error

func emailButton(url, label string) string {
	return fmt.Sprintf(`<table role="presentation" cellpadding="0" cellspacing="0" style="margin:20px 0;"><tr><td style="background:%s;border-radius:10px;"><a href="%s" style="display:inline-block;padding:12px 28px;color:%s;font-weight:bold;text-decoration:none;font-size:15px;">%s</a></td></tr></table>`, emailPink, url, emailInk, label)
}

func renderEmailLayout(inner string) string {
	return fmt.Sprintf(`<!DOCTYPE html><html><body style="margin:0;padding:0;background:%s;"><table role="presentation" width="100%%" cellpadding="0" cellspacing="0" style="background:%s;padding:32px 16px;"><tr><td align="center"><table role="presentation" width="560" cellpadding="0" cellspacing="0" style="max-width:560px;background:%s;border-radius:16px;padding:32px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">%s</table></td></tr></table></body></html>`, emailBodyBg, emailBodyBg, emailCardBg, strings.TrimSpace(inner))
}
