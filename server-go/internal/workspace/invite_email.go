// Invitation email rendering. Mirrors the frozen TS template
// (packages/server/src/services/emailService.ts renderInviteEmailHtml):
// inviter and workspace names are attacker-controllable and land in HTML
// text context, so both are escaped per-value. The token appears only in
// the message handed to the sender — never in logs.
package workspace

import (
	"fmt"
	"html"
	"strings"
)

const (
	inviteEmailInk   = "#141111"
	inviteEmailPink  = "#FE7DA8"
	inviteEmailMuted = "#6B6B6B"
	inviteBodyBg     = "#FFFAEF"
	inviteCardBg     = "#FFFFFF"
)

// InviteEmailSubject mirrors the TS subject line.
func InviteEmailSubject(inviterName, serverName string) string {
	return fmt.Sprintf("%s invited you to %s — Raft", inviterName, serverName)
}

// RenderInviteEmailHTML renders the one-time invite email. url is the
// already-built absolute accept link.
func RenderInviteEmailHTML(inviterName, serverName, url string) string {
	inviter := html.EscapeString(inviterName)
	if inviter == "" {
		inviter = "Someone"
	}
	server := html.EscapeString(serverName)
	inner := fmt.Sprintf(`
  <h1 style="margin:0 0 16px 0;color:%s;font-size:22px;font-weight:bold;">You're invited!</h1>
  <p style="margin:0 0 8px 0;color:%s;font-size:15px;line-height:1.5;"><strong>%s</strong> invited you to join <strong>%s</strong> on Raft.</p>
  <p style="margin:0;color:%s;font-size:15px;line-height:1.5;">Raft is where humans and AI agents collaborate in real-time.</p>
  %s
  <p style="margin:0 0 4px 0;color:%s;font-size:13px;line-height:1.5;">Or copy this link: <a href="%s" style="color:%s;word-break:break-all;">%s</a></p>
  <p style="margin:0;color:%s;font-size:13px;">This invite expires in 7 days.</p>`,
		inviteEmailInk, inviteEmailInk, inviter, server, inviteEmailInk,
		inviteEmailButton(url, "Accept Invite"),
		inviteEmailMuted, html.EscapeString(url), inviteEmailPink, html.EscapeString(url), inviteEmailMuted)
	return fmt.Sprintf(`<!DOCTYPE html><html><body style="margin:0;padding:0;background:%s;"><table role="presentation" width="100%%" cellpadding="0" cellspacing="0" style="background:%s;padding:32px 16px;"><tr><td align="center"><table role="presentation" width="560" cellpadding="0" cellspacing="0" style="max-width:560px;background:%s;border-radius:16px;padding:32px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">%s</table></td></tr></table></body></html>`,
		inviteBodyBg, inviteBodyBg, inviteCardBg, strings.TrimSpace(inner))
}

func inviteEmailButton(url, label string) string {
	return fmt.Sprintf(`<table role="presentation" cellpadding="0" cellspacing="0" style="margin:20px 0;"><tr><td style="background:%s;border-radius:10px;"><a href="%s" style="display:inline-block;padding:12px 28px;color:%s;font-weight:bold;text-decoration:none;font-size:15px;">%s</a></td></tr></table>`,
		inviteEmailPink, html.EscapeString(url), inviteEmailInk, label)
}
