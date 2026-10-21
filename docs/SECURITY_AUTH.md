# Authentication security posture

Status of Resuto 2.0 sign-in, sessions and account controls on the **Supabase Free plan**, with **no custom SMTP
provider** and no paid services (owner decisions, 2026-10-21). Every line says where the control lives, whether the
server enforces it, and how it was verified. Workstream ws11 (AUTH-01..04) added the items marked *new*.

Related: `docs/OPEN_BLOCKERS.md` (B-14: dashboard settings and email), `docs/STAGING_DEPLOYMENT.md` (Auth section),
`docs/architecture/SECURITY_MODEL.md` (tenancy, RLS, roles).

## 1. Controls in place

| Control | Where | Enforced by the server? | Verified |
|---|---|---|---|
| Identity provider: Supabase Auth, email + password; Google only when `NEXT_PUBLIC_AUTH_GOOGLE=true` and the provider is enabled | `apps/web/lib/session.tsx` | Supabase Auth | Staging sign-in (B-12, 2026-10-19) |
| API token verification: asymmetric keys from the project JWKS, issuer `<SUPABASE_URL>/auth/v1`, audience, `role=authenticated`; anonymous sessions refused; HS256 only without `SUPABASE_URL` (local) or with `AUTH_ALLOW_HS256` | `apps/api/src/common/auth/jwt.service.ts` | API | `t:deployment-config.test.ts`, staging |
| Local development issuer (`/v1/auth/dev/*`) | `apps/api/src/modules/auth/auth.controller.ts` | API refuses to start with `AUTH_DEV_MODE` in staging / production | env validation tests |
| Sessions in the browser: supabase-js keeps the session in `localStorage` (`sb-<ref>-auth-token`) and refreshes it; one shared refresh then retry on a 401, otherwise sign-out to `/login?next=` (same-origin `next` only) | `apps/web/lib/session.tsx`, `lib/auth-recovery.ts`, `lib/safe-next.ts` | Supabase Auth (token expiry, refresh-token rotation) | web unit tests |
| Script injection, which could read the stored token: per-request nonce CSP, no inline script | `apps/web/lib/csp.ts`, `middleware.ts` | Browser (CSP) | `lib/csp.test.ts`, ws1 browser proof |
| Email-link flow: **implicit** (supabase-js default; `createClient` sets no `flowType`). `/auth/callback` also handles PKCE `?code=` links and explains a PKCE link opened in another browser | `apps/web/lib/session.tsx`, `lib/auth/links.ts` | Supabase Auth | `lib/auth/session-links.test.ts` |
| *New* password rules before every new password (sign-up, reset, change): 10-72 characters, very common passwords, not the email or its local part, not "Resuto", and the **Pwned Passwords** k-anonymity lookup (AUTH-01, section 3) | `apps/web/lib/auth/password-policy.ts` | **No** (client-side, compensating). Server floor: dashboard minimum length + character rules | `lib/auth/password-policy.test.ts`, `lib/auth/session-password.test.ts`, browser proof |
| *New* TOTP two-step verification, opt-in per user, code step at sign-in (AUTH-02, section 4) | `apps/web/lib/auth/mfa.ts`, `app/(auth)/account/security/MfaCard.tsx`, `app/(auth)/_ui/MfaStep.tsx` | Supabase Auth (aal2 only after a verified code) | `lib/auth/mfa.test.ts`, `lib/auth/session-mfa.test.ts`, browser proof |
| *New* aal2 step-up on sensitive API routes for users with a verified factor | `apps/api/src/common/auth/mfa.guard.ts` (`@RequireMfa()`) | **API** | `t:mfa-step-up.test.ts` |
| Current password required to change the password while signed in; a password may be set without it only right after a recovery link (15 min, same tab) | `apps/web/lib/session.tsx` (CR-05) | Browser only, unless the dashboard's **Secure password change** is on (Supabase then asks for a reauthentication nonce) | web unit tests |
| *New* email flows that finish and say what happened: confirmation pending + resend with cooldown, generic reset answer, secure email change, expired / used / other-browser links (AUTH-03, section 5) | `app/(auth)/*`, `lib/auth/links.ts` | Supabase Auth (link validity, rate limits) | `lib/auth/links.test.ts`, `lib/auth/session-links.test.ts`, browser proof; **real email delivery unverified** |
| Invitations: Resuto's own single-use tokens (only the hash is stored, 7-day expiry, bound to the invited email); the inviter gets a copyable link, Resuto sends no invitation email | `apps/api/src/modules/platform/organizations.service.ts`, `web:dashboard/[orgId]/team` | API | `t:platform.test.ts` |
| Rate limits: Supabase Auth's own (sign-in, token refresh, verify, email sending; Free-plan defaults); the dev issuer limits per email; MCP keys per client | Supabase dashboard, `common/http/rate-limiter.ts` | Supabase / API | defaults not changed |
| Data access: the browser never queries tables (no Data API, no Realtime); `anon` / `authenticated` hold no table privilege; the API runs every tenant query in a membership- or tenant-scoped RLS context | `supabase/migrations`, `apps/api/src/common/db` | Postgres RLS + API | `supabase/tests/*.test.mjs` |
| Roles and permissions: role matrix per route, branch scope, escalation guard on invitations and role changes | `apps/api/src/common/auth/access.guard.ts`, `packages/contracts/src/permissions.ts` | API | `t:platform.test.ts` and module suites |
| CAPTCHA | not enabled | — | optional (section 6) |

