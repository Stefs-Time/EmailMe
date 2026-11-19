# Security & POPIA

MailHarbor is a hosted service. This page describes how your organisation's MailHarbor protects your data and helps you
meet POPIA.

## Controls implemented

| Area | Control |
|---|---|
| Isolation | **Dedicated instance and database per customer.** No database, application process, secret, backup or web address is shared with other customers |
| Hosting | Run, monitored and updated by MailHarbor; security updates applied regularly; daily database backups to encrypted off-site storage, with restricted access |
| Transport | HTTPS only (TLS certificates managed automatically); HSTS; `upgrade-insecure-requests`. The connection to your mail server requires TLS before authentication, with TLS 1.2 minimum |
| First run | The setup screen needs a one-time code that MailHarbor sends you separately, so whoever finds the address first cannot claim your service |
| Authentication | **Argon2id** password hashes; minimum 12 characters including letters and a number; uniform response for unknown users |
| Brute force | 20 login attempts / 15 min per IP; account locked for 15 min after 10 failures; setup and test endpoints rate-limited |
| Sessions | Server-side (PostgreSQL); cookies are `HttpOnly`, `SameSite=Lax`, and `Secure` in production; the session is regenerated at login; 8 h rolling expiry; invalidated when the password changes or the user is disabled |
| CSRF | Per-session synchronizer token, required in `X-CSRF-Token` on every state-changing API request and compared in constant time. Public recipient forms (unsubscribe, confirm) need no session and only act on the unguessable message token |
| Authorisation | Server-side permission check on every route; roles viewer / manager / admin; the last active admin cannot be removed |
| Input | zod validation of bodies, queries and parameters; size limits (JSON 1 MB, CSV 25 MB / 100k rows by default) |
| Image uploads | Type allow-list; 15 MB upload limit, 50-megapixel decode limit (decompression bombs); re-encoded by sharp (no original bytes kept); EXIF/GPS metadata stripped; served with `nosniff` and `default-src 'none'` CSP. sharp ≥ 0.35.5 (fixes CVEs in its bundled libvips/libheif/librsvg) |
| Segments | Rules validated against a fixed field/operator catalogue; compiled SQL contains only bound parameters (an injection attempt is matched as plain text) |
| Sign-up forms | Honeypot, HMAC-signed render time (submissions under 2.5 s or without a token discarded), 20 POSTs per 10 min per IP; identical response for new, existing and suppressed addresses (no enumeration); suppressed addresses never re-subscribed; consent evidence recorded; only form pages may be framed (`frame-ancestors *`), with a nonce-based CSP |
| SQL | Parameterised queries only; sort columns whitelisted; `LIKE` wildcards escaped |
| Email content | Campaign content validated and rendered on the server, and sanitised (sanitize-html allowlist: no scripts, event handlers or `javascript:` URLs); personalisation values HTML-escaped; tags are lookups only, with no expression language (no template injection) |
| Previews | Rendered email previews and "view in browser" pages are served with a sandbox CSP (no scripts, no same-origin) |
| Links | Click tracking redirects only to URLs stored for that campaign (no open redirect). Recipient tokens are random UUIDs |
| Webhook | Secret token in the URL or the `X-Webhook-Token` header, constant-time comparison; can be rotated in Settings |
| Output | Auto-escaping HTML in the SPA; strict CSP (`script-src 'self'`, no inline script or style); `frame-ancestors 'none'` |
| Exports | CSV formula-injection protection; `Cache-Control: no-store`; every export audited; viewers cannot export |
| Secrets | Your mail server password is held in MailHarbor's secured hosting configuration, never in the database, the app or logs. The session secret and encryption key are generated separately for each customer's service. The bounce-mailbox password is encrypted at rest with **AES-256-GCM** and never returned by the API |
| Errors | Generic messages to users; details only in MailHarbor's internal logs, which exclude passwords, cookies and tokens |
| Network | Only HTTPS is public; the database is reachable only from your MailHarbor instance |
| Support access | MailHarbor's support and recovery account (marked *Managed by MailHarbor*) is used only to restore access or at your request; every action appears in your audit log |
| Audit | Logins and failures, settings changes, contact/list changes, imports, exports, campaign sends/pauses/cancels, suppressions, reactivations, erasures, user changes |
| Dependencies | Lockfile; `npm audit --omit=dev` reported 0 vulnerabilities at build time (Nov 2026). Quill was deliberately not used because of an open XSS advisory; the editor is a small in-house component |

## Your responsibilities

- Give each person their own account. Restrict the **admin** role and give most staff **manager** or **viewer**.
- Remove accounts when people leave (Users → Edit → disable).
- Use a **dedicated** bounce mailbox with an app-specific password, not a person's mailbox.
- Rotate the webhook token if it may have leaked (Settings → Bounces).
- Keep your mail server credentials private, and tell MailHarbor support if they change or may have leaked.
- Treat exports as personal information: store them securely and delete them when no longer needed.

## POPIA support (scope §5)

| Requirement | How MailHarbor supports it |
|---|---|
| Store consent date and source | Consent record per contact (method, purpose, date, source, evidence, recorded by) |
| How and why permission was obtained | `method`, `purpose` and `evidence` fields; required on manual add and import |
| Double opt-in | Double opt-in lists with a confirmation email; a GET never confirms (link scanners), the person clicks *Confirm* |
| Unsubscribe in every email | Every email's footer has the unsubscribe link (one is added if it would ever be missing) and RFC 8058 one-click headers |
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
