# Staging handoff

This repository contains a staging-only Render blueprint at
`render.staging.yaml`. Preparing the blueprint does not create a Render service,
deploy code, change DNS, or modify production.

## ElevenLabs key created on 2026-09-21

- Name: `SMB Audit Engine Staging`
- Account type: restricted user key; ElevenLabs reported that service accounts
  are not enabled for this workspace
- Permission: Text to Speech only
- All other endpoint and administration permissions: no access
- Credit limit: 25,000 per credit refresh period
- Expiration: 30 days (2026-10-21)
- Leak auto-disable: enabled
- Secret handling: copied to the Mac clipboard at creation; never printed,
  written into the repository, or committed

Store the secret as `ELEVENLABS_API_KEY` in the staging service's secret
environment. Do not reuse it for production. Create a separate production key
only after staging is accepted.

## Required staging secrets

- `APP_URL`: the assigned staging URL
- `SESSION_SECRET`: newly generated, at least 32 characters
- `ADMIN_INITIAL_PASSWORD`: temporary, at least 12 characters
- `ELEVENLABS_API_KEY`: the restricted staging key described above
- Existing provider credentials needed for the exact audit paths under test

The DJ-3 allowlist, Eleven v3 model, and MP3 output format are non-secret and
already defined by the staging blueprint.

## Safe staging data

Use the dedicated `smb-audit-staging-data` disk. If realistic testing requires
production-derived data, copy only a reviewed snapshot to staging and remove or
mask client-sensitive fields first. Never mount or share the production disk.

## Acceptance checks

1. Confirm production still points at its original commit and disk.
2. Build and test the staging branch.
3. Create the staging service with auto-deploy disabled.
4. Set secrets, then trigger the first deployment manually.
5. Verify health, login, forced password change, member/admin permissions, an
   existing audit, script editing, and one short DJ-3 voiceover.
6. Confirm arbitrary voice IDs are rejected and the MP3 preview/download works.
7. Record results before requesting production approval.

