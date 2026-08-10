# Samvaad — Pre-launch Plan (Trial Cohort)

_Written 2026-08-11. Supersedes `ROADMAP.md` Phase A. Companion to `docs/STATE-OF-PLAY.md`
(what exists today). Task format matches `ROADMAP.md`: **Goal · Files · Approach · Done-when**,
one agent per file._

---

## Context

We are going to market with a pre-launch trial version. Users hand us a real conversation —
pasted chat or pre-recorded audio up to 30 minutes — and get back an analysis. Because a
30-minute file can't be processed inside a browser request, the analysis becomes an **async job**:
they upload, we process, and we tell them on WhatsApp when the report is ready.

That pivot forces four things the current build doesn't have:

1. **Scores that don't move.** Today a 70B model invents four 0–100 numbers at `temperature 0.6`.
   Same conversation, different run, different score. For a product strangers are being asked to
   trust, that's disqualifying. We replace it with a grounded, deterministic scoring engine.
2. **Doors that lock.** `/api/analyze`, `/api/transcribe` and `/api/tts` currently accept
   unauthenticated requests from anyone with the Render URL. Zero users means zero incidents so
   far. Marketing changes that on day one.
3. **Per-user control.** Phone number becomes the unique account key. An admin — non-technical —
   must be able to see every user, cap them, suspend them, and flip features on, without touching
   env vars or code.
4. **A funnel with a front door.** An intro video before sign-up, one live mode instead of three,
   and a walk-through reordered to lead with the replay.

### Decisions locked with the founder (2026-08-11)

| Decision | Choice |
|---|---|
| Analysis model | **Stay on Groq** `llama-3.3-70b-versatile` |
| Metrics | **Calm · Expression · Care → Samvaad Score** (all higher = better) |
| Metric display | Composite up front, three-way breakdown one tap away |
| Modes | **Relationship Analysis** (live) · **Self Reflection** (admin-gated). Third mode **deleted** |
| Audio retention | **Fixed 2 days**, then hard purge |
| Phone verification | **WhatsApp handshake** — code sent to our business number, matched in admin |
| Guest mode | **Kept** (dev testing), but token-gated and admin-killable |
| Payments | **No Razorpay.** `founding.html` + `/api/founding` + `founding_members` deleted |
| Self-consistency voting | **Skipped** — temp 0 + seed + hash cache is enough |
| Intro media | **MP4, self-hosted in-place** |

---

## Phase 0 — Lock the doors *(nothing marketing-facing ships before this is done)*

### P0-T1 Auth on the expensive endpoints
**Goal:** no unauthenticated request can spend money.
**Files:** `backend/server.js`, `web/app.html`.
**Approach:** `/api/transcribe`, `/api/analyze`, `/api/tts`, `/api/jobs*` require either a Supabase
JWT (existing `getUser`) or a backend-issued guest token. Add `POST /api/guest` → returns a
short-lived HMAC-signed token (payload: random id, issued-at, expiry ~2h) signed with a new
`GUEST_SECRET`; verified by a `getPrincipal(req)` helper that returns `{kind:'user'|'guest', id}`.
Guests get a hard daily cap and never persist. Admin can disable guest issuance entirely
(`app_settings.guest_enabled`).
**Done-when:** every money-spending endpoint returns 401 without a valid principal; guest mode still
works for testing; disabling guests in admin makes `POST /api/guest` refuse.

### P0-T2 Per-user quota, status and the `forUser` guard
**Goal:** one account per phone; every query provably scoped; admin can cap or suspend anyone.
**Files:** `backend/schema.sql`, `backend/server.js`.
**Approach:** new `profiles` table (see §Schema). Before any Deepgram/Groq/ElevenLabs spend, check
`status='active'` and `minutes_used_month < minutes_quota`; reject with a friendly message
otherwise. Add a single `forUser(table, principal)` helper that returns a query builder with
`.eq('user_id', principal.id)` already applied, and route **every** user-scoped read/write through
it — the service-role key bypasses RLS, so one forgotten filter leaks every user's private
analysis.
**Done-when:** a suspended user gets a clear refusal; an over-quota user gets a clear refusal; no
user-scoped Supabase call in `server.js` is written without `forUser`.

