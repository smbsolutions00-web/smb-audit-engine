# Render deployment runbook

This repository is the recovered source for `https://audit.smbsolution.ai`. No
deployment, DNS, Render permission, or production environment change should be
made without explicit owner approval.

## Pre-deploy backup

1. Snapshot the Render persistent disk mounted at `/var/data`.
2. Copy `/var/data/data.db`, `data.db-wal`, `data.db-shm`, `uploads/`,
   `manus-decks/`, and `voiceovers/` to protected storage.
3. Record the currently deployed commit and confirm the rollback button is
   available in Render.

The SQLite schema is migrated in place with additive tables/columns. Do not
replace `data.db`; existing audits and users are preserved.

## Required runtime variables

Set these on the web service runtime environment, not only in a build
environment or environment group that is not linked to the service:

- `AUTH_ENABLED=true`
- `SESSION_SECRET`: a newly generated 32+ character secret
- `ADMIN_EMAIL`: the owner/admin email
- `ADMIN_INITIAL_PASSWORD`: 12+ character temporary password only when the
  admin row does not exist or an intentional reset is being performed
- `DATA_DIR=/var/data`
- `APP_URL=https://audit.smbsolution.ai`
- the existing Anthropic, DataForSEO, Keysearch, Manus, captcha, and proxy
  credentials used by the audit workflow
- `ELEVENLABS_API_KEY`: restricted key with Text to Speech permission only;
  prefer a service-account key where the ElevenLabs workspace supports it
- `ELEVENLABS_APPROVED_VOICES_JSON`: JSON allowlist such as
  `[{"id":"UFPKgXaO1YZylfGuGr3z","name":"DJ-3"}]`
- `ELEVENLABS_MODEL_ID=eleven_v3`
- `ELEVENLABS_OUTPUT_FORMAT=mp3_44100_128`

Production now fails closed if auth is disabled or `SESSION_SECRET` is weak.
The old public auth diagnostic endpoint and environment-password bypass have
been removed.

## Safe rollout

1. Build and test the exact commit locally.
2. Deploy to a Render preview/staging service attached to a copy of the SQLite
   data, never the production disk.
3. Verify `/api/health`, login, forced password change, member access, admin
   user management, an existing audit/report, script viewing/editing, and a
   short ElevenLabs generation with an approved voice.
4. Deploy the commit to production during a low-traffic window.
5. Confirm Render logs show auth enabled and the existing admin row found.
6. Sign in before changing any DNS or removing rollback capacity.
7. After the first successful password change, remove
   `ADMIN_INITIAL_PASSWORD`. If `ADMIN_RESET_PASSWORD` was used, remove it
   immediately and redeploy once more.

## Rollback

Rollback the application to the recorded prior commit. The new
`voiceover_jobs` table and `voiceovers/` directory are additive and can remain.
Restore the disk snapshot only if SQLite integrity checks fail; application
rollback alone is preferred.

## Secret rotation required

An historical session secret was previously committed to this public
repository. It has been removed from the current tree but remains compromised
by history. Rotate `SESSION_SECRET` in Render before restoring production auth;
this intentionally invalidates all existing session cookies.
