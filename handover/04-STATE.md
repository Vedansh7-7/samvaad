# State — what actually works

_Accurate as of 2026-08-25, commit `53cf0ad`. Verified against production, not inferred from
documentation._

---

## Verified working, end to end

Everything below was exercised against the live deployment with real provider keys.

**The core loop**
- Paste a transcript, or upload audio (Deepgram, diarized) → analysis in ~5-6 seconds
- Report: score ring, patterns, strengths, verbatim scripts, feedback capture
- Walk-through: score → breathing when escalation was genuinely high → **act 1, the real
  conversation** → what went wrong → what to say instead → strengths → **act 2, the kinder
  version** → daily check-in offer
- Both replays render the Rive avatars with audio-driven lip-sync, inside the walk-through
- Breathing reachable from every slide
- Dashboard rebuilds from `/api/history` on load, so sessions survive a reload

**Analysis quality**, asserted by the funnel test on every run
- Scores are four integers inside 0-100
- The names entered by the user are used everywhere, overriding any names in the transcript
- Genders inferred and normalised, which is what picks each person's rig
- Act 1 lines are **verbatim** from the transcript (8/8 on the standard fixture)
- Both people speak in act 1; no speaker-name prefixes leak into spoken lines
- Every emotion is one the rigs can actually wear
- Identical scores across consecutive runs (temperature 0, fixed seed, low reasoning effort)

**Accounts and limits**
- 3 conversations per signed-in account, 3/day for guests, counted in the database
- Charged only after a report succeeds; a failure or a busy 503 costs nothing
- The wall arrives on the fourth attempt with a human-readable refusal
- Suspended accounts are stopped with a 403 and a kind message
- Raising a limit from admin takes effect immediately
- A user can read their own profile and **cannot** raise their own allowance or read anyone
  else's sessions (asserted through RLS with the user's own JWT)

**Security**
- Every money-spending endpoint 401s without a principal
- Every admin endpoint 403s without the allowlist
- Guest tokens are HMAC-signed; tampered and expired tokens are rejected
- `/api/config`, the only public endpoint, leaks nothing but switches and limits

**The intro**
- Two Rive rigs, lip-synced to real ElevenLabs narration, six scenes, ~45 seconds
- Characters face each other; the speaking one is lit and animated, the other listens
- Poster frame guarantees audio; graceful silent fallback if the browser refuses anyway
- Full funnel of events including where a skipper left, sent via `sendBeacon`

**Test results, production, 2026-08-25**

```
npm run schema:check      all 7 tables, every column, 6 switches seeded
npm run funnel            41 passed, 0 failed
npm run funnel:signed-in  37 passed, 0 failed
```

---

## Built but inert

- **WhatsApp check-ins.** `/api/optin` captures consent into `nudge_subscriptions` and the admin
  console produces one-tap `wa.me` links, but **nothing is sent automatically**. There is no
  provider and no scheduler. Sending is manual, which is a deliberate choice at trial scale and
  becomes a wall past roughly 200 users.
- **"Just me" / self reflection.** Fully built, deliberately closed. See
  [03-DECISIONS.md](03-DECISIONS.md) §12.
- **`real_audio` act-1 variant.** Implemented — it matches the model's chosen lines back onto
  Deepgram turn timings and plays the user's own recording — but **never tested against a real
  recording**, because that needs a live transcription with timings. It declines rather than
  guesses (a line needs half its content words to match a turn) and falls back to `voiced` if
  fewer than half the lines match, so the worst realistic case is that it quietly behaves like
  `voiced`.

---

## Not built

- **Deterministic scoring engine.** `docs/PLAN-PRELAUNCH.md` Phase 1 describes replacing
  model-generated scores with a code-computed engine (the model emits discrete Gottman-style
  labels; arithmetic produces every number). Not started. The current scores come from the model,
  now stabilised by temperature 0 + fixed seed + low reasoning effort, which addressed the
  reproducibility complaint but not the groundedness one.
- **Async job pipeline.** Long audio still goes through a synchronous request. Phase 2 of the
  plan describes Supabase Storage uploads, a job queue, Deepgram callback mode and WhatsApp
  delivery. Not started, and not needed while the Groq free tier caps conversations at ~13 minutes.
- **Audio retention policy.** Audio is streamed through the request body and never persisted,
  which is a *stronger* privacy position than the planned 2-day bucket. If you add Storage
  uploads, you must add the purge with them.
- **Phone verification.** The number is captured and stored as the account key but is **not
  verified**. The planned WhatsApp handshake is not implemented.
- **Recording still drops the second speaker.** The in-browser Record tab uses the Web Speech
  API, which is single-speaker: a couple recording merges both voices into one unlabelled stream.
  **Upload works correctly** (Deepgram, diarized). This is a known, long-standing gap.
- **Payments.** Removed entirely. No Razorpay, no pre-sell.

---

## Known limits you will meet

1. **Groq free tier is the binding constraint.** ~2 analyses per minute across the entire cohort,
   ~35-40 per day, ~13 minutes per conversation. With ten testers active at once, some will see
   "give it a minute". Raising `GROQ_TPM` after a plan upgrade is the only change needed.
2. **ElevenLabs free tier is 10,000 characters a month** and the replay is the only thing spending
   it. If cost bites, ration the kinder replay rather than cutting it — it is the differentiator.
3. **Render free instances sleep.** The first request after idle takes ~30 seconds. Every page
   that calls the backend has a short timeout and degrades rather than hanging.
4. **The ElevenLabs key is scoped to text-to-speech**, so the admin voice-quota card cannot read
   the subscription and will show an error. That is expected, not a bug.

---

## Configuration still required

These live in dashboards, not in the repository:

- [ ] `ADMIN_USER_IDS` on Render → the Supabase user id of whoever should reach `admin.html`
- [ ] `ALLOWED_ORIGIN` on Render → the exact Vercel origin (currently `*`; the backend warns on
      every boot)
- [ ] Decide whether guest mode stays on before inviting a real cohort
- [ ] Confirm custom SMTP actually delivers under load — Supabase's built-in mailer rate-limits
      hard and fails silently
