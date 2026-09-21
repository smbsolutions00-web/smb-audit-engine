# Security notes

- Authentication is mandatory in production and fails closed at startup.
- Passwords are bcrypt hashes in the existing SQLite database; minimum length
  is 12 characters.
- Login attempts are rate-limited per IP/email pair.
- Mutating production API requests enforce same-origin checks.
- Cookies are HTTP-only, secure in production, and `SameSite=Lax`.
- Admin creation/reset secrets come from runtime environment variables and are
  never logged. Remove temporary reset variables after use.
- `/api/auth/debug` is intentionally absent; do not reintroduce a public
  environment diagnostic endpoint.
- Integration keys belong in Render runtime secrets or a local ignored `.env`,
  never in browser code, logs, Git, or screenshots.
- MP3 downloads remain behind session authentication and use private/no-store
  caching.

The session secret that appeared in historical `DEPLOY.md` must be considered
compromised and rotated before production authentication is restored.
