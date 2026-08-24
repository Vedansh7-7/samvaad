# Samvaad

Talk, reflect, breathe. A conversation-analysis web app for the Indian market.

> **New here, or taking this project over? Start with [`handover/README.md`](handover/README.md).**
> It is a six-document pack covering the architecture, the runbook, the decisions behind the
> non-obvious code, the current state, what to do next, and what has to be transferred.
> `CLAUDE.md` carries the working rules and is auto-loaded by Claude Code.

## Layout
- `web/` — the frontend. Pure static HTML, no build step. Deployed on Vercel.
- `backend/` — Node/Express proxy that holds all API secrets. Deployed on Render.
- `handover/` — the handover pack. Read this first.
- `docs/` — longer-form plans, audits and the reference decks. See [`docs/README.md`](docs/README.md).

## Run the frontend (demo)
Just open `web/app.html` in Chrome or Edge. Use **Load a sample → Analyse**. For audio
recording, Chrome/Edge only. Without a Backend URL it runs standalone (paste keys in Settings —
demo only; do not ship keys in the browser).

## Run the backend
```bash
cd backend
npm install
cp .env.example .env      # then fill in the keys (SUPABASE_URL is pre-filled)
npm start                 # serves on PORT (default 8787)
```
Then in `web/app.html` → Settings → set **Backend URL** to your backend origin.

## The keys you need (all have a no-card free start)
- Supabase — already provisioned (free). Only the service_role key must be copied from the dashboard.
- Deepgram — $200 one-time credit (audio → text).
- ElevenLabs — 10k chars/month free (voices); key scoped to Text-to-Speech only.
- Groq — free tier (analysis); model `openai/gpt-oss-120b`, set via `GROQ_MODEL`.

Never commit `.env`. It is git-ignored.
