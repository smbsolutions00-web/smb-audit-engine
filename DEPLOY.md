# Deploying SMB Audit Engine to Render

This guide walks through standing the engine up at `https://audit.smbsolution.ai` with magic-link login restricted to `smbsolutions00@gmail.com`.

## What you'll need (15 min total)

1. A [Render](https://render.com) account (free signup)
2. A [Resend](https://resend.com) account for sending magic-link emails (free tier — 100 emails/day, plenty)
3. Access to GreenGeeks cPanel for `smbsolution.ai` to add a DNS record
4. The repo pushed to a private GitHub repo (the agent will help)

---

## 1. Generate a session secret

Already generated for this deployment:

```
SESSION_SECRET=VCRdRzzH7vYFPbKvIS-X9oEhKJad4Ig3h_PRSAunItba00qBv_yEzB5q_ikUxON6
```

Treat this like a password — anyone with it can forge login sessions. Keep it only in Render's env-var dashboard.

## 2. Sign up for Resend (5 min)

1. Go to <https://resend.com> → Sign up
2. **API Keys** → **Create API Key** → name it `smb-audit-prod` → copy the `re_…` value
3. **For initial testing**: use `onboarding@resend.dev` as the from-address — works immediately, no domain setup needed
4. **For production**: add `smbsolution.ai` as a sending domain (Domains → Add Domain), then add the DKIM/SPF records Resend gives you to GreenGeeks DNS. Once verified you can send from `noreply@smbsolution.ai`.

## 3. Push to a private GitHub repo

The agent does this for you via the GitHub connector. The repo will contain everything in this directory **except** `node_modules/`, `dist/`, `data.db*`, and `uploads/` (already in `.gitignore`).

## 4. Create the Render service

1. <https://render.com> → **New** → **Web Service**
2. **Connect GitHub** → authorize → pick the new private repo
3. Render auto-detects `render.yaml` in the repo root and pre-fills:
   - Runtime: Node
   - Build: `npm ci && npm run build`
   - Start: `node dist/index.cjs`
   - Persistent disk `smb-audit-data` mounted at `/var/data` (1 GB)
   - Plan: **Starter ($7/mo)** — keeps the app always-on. (Free plan sleeps after 15 min idle, which means a 30-second cold-start on the first request after a quiet period.)
4. **Set the secret env vars** (the ones marked `sync: false` in `render.yaml`):
   - `SESSION_SECRET` → the value from step 1
   - `RESEND_API_KEY` → from step 2
   - `AUTH_FROM_EMAIL` → `onboarding@resend.dev` for testing, or `SMB Audit <noreply@smbsolution.ai>` once your domain is verified in Resend
   - `ANTHROPIC_API_KEY` → your existing Claude key
5. Click **Create Web Service**. First build takes ~3-4 min.

You'll get a URL like `https://smb-audit-engine.onrender.com` — confirm login works there before pointing DNS.

## 5. Add the custom domain

1. In Render: **Settings** → **Custom Domains** → **Add Custom Domain** → `audit.smbsolution.ai`
2. Render shows you a CNAME target like `smb-audit-engine.onrender.com` (copy the exact value)

## 6. Add the CNAME at GreenGeeks

1. Log in to GreenGeeks cPanel → **Zone Editor** (under Domains)
2. Click **Manage** next to `smbsolution.ai`
3. **+ Add Record** → type **CNAME**:
   - **Name**: `audit`
   - **Record (target)**: the exact `*.onrender.com` value Render gave you (include the trailing dot if cPanel requires)
   - **TTL**: `14400` (4 hours) — drop to `300` while testing
4. Save. Propagation usually takes 5-30 min.

## 7. Verify

1. In Render, the custom domain row will flip from "Pending" → "Verified" once DNS resolves
2. Render auto-provisions a Let's Encrypt SSL cert (another 1-2 min)
3. Visit <https://audit.smbsolution.ai>, enter `smbsolutions00@gmail.com`, check inbox for the magic link, click it → you should land on the dashboard

If the login email doesn't arrive: check the Resend **Logs** tab — every send is recorded there. Also check Render service logs (`render logs`) for `[auth] magic link →` lines.

## Operational notes

- **Persistent data** lives at `/var/data/data.db` (audits) and `/var/data/uploads/` (Manus PDFs). Render disks survive deploys, restarts, and plan upgrades.
- **Backups**: Render doesn't auto-backup the disk. Snapshot occasionally — Settings → Disks → Snapshot.
- **Logs**: Render dashboard → Logs (live tail) or `render logs --tail` via CLI.
- **Add a user later**: edit `ALLOWED_EMAILS` env var (comma-separated list) → Save → Render redeploys automatically (~30 sec).
- **Free tier alternative**: change `plan: starter` to `plan: free` in `render.yaml`. Saves $7/mo but the app sleeps after 15 min idle (first request wakes it in ~30 sec).