## 2. Supabase Free plan: what is and is not available

- **Leaked-password protection** (HaveIBeenPwned check inside Supabase Auth) is a paid-plan feature: **unavailable**.
  Compensated by the client-side check in section 3, which is weaker (see its limits).
- **MFA (TOTP)** is available on every plan: used (section 4). Phone MFA is paid and not used.
- **Email**: without custom SMTP, Supabase's built-in sender delivers **only to the project team's addresses** and a
  few messages per hour (the exact limit is shown under Authentication → Rate Limits and cannot be raised without
  custom SMTP). So sign-up confirmation, password reset and email change are **unverified for real customers** until
  an SMTP provider is configured (B-14). The web says so on every screen that waits for an email when the build sets
  `NEXT_PUBLIC_AUTH_EMAIL_DELIVERY=limited`.
- Everything else used here (password sign-in, JWKS / asymmetric keys, refresh-token rotation, secure email change,
  secure password change, minimum password length and character rules, redirect allow list, rate-limit settings)
  is available on Free.

### Recommended dashboard settings (owner, Supabase → Authentication; all free)

| Setting | Value | Why |
|---|---|---|
| Email provider → **Confirm email** | **ON** | Never disable it to make a flow "work": an unconfirmed account cannot sign in, and the web shows the pending state with resend. |
| Email provider → **Secure email change** | ON | A change needs a link opened from the current and the new address; `/auth/callback` reports the first half. |
| Email provider → **Secure password change** | ON | The server asks for a recent sign-in (reauthentication) before a password change; Resuto's current-password check is browser-only. |
| Password requirements → **Minimum length** | **10** | The server-side floor that matches the web's rule (the web also refuses more than 72, Supabase's limit). |
| Password requirements → **Required characters** | lower + upper case letters and digits (symbols optional) | The only server-side strength rule on Free; the web maps the `characters` refusal to a clear message. |
| Multi-factor → **TOTP (app authenticator)** | enrol and verify **enabled** | Needed for section 4. |
| Rate limits | defaults, or lower | Do not raise. |
| CAPTCHA | off, unless the owner wants it (free hCaptcha / Cloudflare Turnstile) | Needs a widget in the sign-up / sign-in / reset forms before it is switched on; not built. |
| Leaked password protection | unavailable on Free | Compensated client-side (section 3). |

## 3. Breached and weak passwords (AUTH-01) — compensating, client-side

Before Resuto calls Supabase with a new password (sign-up, `/reset-password`, Account → Security):