### P0-T3 Payload, duration and word caps
**Goal:** bound every input before it reaches a paid API.
**Files:** `backend/server.js`, `web/app.html`.
**Approach:** three layers.
- *Client:* read `<audio>.duration` before upload; reject > 35 min outright with a clear message.
- *Transcript:* live character counter; hard stop at **25,000 characters** (≈ 4,500 words ≈ 30 min
  of speech).
- *Server, at the diarization step:* after Deepgram returns, count words. Over **4,500**, truncate
  at the last complete turn under the limit and return `{truncated:true, wordsKept, wordsTotal}`.
  The app shows a calm notice: *"This one ran long — we analysed the first ~N words."* Analysis
  proceeds on the truncated text rather than failing.
**Done-when:** a 40-minute file is rejected client-side; a 35-minute file is truncated server-side
with the notice shown; a 30k-character paste can't be submitted.

> **Found while building this (2026-08-11): the 30-minute promise is blocked by Groq's free tier.**
> Groq counts prompt + `max_tokens` against a tokens-per-minute limit, and one analysis makes two
> calls inside the same minute, so each may use at most half the budget. On the free tier's 12,000
> TPM that works out to about **1,500 words, roughly 10 minutes of speech**. A 30-minute
> conversation returns `groq 413` outright. This is not new, the live site has always had it, it
> was just never surfaced because nobody had submitted anything long.
>
> The code now derives its ceiling from a `GROQ_TPM` env var (default 12,000) and trims honestly,
> telling the user how many words were read. Raising that one variable after upgrading the Groq
> plan lifts the limit with no code change. Until then the advertised figure must say **10
> minutes**, not 30. Also fixed alongside it: the 429 retry used a 350ms backoff while Groq was
> asking for 7 seconds, so every rate-limit retry failed. It now honours `retry-after`.

### P0-T4 Lock CORS, kill the dead paths, delete the mock
**Goal:** shrink the surface.
**Files:** `backend/server.js`, `web/app.html`, `web/founding.html` (delete), `render.yaml`.
**Approach:** `ALLOWED_ORIGIN` must be the Vercel origin (no `*` fallback in production — fail loud
if unset). Delete `founding.html`, `POST /api/founding`, and the `founding_members` table. Remove
the dead browser-side `claude()` that POSTs to `api.anthropic.com` with no key, plus the hidden
`dgKey`/`elKey`/`elA`/`elB` inputs and their standalone branches — the proxy is the only path now.
Fix the `render.yaml` comment that still says "Mixtral-8x7B".
**Done-when:** no API-key input exists in the DOM; no direct provider call from the browser; the
founding page is gone from the repo and the deploy.

### P0-T5 Custom SMTP
**Goal:** sign-ups stop failing silently under load.
**Files:** none (Supabase dashboard) — record the choice in `CLAUDE.md`.
**Approach:** **Brevo** — 300 emails/day free, and it verifies a single sender address without
requiring an owned domain (Resend is cleaner but wants a verified domain; revisit when Samvaad has
one). Supabase → Project Settings → Auth → SMTP: Brevo host, port 587, login + SMTP key. Keep the
`{{ .Token }}` template so the 6-digit code path in `login.html` keeps working.
**Done-when:** 10 consecutive sign-ups in 10 minutes all receive their code.

### P0-T6 Fix the feedback insert
**Goal:** the `{context → intervention → outcome}` signal actually records.
**Files:** `web/app.html`, `backend/server.js`.
**Approach:** send `asked_at` as ISO-8601, not `Date.now()` milliseconds (the column is
`timestamptz`). Whitelist the accepted fields server-side instead of spreading `req.body`, and log
the Supabase error instead of swallowing it.
**Done-when:** a feedback tap produces a visible row in the `feedback` table.

---

## Phase 1 — The scoring engine

This is the heart of the pivot and the reason the product can be trusted. **The model never
produces a number.** It produces discrete labels; code produces every score.

