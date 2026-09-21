# SMB Audit Engine

Internal React/Express/SQLite application for producing SMB four-pillar digital
audits, client reports, Manus presentation prompts, ElevenLabs-ready scripts,
and downloadable narration.

This source was recovered from the original Perplexity build repository. The
existing audit schema, report flow, SQLite file, and Render persistent-disk
layout are preserved.

## Local setup

Requirements: Node 20, npm, Poppler (`pdftoppm`) for PDF rendering, and the
environment variables in `.env.example`.

```bash
cp .env.example .env
npm ci
npm run check
npm test
npm run dev
```

For local-only work you may set `AUTH_ENABLED=false`. Production refuses to
start with authentication disabled.

## Architecture

- `client/`: React/Vite staff UI
- `server/`: Express API, audit generation, integrations, authentication
- `shared/schema.ts`: SQLite/Drizzle audit schema and shared report types
- `templates/`: narration prompt template copied into the production image
- `data.db`: runtime SQLite database (ignored by Git; `/var/data/data.db` on
  Render)
- `/var/data/uploads`, `/var/data/manus-decks`, `/var/data/voiceovers`: runtime
  artifacts on the persistent disk

## Voiceover security model

The browser receives only approved voice names/IDs and job status. The
`ELEVENLABS_API_KEY` is read only by the server and is never returned, logged,
or embedded in the client bundle. Configure a restricted ElevenLabs
service-account key with Text to Speech permission only. Voice selection is
limited by `ELEVENLABS_APPROVED_VOICES_JSON`; arbitrary browser-supplied voice
IDs are rejected.

Narration uses `eleven_v3` by default and preserves v3 delivery tags such as
`[warmly]` and `[pause]`. Editor-only block and Markdown headings are removed
before synthesis. Long scripts are generated in safe segments and combined
into one MP3. Character count is shown as an estimated credit count; actual
billing remains plan-dependent.

## Operations

Read [DEPLOY.md](./DEPLOY.md) before any Render change. Production deployment,
environment edits, DNS changes, permission changes, and API-key creation all
require explicit owner approval.