1. Length 10-72, not one of a small built-in list of very common passwords (and base words such as "password",
   "qwerty", "restaurant", "welcome" padded with digits or symbols), not two or fewer distinct characters, not
   containing the account's email or its part before `@` (4+ characters), not containing "Resuto" / "ريسوتو".
2. **Pwned Passwords range API** (free, no key): the browser hashes the password with SHA-1 and sends **only the first
   5 hex characters** to `https://api.pwnedpasswords.com/range/<prefix>` with `Add-Padding: true`; the response lists
   every known suffix for that prefix (plus padding rows with count 0) and the match is done locally. A password seen
   in a breach is refused with a localized message. Padding rows never count.
3. If the service cannot be reached within 4 s, answers an error or something unexpected, the password is **not
   blocked**; the browser logs `breached-password check unavailable` (never the password or its hash). An outage of a
   third-party service must not stop staff from setting a password.

CSP: `connect-src` allows `https://api.pwnedpasswords.com` on every document. It is not limited to the auth pages
because Account → Security is reached by client-side navigation from any staff page and a document keeps the policy it
was loaded with; a path-scoped entry would silently disable the check there.

**Limits (honest):** this runs in the browser, so anyone calling Supabase Auth directly with the public anon key
skips it. It is **not equivalent** to Supabase's server-side leaked-password protection. The server-side floor is the
dashboard's minimum length + required characters (section 2).

## 4. Two-step verification (AUTH-02)

- **Enrol**: Account → Security → Two-step verification → "Set up an authenticator app": a QR code and the setup key
  (grouped by 4), confirmed with the first 6-digit code (Arabic-Indic digits are accepted and normalised). The
  session becomes aal2. Several authenticators can be added; abandoned enrolments are removed before a new one.
- **Remove**: requires a current code from that authenticator first, then the factor is deleted and the session
  refreshed.
- **Sign-in**: when the account has a verified factor, the password (or an email link) gives an aal1 session that the
  web **holds back** (no token is given to the app, nothing loads) and shows the code step. The same happens for a
  stored aal1 session (a tab reopened mid-sign-in).