### P1-T1 Deterministic feature extraction
**Goal:** the reproducible half of the score, with no model involved.
**Files:** `backend/scoring/features.js` (new), `backend/scoring/lexicon.js` (new).
**Approach:** from the speaker-labelled transcript (and `turns[]` timings when the input was audio),
compute per speaker and overall: word/turn counts, talk balance, question count, I-statement vs
you-blame ratio, absolutes (`always / never / hamesha / kabhi nahi / har baar`), repair markers
(`sorry / maaf / I hear you / samajh / chalo`), appreciation markers, affect-word density, and —
from timings only — interruption rate, mean inter-turn gap, long silences. Lexicons are Hinglish +
English + Devanagari, in one reviewable file. Everything is normalised **per 10 turns** so a
30-minute conversation isn't automatically scored worse than a 3-minute one.
**Done-when:** the same transcript yields byte-identical features across 100 runs; timings-derived
features degrade gracefully to `null` for pasted text.

### P1-T2 The LLM as labeller
**Goal:** stable, discrete behavioural coding instead of invented numbers.
**Files:** `backend/scoring/label.js` (new), `backend/server.js`.
**Approach:** one Groq call per batch of ~40 turns, `temperature: 0`, fixed `seed`,
`response_format: json_object`. Per turn the model returns labels from a **closed enum** —
`criticism · contempt · defensiveness · stonewalling · harsh_startup · softened_startup ·
repair_attempt · validation · appreciation · bid_for_connection · turning_toward · turning_away ·
neutral` — plus `intensity: low|med|high`. Any label outside the enum is dropped, not repaired.
Reuse the existing retry-with-backoff in `claude()` for Groq's stochastic JSON 400s.
**Done-when:** labelling a 4,500-word transcript 5× produces identical label sets; unknown labels
never reach the scorer.

### P1-T3 The arithmetic
**Goal:** four numbers a non-technical user can follow, computed entirely in code.
**Files:** `backend/scoring/score.js` (new).
**Approach:** two densities per 10 turns —
`N` (negativity) from contempt ×2.0, criticism ×1.5, defensiveness ×1.2, stonewalling ×1.2,
harsh_startup ×0.8, absolutes ×0.5, interruptions ×0.7;
`P` (positivity) from repair_attempt ×1.5, validation ×1.5, appreciation ×1.2, turning_toward ×1.0,
softened_startup ×0.8, questions-about-the-other ×0.5.

- **Calm** = `N` (plus escalation slope: negativity in the second half minus the first) mapped
  through a **fixed piecewise curve** with published anchors, inverted so higher = calmer.
- **Expression** = I-statement ratio, softened start-ups, affect-word density, and specificity
  (absolutes penalised) → fixed anchors.
