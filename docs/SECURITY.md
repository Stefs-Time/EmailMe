# Security & POPIA

## Controls implemented

| Area | Control |
|---|---|
| Transport | HTTPS through Railway or Caddy (Let's Encrypt); HSTS in production; `upgrade-insecure-requests`. SMTP requires TLS before authentication by default (`SMTP_REQUIRE_TLS`), with TLS 1.2 minimum |
| First run | The setup screen needs a one-time code printed only in the server log, so whoever finds the URL first cannot claim the installation |
| Authentication | **Argon2id** password hashes; minimum 12 characters including letters and a number; uniform response for unknown users |
| Brute force | 20 login attempts / 15 min per IP; account locked for 15 min after 10 failures; setup and test endpoints rate-limited |
| Sessions | Server-side (PostgreSQL); cookies are `HttpOnly`, `SameSite=Lax`, and `Secure` in production; the session is regenerated at login; 8 h rolling expiry; invalidated when the password changes or the user is disabled |
| CSRF | Per-session synchronizer token, required in `X-CSRF-Token` on every state-changing API request and compared in constant time. Public recipient forms (unsubscribe, confirm) need no session and only act on the unguessable message token |
| Authorisation | Server-side permission check on every route; roles viewer / manager / admin; the last active admin cannot be removed |
| Input | zod validation of bodies, queries and parameters; size limits (JSON 1 MB, CSV 25 MB / 100k rows by default) |
| SQL | Parameterised queries only; sort columns whitelisted; `LIKE` wildcards escaped |
| Email content | Campaign and template HTML sanitised on save (sanitize-html allowlist: no scripts, event handlers or `javascript:` URLs); personalisation values HTML-escaped; tags are lookups only, with no expression language (no template injection) |
| Previews | Rendered email previews and "view in browser" pages are served with a sandbox CSP (no scripts, no same-origin) |
| Links | Click tracking redirects only to URLs stored for that campaign (no open redirect). Recipient tokens are random UUIDs |
| Webhook | Secret token in the URL or the `X-Webhook-Token` header, constant-time comparison; can be rotated in Settings |
| Output | Auto-escaping HTML in the SPA; strict CSP (`script-src 'self'`, no inline script or style); `frame-ancestors 'none'` |
| Exports | CSV formula-injection protection; `Cache-Control: no-store`; every export audited; viewers cannot export |
| Secrets | Infrastructure secrets only in environment variables, validated at startup and redacted from logs. The session secret and encryption key are generated per installation (`portal.app_secrets`). The bounce-mailbox password is encrypted at rest with **AES-256-GCM** and never returned by the API |
| Errors | Generic messages to clients; details only in server logs |
| Network (self-hosted) | Only ports 80/443 public; PostgreSQL on an internal Docker network |
| Audit | Logins and failures, settings changes, contact/list changes, imports, exports, campaign sends/pauses/cancels, suppressions, reactivations, erasures, user changes |
| Dependencies | Lockfile; `npm audit --omit=dev` reported 0 vulnerabilities at build time (Nov 2026). Quill was deliberately not used because of an open XSS advisory; the editor is a small in-house component |

## Recommendations for operators

- Use a strong `ADMIN_PASSWORD`, or none: the setup-code flow avoids keeping a password in variables at all.
- Restrict who has the **admin** role. Give most staff **manager** or **viewer**.
- Use a **dedicated** bounce mailbox with an app-specific password, not a person's mailbox.
- Rotate the webhook token if it may have leaked (Settings → Bounces).
- Run `npm audit` and update dependencies monthly. Redeploy to pick up base-image security updates.
- Keep backups encrypted (bucket encryption) and access-restricted. They contain personal data and the generated secrets.
- On self-hosted servers: SSH keys only, unattended security upgrades, and a firewall allowing only 22/80/443.

## POPIA support (scope §5)

| Requirement | How MailHarbor supports it |
|---|---|
| Store consent date and source | Consent record per contact (method, purpose, date, source, evidence, recorded by) |
| How and why permission was obtained | `method`, `purpose` and `evidence` fields; required on manual add and import |
| Double opt-in | Double opt-in lists with a confirmation email; a GET never confirms (link scanners), the person clicks *Confirm* |
| Unsubscribe in every email | Unsubscribe link (footer added automatically if a template lacks it) and RFC 8058 one-click headers |
| Identify the sender | Organisation name and postal address in every footer; sending is blocked until they are set |
| Suppression record | Permanent `portal.suppressions` register, checked at campaign start and again before every send |
| No re-import of suppressed contacts | Import preview and commit exclude suppressed addresses |
| Export consent and unsubscribe history | Exports → *Consent & unsubscribe history* |
| Restrict access | Roles; viewers cannot export personal data; audit log |
| Access requests | Contact → *Data export* (JSON of everything held, including emails sent and events) |
| Remove / anonymise | Erase: deletes the contact and personal rows, keeps only a SHA-256 hash on the suppression list |
| Possession ≠ consent | Imports reject rows with no consent basis; UI wording reinforces this |

MailHarbor supports compliance but does not by itself make an organisation compliant. Your information officer should
review:
- marketing practices;
- the use of the existing-customer exception (s69(3));
- retention periods;
- the privacy notice.

Open and click tracking processes personal information about behaviour. Mention it in the privacy notice, or switch it
off in Settings → Sending.
