# Legacy Web account entry

> Backend closeout note: this document retains the earlier browser acceptance plan, not a current UI pass. The user assigned Web UI to another collaborator. The backend now implements and HTTP-tests avatar upload as well as the account flow; browser interaction is not verified in this closeout. See `../../docs/backend-handoff.md` for current backend scope, results and integration notes.

Inventory of what the current unmodified Web client does from sign-up through the empty workspace create form. Line numbers move; the field names below were read from the client and the TypeScript reference routes. This file does not prove the Go server. `server-go/tests/e2e/run.mjs` runs the browser.

Phase boundary: stop on the real first-server form (`#server-create-name`). Do not treat `POST /api/servers` or `POST /api/auth/me/avatar` as accepted. A default avatar is the lavender placeholder / Gravatar image; custom upload is not part of this pass.

## Pages and selectors

English copy, `en` catalog.

| Step | How the client gets there | Stable selectors |
| --- | --- | --- |
| Sign in | `/` with no session | heading "Sign In"; `#login-email`; `#login-password`; button "Sign In"; button "Forgot password?" |
| Register | button "Create one" | heading "Create your account"; `#register-email`; `#register-password`; label "I agree to the Terms of Service"; button "Continue" (disabled until the checkbox) |
| Check email | `emailVerified === false` | heading "Check your email"; the account email text |
| Verify | `/?verify=<token>` on the Web origin, then "Continue to Raft" reloads | heading "Email verified" |
| Identity | verified user whose `name` is empty or `pending_` | heading "Set up your account"; `#identity-handle`; `#identity-display-name`; "A default is picked for you."; `[data-testid=identity-profile-avatar]` |
| Create server | `GET /api/servers` is `[]` | "Create your first server"; heading "Name the server where your agents will work."; `#server-create-name`; `#server-create-slug`; `[data-testid=onboarding-session-footer]` button "Log out" |
| Reset request | signed out, "Forgot password?" | heading "Reset Password"; the email input in that form; button "Send Reset Link" |
| Reset | `/?reset=<token>` while signed out | heading "Set New Password"; two password inputs; button "Reset Password"; success heading "Password reset" |

Verification and reset links in the reference mailer are `{webOrigin}?verify=` and `{webOrigin}?reset=`. The origin is the Vite origin, not the API port.

## Requests the browser actually sends

Authenticated calls send `Authorization: Bearer <access token>` from `localStorage.slock_access_token`. Refresh may send `X-Slock-Auth-Refresh-Attempt-Id`. `X-Server-Id` stays absent until a workspace is current. No extra auth header is required.

| Call | Body / query the client sends | Response the client reads |
| --- | --- | --- |
| `GET /api/auth/providers` | — | `{ providers: [] }` for this phase. Unknown shapes become no social buttons. |
| `POST /api/auth/register` | `email`, `password`, `acceptTerms: true`, `termsVersion`, `privacyVersion`, `legalAcceptanceSource: "signup"`. No `name`. Current versions are `2026-05-12`. | `{ user, accessToken, refreshToken }`. `accessToken` is a JWT with `sub` and `type: "access"`. |
| `POST /api/auth/login` | `email`, `password` | Same session object. Wrong password is HTTP 401 with `code: "AUTH_INVALID_CREDENTIALS"` (the page then shows "Incorrect email or password."). |
| `POST /api/auth/verify-email` | `{ token }` | Success, then `GET /api/auth/me`. |
| `GET /api/auth/me` | — | The user object itself, not `{ user }`. |
| `GET /api/auth/me/username-available?name=` | query `name` | `{ available: boolean, message?: string }`. Blur only; submit still checks. |
| `POST /api/auth/me/complete-profile` | `{ name, displayName }` (`name` is the handle) | The user object. `name` must no longer be a `pending_` handle. |
| `GET /api/servers` | — | A JSON array. No memberships is `[]`, not `{ servers: [] }`. A failed call also leaves the client on the create form, so the status has to be observed. |
| `POST /api/auth/refresh` | `{ refreshToken }` | `{ accessToken, refreshToken }`. |
| `POST /api/auth/logout` | `{ refreshToken }` | The client clears local tokens even if the call fails. The server still has to revoke the session. |
| `POST /api/auth/forgot-password` | `{ email }` | `{ ok: true }` without saying whether the mailbox exists. |
| `POST /api/auth/reset-password` | `{ token, password }` | `{ ok: true }` on success. |

`user` fields the pages read: `id`, `email`, `name`, `displayName`, `emailVerified`, `avatarUrl`, `gravatarHash`, `profileSetupCompletedAt`, `profileSetupSuggestedHandle`, `profileSetupProvider`. Nullable fields should be `null`. The identity gate uses a placeholder `name` (`pending_` or empty), not a missing `profileSetupCompletedAt`. Omit `firstObservedTimezone` to skip the optional timezone call; including it makes the client `POST /api/auth/me/timezone-observation` and ignore failure.

Startup may also `GET /api/deployment-info`. That call is not an account-entry success. Do not answer unknown `/api` writes with an empty 200.

## Local mailbox

The browser test reads a verification or reset token only from the private mailbox directory declared by the Go process (env names are read from the server source at launch). It then opens `?verify=` or `?reset=` on the Vite origin. A message may be an `.eml` / text body containing that URL, or JSON with `kind` (`verify` or `reset`) and `token`. Tokens stay out of the test log.