- **Care** = `turning_toward / bids_for_connection` (Gottman's core ratio), validation,
  appreciation, questions about the other, and repair attempts *accepted* (a repair followed within
  two turns by validation or turning-toward) → fixed anchors.
- **Samvaad Score** = `0.40·Care + 0.30·Expression + 0.30·Calm`, snapped to a 5-point display grid
  with a band label: *Thriving 85+ · Steady 70–84 · Strained 55–69 · Tense 40–54 · Escalating <40*.

Also surface the raw **positive:negative ratio** as a plain sentence — *"Your positives outweighed
negatives 3.2 to 1. Research on stable couples clusters around 5 to 1."* It's the most citable,
most memorable anchor in the field, and it costs nothing to compute.
**Done-when:** every weight and anchor lives in one exported constants block; changing a weight
changes scores predictably; no score depends on model-generated numbers.

### P1-T4 Grounding, guardrails and honest framing
**Goal:** defensible, and honest about what it is.
**Files:** `docs/SCORING.md` (new), `web/privacy.html`, in-app copy.
**Approach:** `docs/SCORING.md` documents each metric, its formula, its weights, and its source —
Gottman's Four Horsemen and the ~5:1 positive:negative ratio (Calm and the composite), Rosenberg's
NVC and Pennebaker's pronoun work (Expression), Reis & Shaver's *perceived partner responsiveness*
and Gottman's bids/turning-toward (Care). **Every citation must be verified against its source
before publication — not written from memory.**

The honest caveat, stated in the doc and reflected in app copy: these instruments were validated on
mostly Western couples, coded from video by trained humans. Applying them to Hinglish text is an
*adaptation*, not a validated clinical measure. Copy must never imply diagnosis. Guardrails: refuse
to score inputs under 10 turns (say why); never score a single speaker in Relationship Analysis;
surface a low-confidence flag when the transcript is short or badly diarized.
**Done-when:** `docs/SCORING.md` exists with verified citations; the app shows the method to any
user who taps "how is this calculated?".

### P1-T5 The repeatability guarantee
**Goal:** the same conversation always shows the same number.
**Files:** `backend/schema.sql`, `backend/server.js`, `backend/eval/` (new).
**Approach:** SHA-256 the normalised transcript (whitespace/case-folded) → `analysis_cache` table.
A cache hit returns the stored result and never calls Groq. Combined with temp 0, fixed seed,
discrete labels, arithmetic scoring and 5-point display snapping, a re-submission is bit-identical.
Build a **golden set of 20 conversations** (mixed: healthy, escalating, one-sided, Hinglish,
Devanagari, short, 30-min) in `backend/eval/` with a runner that scores each 5× and asserts
variance.
**Done-when:** identical input → identical displayed score, 100% of runs; near-identical inputs land
within ±3 on the composite; the eval runner is one command.

---

## Phase 2 — The async pipeline and the WhatsApp loop

### P2-T1 Storage upload + 2-day purge
**Goal:** get 30-minute files off the JSON request body, and delete them on schedule.
**Files:** `backend/server.js`, `backend/schema.sql`, Supabase dashboard (private `audio` bucket).
**Approach:** `POST /api/upload-url` returns a signed Supabase Storage upload URL; the browser PUTs
the file directly. The job row carries `audio_path` and `audio_expires_at = now() + 2 days`. A purge
runs on an interval inside the backend **and** on boot (Render free instances sleep, so a
timer-only purge will miss windows), deleting expired objects and nulling `audio_path`.
**Done-when:** a 25MB file uploads without touching Express; audio is gone at 48h, verified in the
bucket; a purge still happens after the instance sleeps overnight.

### P2-T2 Jobs: queue, worker, status
**Goal:** analysis becomes a job, not a request.
**Files:** `backend/schema.sql`, `backend/server.js`, `web/app.html`.
**Approach:** `POST /api/jobs` (audio path *or* transcript) validates quota + caps, writes a
`queued` row, returns the id immediately. An in-process worker moves it
`queued → transcribing → scoring → ready|failed`, writing the finished report into `sessions` and
flipping the job. Deepgram runs in **async callback mode** (`callback` param → `POST
/api/hooks/deepgram`) so a long transcription survives a sleeping instance. On boot, re-queue any
job left mid-flight. `GET /api/jobs/:id` for polling; the app shows a calm "we'll message you when
it's ready" state instead of a spinner.

Short pasted transcripts (< ~2,000 chars) stay **synchronous** — they finish in seconds and making
someone wait for a WhatsApp message would be absurd. Everything else goes async.
**Done-when:** a 30-minute upload completes end-to-end while the browser is closed; a killed
instance resumes the job on restart; the user is never shown a fake progress bar.

### P2-T3 Report delivery over WhatsApp
**Goal:** the user gets a link, and only the user can open it.
**Files:** `web/admin.html`, `backend/server.js`, `web/app.html`.
**Approach:** ready jobs appear in an admin queue with a one-tap `wa.me` link, pre-filled with a
short warm message plus a deep link `app.html?report=<session_id>`. **Opening it requires sign-in**
— a report on a private relationship conversation is the most sensitive artifact this product
produces, and a forwardable bare URL is not acceptable. Already-signed-in users land straight on
the report; others get the magic-link flow and are returned to it. Log `notified_at` so nobody gets
messaged twice.
**Done-when:** admin taps once and WhatsApp opens with the message ready; a signed-out stranger with
the link sees a sign-in wall, not a report.

### P2-T4 Event logging (E2-T1, finally)
**Goal:** the KPIs the admin dashboard promises become computable.
**Files:** `backend/schema.sql`, `backend/server.js`, `web/app.html`.
**Approach:** `events` table + `POST /api/event`. Fire: `intro_completed`, `intro_skipped`,
`signup_started`, `phone_submitted`, `phone_verified`, `job_created`, `job_ready`, `report_opened`,
`walkthrough_opened`, `walkthrough_completed`, `replay_played`, `breathing_taken`,
`feedback_given`. Keyed to user id, or an anon id for guests.
**Done-when:** DAU, completion rate, D1/D7 retention and time-to-report are all derivable from
`events` alone.

---

## Phase 3 — The new funnel

### P3-T1 Intro video page
**Goal:** 5 seconds to explain the product before anyone is asked to sign up.
**Files:** `web/intro.html` (new), `web/media/intro.mp4` (new), `web/index.html`.
**Approach:** `index.html` → `intro.html` → `login.html`. Full-bleed MP4, `muted autoplay
playsinline` (browsers block unmuted autoplay), poster image behind it, burned-in captions since it
plays silent. **Skip** appears at 5s; a small always-available "Skip →" for returning visitors; a
`localStorage` flag so it plays once. If the video fails to load, fall through to `login.html`
rather than trapping anyone.

Constraints for the file: H.264 MP4, 720p, **under ~5MB**, 15–25s. Self-hosted on Vercel, not a
YouTube embed — an embed loads a third-party player and tracker on the first screen of an app whose
entire pitch is privacy.

*Founder writes the story; suggested beat sheet — the hook must land inside the first 5 seconds:*
1. **0–3s** two chat bubbles, tense: *"You said you'd call."* / *"I was working."*
2. **3–7s** the lotus draws itself through them; the tension visibly settles.
3. **7–12s** the Samvaad Score dial fills; Calm · Expression · Care tick in.
4. **12–17s** two avatars replay the same moment, kinder, with voice.
5. **17–20s** logotype + one line: *"Understand the conversation. Then have a better one."*

**Done-when:** first-time visitor sees the video and can skip at 5s; returning visitors go straight
to login; total added weight under 5MB.

### P3-T2 Phone capture + WhatsApp handshake verification
**Goal:** phone becomes the unique account key, verified at zero cost.
**Files:** `web/login.html`, `web/auth.js`, `backend/server.js`, `web/admin.html`, `backend/schema.sql`.
**Approach:** after email OTP succeeds, a new step collects the phone with explicit consent copy
("we'll message you here when your analysis is ready, and nothing else"). `POST /api/me/phone`
stores it and issues a 6-digit code. The app shows the code plus a `wa.me` link to our business
number pre-filled with *"Samvaad verify: 123456"*. The user taps and sends; the admin panel shows
pending codes and marks them verified on match.

This costs nothing, proves they're actually reachable on WhatsApp, and (because *they* messaged
*us*) opens Meta's 24-hour reply window, which is exactly what makes messaging them back
legitimate. `profiles.phone` is `unique`, so one account per number.

