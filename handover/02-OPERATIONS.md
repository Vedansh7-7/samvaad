# Operations

## Run it locally

```bash
cd backend
npm install
cp .env.example .env        # then fill it in — see the table below
npm start                   # http://localhost:8787
```

The frontend is static. Serve `web/` over HTTP (not `file://`, or the Rive rigs are blocked by
CORS):

```bash
cd web && python -m http.server 8123     # http://localhost:8123
```

Point the frontend at your local backend by running this once in the browser console:

```js
localStorage.setItem('samvaad.beUrl', 'http://localhost:8787')
```

Remove that key to go back to the deployed backend.

---

## Environment variables

Set in `backend/.env` locally and in the Render dashboard in production. **Never in git.**

| Variable | Required | Notes |
|---|---|---|
| `GROQ_API_KEY` | yes | the analysis engine |
| `GROQ_MODEL` | **no** | leave unset. The backend asks Groq what it serves and picks the best match. Set it only to pin one model. |
| `GROQ_TPM` | yes | tokens/minute on your Groq plan. Free = `8000`. **This one number sets how long a conversation the product accepts.** |
| `DEEPGRAM_KEY` | yes | audio → transcript |
| `ELEVENLABS_KEY` | yes | replay + intro voices. Scope it to text-to-speech only. |
| `ELEVEN_VOICE_A` / `_B` | no | female / male voice ids; sensible defaults are compiled in |
| `SUPABASE_URL` | yes | pre-filled in `.env.example` |
| `SUPABASE_SERVICE_KEY` | yes | **secret.** Bypasses RLS. Never expose to a browser. |
| `GUEST_SECRET` | yes | signs guest tokens. Any long random string. Unset = guest mode off. |
| `ADMIN_USER_IDS` | yes | comma-separated Supabase user ids allowed into `/api/admin/*` |
| `ALLOWED_ORIGIN` | yes | your exact Vercel origin. `*` makes the backend warn on every boot. |
| `PORT` | no | Render provides it |

---

## Verify it

Three commands. They hit the real APIs and spend real quota, on purpose: a test that mocks the
providers tests the mocks.

```bash
cd backend
npm run schema:check                  # does the database match the code?
npm run funnel                        # the public path, end to end
npm run funnel:signed-in              # the path a real tester takes
```

Each accepts a base URL, so you can point them at production:

```bash
npm run funnel https://samvaad-backend-gyk9.onrender.com
```

**What they cover.** `funnel` checks the public config leaks nothing, intro events are accepted
and stored, every money endpoint 401s without a principal, every admin endpoint 403s without the
allowlist, a tampered guest token is rejected, and then runs a real analysis and asserts the shape
of what comes back: scores in range, entered names honoured, emotions the rigs can actually wear,
act-1 lines verbatim from the transcript, both people speaking, the allowance ticking down.

`funnel:signed-in` creates a throwaway account and deletes it afterwards. It proves the profile
row appears, the allowance is counted in the database, the fourth conversation is refused, history
returns act 1 / act 2 / the speaker map intact, feedback stores with a real timestamp, a suspended
account is stopped, a raised limit takes effect immediately, and — through RLS with the user's own
JWT — that a user **cannot** raise their own allowance or read anyone else's sessions.

Last verified against production, 2026-08-25: **41/41** and **37/37**.

---

## Database changes

There is one migration file and it is idempotent: `backend/migrations/000-bring-schema-current.sql`.
Paste it into the Supabase SQL editor and run it. It is safe on a fresh database, a half-migrated
one, or one that is already current.

`001`, `002` and `003` remain in the folder as history. You do not need them.

**Always end a migration with `notify pgrst, 'reload schema';`** — Supabase's API layer caches the
schema, and without that line a brand-new table keeps returning *"Could not find the table
'public.X' in the schema cache"* until something restarts.

---

## Deploying

Both hosts auto-deploy from `master` on GitHub.

- **Backend → Render.** Root directory `backend`, start `node server.js`, health check `/health`.
  `render.yaml` is the blueprint. Free instances sleep; the first request after idle takes ~30s.
- **Frontend → Vercel.** Root directory `web`. Static, nothing to build.

Confirm a backend deploy landed by checking that `/api/config` returns the limits you expect —
those numbers are derived from the constants in `server.js`, so they change when the code does.

---

## Runbook: symptom → cause

**"Could not find the table 'public.X' in the schema cache"**
The migration has not been run, or PostgREST has not reloaded. Run
`000-bring-schema-current.sql`. Confirm with `npm run schema:check`. The admin console shows the
same thing as a banner naming exactly what is missing.

**Analysis fails with a 400 mentioning `model_decommissioned`**
Groq retired the model. The backend re-resolves automatically and continues — unless `GROQ_MODEL`
is pinned, in which case unset it. If nothing it knows is being served, it logs the full list Groq
offers; add a current chat model to the top of `MODEL_PREFERENCE` in `server.js`.

**Analysis returns 401 from Groq**
The key expired or was revoked. The backend logs *"Renew GROQ_API_KEY in the Render dashboard"*
rather than a raw status code.

**"A few conversations are being read right now"** (HTTP 503)
Not a fault. The per-minute token budget is genuinely full. Nothing was charged and no allowance
was spent. On the free tier only about two analyses fit per minute across all users. The fix is
`GROQ_TPM` after a Groq plan upgrade — nothing in the code needs to change.

**Analysis truncates or returns malformed JSON**
`GROQ_MAX_TOKENS` is too low for the model in use. gpt-oss-120b is a reasoning model; measure the
real `completion_tokens` before lowering it. See [03-DECISIONS.md](03-DECISIONS.md).

**Replay is silent, or the browser voice plays instead of ElevenLabs**
ElevenLabs quota is exhausted, or the key lacks TTS permission. The admin Metrics tab shows the
character quota when the key has `user_read`; a TTS-only key cannot read it, which is expected.

**Admin console 403s**
Your Supabase user id is not in `ADMIN_USER_IDS` on Render.

**Upload rejected as too long**
The ceiling is derived from `GROQ_TPM`, not typed in. On the free tier it is about 13 minutes.
`/api/config` and `/api/me` both report the true numbers.

**A tester says the app "forgot" their sessions**
They were a guest. Guests persist nothing, by design. Check whether guest mode should still be on.

---

## Costs and ceilings

The free tiers, and what breaks first:

| Service | Free tier | What it limits |
|---|---|---|
| **Groq** | 8,000 tokens/min, 200k/day | ~2 analyses per minute cohort-wide, ~35-40 per day total, ~13 minutes of conversation each. **This is the binding constraint.** |
| **ElevenLabs** | 10,000 characters/month | replay voices. The intro's narration is pre-generated and costs nothing ongoing. |
| **Deepgram** | $200 one-time credit | transcription, ~$0.0043/min. Comfortable for a trial. |
| **Supabase** | free tier | fine at trial scale |
| **Render** | free, sleeps when idle | a 30s cold start on the first request |

The first upgrade worth paying for is Groq. Raising `GROQ_TPM` lifts both the conversation length
and the throughput with no code change.

---

## Regenerating the intro

The script lives in `web/audio/intro/script.json`; the audio is `web/audio/intro/*.mp3` (271 KB
total, mono 48 kbps). To change the narration, edit the lines, regenerate through the ElevenLabs
API with the same voice ids, re-encode to mono 48 kbps, and update the `dur` values in the
`SCENES` array in `intro.html` to the new measured durations.

The marketing cut is recorded from `intro.html?film=1` with a headless browser and muxed with the
concatenated narration using ffmpeg. Recording it from the live page rather than building a
separate video means the clip can never drift from the product it advertises.
