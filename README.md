# Samvaad

Talk, reflect, breathe. A conversation-analysis web app for the Indian market.

> New here? Open **CLAUDE.md** — it has the full project context, decisions, and live resources.

## Layout
- `web/` — the frontend (`login.html`, `app.html`). Pure static HTML; open in a browser.
- `backend/` — Node/Express proxy that holds all API secrets. See `backend/README.md`.
- `docs/` — archived earlier prototypes.

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
- Anthropic — ~$5 trial credit (analysis); model `claude-sonnet-4-6`.

Never commit `.env`. It is git-ignored.