**Session persistence — "Keep me signed in".** `auth.js` currently stores the session in
`sessionStorage`, which is wiped when the tab closes. That was a deliberate data-minimisation
choice, but it collides with WhatsApp delivery: every report link opens a fresh tab, finds no
session, and forces the user back through an email round-trip before they can read anything. Add a
checkbox on `login.html`, unticked by default. Unticked keeps today's behaviour exactly. Ticked
switches the store to `localStorage` so the session survives a tab close and the refresh token
keeps it alive. `auth.js` gains a storage selector (`ss()` picks the store based on a persisted
preference flag) and `signOut()` must clear both. Letting the user decide how much their device is
trusted is more honest than picking one default for everyone, and it matters in a market where
phones get shared.
**Done-when:** a new user completes email → phone → WhatsApp code → app; a duplicate phone is
refused; admin sees and clears the pending queue; a user who ticks "keep me signed in" can close
the browser, reopen a report link, and land straight on the report.

### P3-T3 One live mode, one flagged, one deleted
**Goal:** ship a focused relationship product.
**Files:** `web/app.html`, `backend/server.js`, `backend/schema.sql`.
**Approach:** rename **"Us two" → Relationship Analysis** and **"Just me" → Self Reflection**
everywhere (UI, prompts, `mode`/`submode` values, dashboard badges). **Delete the "A relationship"
solo mode entirely** — remove the intent card, its lens branch in both prompts, and its copy.
Self Reflection renders only when `profiles.features.self_reflection` is true; the mode selector
collapses to a single label when only one mode is available (no orphan segmented control of one).
Admin can flip the flag per user or globally.
**Done-when:** a normal user sees only Relationship Analysis; the admin flips a flag and Self
Reflection appears on that user's next load; no code path references the deleted mode.

