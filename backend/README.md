# Samvaad backend

The secret-holding proxy from the architecture diagram. The browser never sees an API key — it calls
these endpoints, and the server talks to Deepgram, Claude, and ElevenLabs, then persists to Supabase.

## Endpoints
- `POST /api/transcribe` — `{audioBase64, mime, nameA, nameB}` → diarized, speaker-labelled transcript
- `POST /api/analyze` — `{transcript, mode, submode, nameA, nameB, consent}` → report (+ improved replay for relationship mode); persists if a Supabase auth token is sent
- `POST /api/tts` — `{text, speaker}` → mp3 audio (ElevenLabs)
- `POST /api/feedback` — stores the feedback-loop signal
- `GET  /api/history` — the signed-in user's past sessions (for the dashboard)

## Run locally
1. `cp .env.example .env` and fill in keys
2. In Supabase: run `schema.sql`, and create a private Storage bucket named `audio`
3. `npm install && npm start`  → http://localhost:8787/health
4. In the frontend's API-keys panel, set **Backend URL** to that address. The app then stops using
   client-side keys and routes everything through the proxy.

## Deploy (free tier)
Render / Railway / Fly.io. Set the env vars in the dashboard, set `ALLOWED_ORIGIN` to your frontend URL.

## Data posture (DPDP)
- Raw audio → private bucket, deleted right after transcription (add a scheduled purge for objects > 24h).
- RLS means a user can only ever read their own rows.
- Consent attestation is logged per session before any two-person upload is analysed.
