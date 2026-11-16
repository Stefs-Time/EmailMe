# Security & POPIA

## Controls implemented

| Area | Control |
|---|---|
| Transport | HTTPS via Caddy (Let's Encrypt) or Railway; HSTS in production; `upgrade-insecure-requests` |
| Authentication | Portal accounts with **Argon2id** hashes; minimum 12 characters including letters and a number; uniform response timing for unknown users |
| Brute force | 20 login attempts / 15 min per IP; account lock for 15 min after 10 failures |
| Sessions | Server-side (PostgreSQL), `HttpOnly`, `SameSite=Lax`, `Secure` in production, regenerated at login, 8 h rolling expiry, invalidated when a password changes or the user is disabled |
| CSRF | Per-session synchronizer token, required in `X-CSRF-Token` on every state-changing request, compared in constant time |
| Authorisation | Server-side permission checks on every route; roles viewer / manager / admin; last active admin cannot be removed |
| Input | zod validation of bodies, queries and parameters; size limits (JSON 1 MB, CSV 25 MB / 100k rows); CSV type checks |
| SQL | Parameterised queries only; sort columns whitelisted; LIKE wildcards escaped |
| Database privilege | `mailharbor` role: owns `portal` schema, **SELECT only** on listmonk tables; reads in `READ ONLY` transactions |
| listmonk API | Dedicated API user with a least-privilege role (no settings write, no SQL query, no campaign send) |
| Output | Auto-escaping HTML templates; strict CSP (`script-src 'self'`, no inline script or style); `frame-ancestors 'none'` |
| Exports | CSV formula-injection protection; `Cache-Control: no-store`; every export audited |
| Secrets | Environment variables only; validated at startup; never logged (pino redaction); SMTP passwords stay in listmonk |
| Errors | Generic messages to clients; details only in server logs |
| Network | Only 80/443 public; PostgreSQL, listmonk and the portal on an internal Docker network |
| Audit | Logins, failures, contact and list changes, imports, exports, suppressions, reactivations, erasures, user changes |
| Dependencies | Lockfile; `npm audit --omit=dev` reported 0 vulnerabilities at build time (Nov 2026) |

## Recommendations for operators
- Put the listmonk admin UI behind an IP allowlist or VPN if practical (the public unsubscribe and tracking paths must stay
  reachable: `/subscription/*`, `/link/*`, `/campaign/*`, `/webhooks/*`). Enable 2FA (TOTP) for listmonk admin users.
- Run `npm audit` and update dependencies monthly; follow listmonk security advisories.
- Store `.env` and backups encrypted; restrict server SSH to keys.

## POPIA support (scope §5)

| Requirement | How MailHarbor supports it |
|---|---|
| Store consent date and source | Consent record per contact (method, purpose, date, source, evidence, recorder); mirrored on listmonk attributes |
| How and why permission was obtained | `method`, `purpose`, `evidence` fields; required on manual add and import |
| Double opt-in | listmonk double opt-in lists; the import can set subscriptions to *unconfirmed* |
| Unsubscribe in every email | listmonk `{{ UnsubscribeURL }}` + List-Unsubscribe / One-Click headers (checked on System health) |
| Suppression record | Permanent `portal.suppressions`, enforced against imports and listmonk edits |
| No re-import of suppressed | Import preview and commit exclude suppressed and blocklisted addresses |
| Export consent and unsubscribe history | Exports → *Consent & unsubscribe history* |
| Restrict access | Roles; viewers cannot export personal data; audit log |
| Remove / anonymise | Erase: deletes from listmonk, scrubs portal records, keeps only a SHA-256 hash on the suppression list |
| Possession ≠ consent | Imports reject rows with no consent basis; UI wording reinforces this |

MailHarbor supports compliance but does not by itself make an organisation compliant. Your information officer should
review marketing practices, the use of the existing-customer exception (s69(3)), retention periods and the privacy notice.