### P3-T4 Walk-through reordered — replay first
**Goal:** lead with the thing people came for.
**Files:** `web/app.html`.
**Approach:** new order — **① the replay** (the video moment, autoplays the kinder version) → **②
what to improve** (the verbatim scripts) → **③ the full board** (Samvaad Score large, with Calm ·
Expression · Care and strengths/patterns one tap away) → **④ WhatsApp check-in opt-in**.

**One override, and it stands:** when `Calm < 40`, a Breathe slide is inserted *before* the replay.
`PRODUCT.md` principle 1 is "emotion before insight" — someone who just had a fight should not be
handed a video first. Everything else follows the founder's order. The walk-through auto-opens the
first time a report is opened from a WhatsApp link.
**Done-when:** a calm report opens on the replay; a high-tension report opens on the breath; the
board shows the composite with the breakdown one tap away.

### P3-T5 Admin panel v2
**Goal:** a non-technical admin runs the trial without touching env vars or code.
**Files:** `web/admin.html`, `backend/server.js`.
**Approach:** four sections.
- **Users** — table of phone, email, status, minutes used/quota, feature flags, last seen. Per-row:
  suspend · limit · set quota · toggle Self Reflection · mark phone verified.
- **Jobs** — live queue with status; ready rows carry the one-tap `wa.me` notify button; failures
  show the reason and a retry.
- **KPIs** — the existing cards, now real, from `events`.
- **Settings** — guest mode on/off, global feature flags, default quota. Stored in an `app_settings`
  table, not env vars, so the admin never needs Render.