- **API step-up** (`@RequireMfa()`): for a user with a verified factor in `auth.mfa_factors`, an aal1 token gets
  `403 mfa_required` (standard error envelope with `details.requiredAal = "aal2"` and the request id) on:
  every platform-admin route (`/v1/admin/**`, enforced for all `@PlatformAdmin` routes by a metadata test), integration
  and payment-provider credentials (create / update connection, OAuth start / complete, account selection), MCP client
  keys (create / update) and MCP OAuth grant approval, and role grants (invitations, member role changes). The web
  turns that answer into the code step (also when this tab's user object did not yet list a factor added elsewhere).
  Users **without** a verified factor, including the demo accounts, are not affected. The guard runs after access
  control, so it never reveals a tenant or overrides a permission refusal.
- **Everyday routes accept aal1.** Residual risk: someone with an enrolled user's password could call those API routes
  directly with a password-only token, skipping the web's code step; the sensitive routes above still refuse. Extending
  the step-up to every route for enrolled users is a follow-up (one query per aal1 request).
- **Fail-closed**: with `SUPABASE_URL` configured, a missing `auth.mfa_factors` table answers
  `503 mfa_check_unavailable` instead of skipping the check. Without Supabase (local dev issuer, which has no MFA)
  the check passes. The API reads `auth.mfa_factors` in the platform database context, like other `auth.*` reads; a
  future least-privilege runtime role needs `select` on it (or a definer function).
- **Lost authenticator**: Supabase TOTP has no recovery codes. Users should add a second authenticator. The owner (or
  Resuto support) removes a user's factor in Supabase → Authentication → Users → the user → MFA factors, after
  verifying the person out of band; the user then signs in with the password and enrols again.
- Local development (dev issuer) has no MFA; Account → Security says so.

## 5. Email-dependent flows (AUTH-03) — complete, unverified until SMTP

| Flow | What the user sees | Server | Real delivery |
|---|---|---|---|
| Sign-up | "Check your email" with the address; account inactive until the link is opened; "send again" after a visible 60 s cooldown (restarts from Supabase's "after N seconds" answer); the link returns to `next` (e.g. the invitation) | Supabase: confirm email ON, never auto-confirmed | **Unverified** (team addresses only) |
| Sign-in before confirming | "Confirm your email first" + resend | Supabase refuses `email_not_confirmed` | Unverified |
| Password reset | Same answer for every address ("If an account exists for …"), resend with cooldown | Supabase answers alike for unknown addresses | **Unverified** |
| Email change | Confirmation requested; with secure email change both addresses get a link; the callback reports the first half and the completed change; resend | Supabase | **Unverified** |
| Expired / used link | "This link has expired" + the way to a new one for that flow (new confirmation email, new reset link, email change again) | Supabase `otp_expired` | Covered by tests and browser proof with a simulated link |
| PKCE link opened in another browser | "Open it in the same browser … if confirming, try signing in" | — | tests |
| Invitations | Copyable link for the inviter ("Share this link"); **no email is sent** by Resuto | Resuto tokens | n/a (link shared manually) |
| Local dev issuer | No email at all: reset and resend say so; accounts are active at once | API dev routes only | n/a |

Tests use fake transports (mocked supabase-js, a scripted Supabase Auth in the browser proof); no mail server and no
staging Supabase Auth are used for testing.

## 6. Redirect URLs (Site URL and allow list)

How Supabase Auth validates `redirectTo` / `emailRedirectTo` (source: `supabase/auth`,
`internal/utilities/request.go`, `IsRedirectURLValid` and `GetReferrer`, checked 2026-10-21):

1. A redirect whose **scheme, host and port equal the Site URL's** is accepted **before** the allow list is consulted
   (the port check is skipped for loopback hosts).
2. Otherwise loopback IP addresses are accepted, and other hosts must match an **allow-list glob** applied to the whole
   URL **including the query string** (only the `#fragment` is cut). `*` stops at `.` and `/`; use `**` for paths and
   query strings.
3. An invalid redirect is **not an error**: Supabase silently falls back to the `Referer` header (if valid) or the
   Site URL, so a missing entry shows up as "the link opened the landing page", not as a failure.

The web sends every email link to `<origin>/auth/callback?next=<path>` (and Google to `<origin>/login?next=<path>`).

- **Staging** (`https://resuto-2-staging-web.vercel.app`): it is the Site URL, so **no extra redirect entry or
  wildcard is needed**; the identical entry the owner added is harmless.
- Entries that **would** be needed (each `https://<host>/**`):
  - another web origin (a second Vercel project, a preview URL such as `https://<project>-<hash>-<team>.vercel.app/**`),
  - a custom or production domain (e.g. `https://app.<domain>/**`) unless it becomes the Site URL,
  - `http://localhost:3000/**` for a local web app against a Supabase project (127.0.0.1 is accepted as loopback),
  - Google sign-in: in Google Cloud Console the OAuth client's authorized redirect URI is
    `https://<project-ref>.supabase.co/auth/v1/callback` (not a Resuto URL); Resuto's `redirectTo`
    (`<origin>/login?next=…`) then follows rules 1-2.
- Never add a bare `**` or `https://**`: that lets a link send the session to any site.

## 7. Verification status and what is left

- Verified locally: unit tests (web), API integration tests (`apps/api/test/mfa-step-up.test.ts`), browser proof
  against a local production build with a scripted Supabase Auth (screenshots in the ws11 evidence folder).
- **Not verified**: real email delivery (needs SMTP, B-14); TOTP against the real staging Supabase Auth (needs the
  owner to enrol a factor on staging; the flows use only documented supabase-js calls); dashboard settings in section 2
  (owner action).
- Follow-ups: step-up on every route for enrolled users; CAPTCHA if abuse appears; switch email links to PKCE only
  together with "open the link in the same browser" guidance; grant the future least-privilege API role read access to
  `auth.mfa_factors`.