`ADMIN_USER_IDS` stays as the gate (it's a security boundary, correctly in env). Everything an admin
*operates* moves into the UI. Design pass to the locked system at the same time — this page is
currently unstyled relative to the rest.
**Done-when:** the admin can suspend a user, raise a quota, enable Self Reflection, disable guest
mode, and send a report link — all from the browser.

---

## Schema changes

```sql
-- new
profiles(user_id pk → auth.users, phone text unique not null, phone_verified bool default false,
         verify_code text, display_name text, status text check (active|limited|suspended),
         minutes_used_month numeric default 0, minutes_quota numeric default 60,
         features jsonb default '{"self_reflection":false}', created_at, updated_at)
jobs(id uuid pk, user_id, kind text check (audio|transcript),
     status text check (queued|transcribing|scoring|ready|failed),
     audio_path text, audio_expires_at timestamptz, transcript_hash text,
     session_id uuid → sessions, truncated bool, error text, notified_at timestamptz,
     created_at, updated_at)
analysis_cache(transcript_hash text pk, result jsonb, created_at)
events(id uuid pk, user_id uuid null, anon_id text null, name text, props jsonb, created_at)
app_settings(key text pk, value jsonb, updated_at)

-- altered
sessions: + speakers jsonb, + metrics jsonb (calm|expression|care|composite|band|pn_ratio),
          + features jsonb, + labels jsonb, + truncated bool

-- dropped
founding_members
```
RLS on every new user-scoped table, `auth.uid() = user_id`, matching the existing pattern in
`schema.sql`. `app_settings` and `analysis_cache` are service-role only (RLS on, no policy) — same
trick already used for `founding_members`.

---

## Cost map — users vs. monthly spend

Assumes **2 analyses per user per month, 15-minute average audio**, kinder-replay TTS ~700
characters per analysis. Prices are approximate and must be re-checked at purchase.

| | **100 users** | **500 users** | **2,000 users** |
|---|---|---|---|
| Analyses / month | 200 | 1,000 | 4,000 |
| Audio minutes | 3,000 | 15,000 | 60,000 |
| **Deepgram** (~$0.0043/min) | ~$13 — *covered by the $200 credit* | ~$65 — credit lasts ~3mo | ~$260/mo |
| **Groq** (llama-3.3-70b) | ~$2 | ~$8 | ~$32 |
| **ElevenLabs** (TTS chars) | 140k → **Creator $22** | 700k → **Pro $99** | 2.8M → **Scale $330** |
| **Supabase** (2-day audio buffer ≈ 1.4GB peak @100u) | **Pro $25** | Pro $25 | Pro $25 + storage |
| **Render** (jobs must not sleep) | **Starter $7** | Starter $7 | Standard $25 |
| **Vercel** (commercial use) | **Pro $20** | Pro $20 | Pro $20 |
| **Brevo** (auth email) | Free | Free | ~$9 |
| **WhatsApp** (manual `wa.me`) | Free | Free — *but manual sending breaks down past ~200* | Business API, ~₹0.15/conversation |
| **Monthly total** | **≈ $75–90** | **≈ $225** | **≈ $700+** |

Two things this table makes obvious:

**ElevenLabs is the cost driver, and it's driving the wrong thing.** Real-voice replay — the actual
USP — costs *nothing*, because it plays the user's own audio. Every rupee here goes to the kinder-
version TTS. If cost becomes a problem before revenue does, ration the kinder replay (first N per
user per month) rather than cutting the feature that differentiates the product.

**Manual WhatsApp caps the trial at roughly 200 users.** That's fine — it's a trial, and the manual
loop is deliberately chosen. But past that it stops being a choice and becomes a wall, and the
Business API becomes unavoidable.

---

## Sequence

1. **Phase 0** — nothing public ships before this. It's the difference between "no incidents" and
   "no exposure."
2. **Phase 1** — the scoring engine. Everything downstream displays its output, so it lands before
   the UI is rebuilt around it.
3. **Phase 2** — async jobs + WhatsApp delivery. This is what makes 30-minute audio possible at all.
4. **Phase 3** — the funnel: intro video, phone handshake, one mode, reordered walk-through,
   admin v2.
5. **Then** — real-voice replay (R2/R4 from `docs/replay-rive-briefs.md`): replace the Web Speech
   API capture with `MediaRecorder`, and build the two-act narrative (their real voices → the
   kinder version). The 2-day retention decision exists specifically to make this possible.

Execution rule unchanged: **one agent per file**. `web/app.html` is touched by P0-T1, P0-T3, P0-T4,
P0-T6, P2-T2, P2-T4, P3-T3 and P3-T4 — those must run sequentially as one agent, never in parallel.
`backend/server.js` has the same constraint. The new `backend/scoring/*` files are collision-free
and can run alongside.

---

## Verification

- **Scoring:** `backend/eval/` runner — 20 golden conversations × 5 runs, asserting identical
  displayed composites and ±3 on near-identical inputs. This is the gate on Phase 1.
- **Security:** curl each money-spending endpoint with no token, a guest token, an over-quota user,
  and a suspended user — expect 401/403/402-style refusals, never a provider call.
- **Pipeline:** upload a real 30-minute file, close the browser, confirm the job completes, the
  admin queue shows it, the `wa.me` link opens, and the report requires sign-in.
- **Retention:** confirm the audio object is gone at 48 hours, including across an instance sleep.
- **Funnel:** fresh browser → intro → skip at 5s → email OTP → phone → WhatsApp code → admin
  verifies → Relationship Analysis only → paste → report → walk-through opens on the replay.
