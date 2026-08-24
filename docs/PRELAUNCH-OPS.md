# Samvaad — pre-launch trial: what you have to do by hand

_Written 2026-08-24. Everything in the code is done and tested. This file is only the list of
things that live in a dashboard and therefore could not be done from here._

Work top to bottom. Nothing below step 4 matters until steps 1 to 4 are done.

---

## 1. Renew the Groq key and set the new model  *(blocking: analysis is dead without it)*

Groq announced on 2026-06-17 that `llama-3.1-8b-instant` and `llama-3.3-70b-versatile` were
deprecated, and stopped serving them during August 2026. Requests now come back
`model_decommissioned`. That is the failure you were seeing, on top of the expired key.

1. https://console.groq.com/keys → create a new API key.
2. Render → `samvaad-backend` → Environment, and set:

   | Key | Value |
   |---|---|
   | `GROQ_API_KEY` | the new key |
   | `GROQ_MODEL` | `openai/gpt-oss-120b` |
   | `GROQ_TPM` | `8000` |

3. Save. Render redeploys on its own.

**Why gpt-oss-120b.** It is Groq's own recommended replacement for the 70B model, and unlike it,
it supports **strict `json_schema`** output. That mattered more than the model swap itself: the
analysis used to be two Groq calls, split apart to stop the JSON getting truncated. Strict schemas
made that split unnecessary, so it is now one call, and one call gets the whole per-minute token
budget instead of half of it.

**What that means for length.** Groq counts prompt plus reserved output against a tokens-per-minute
ceiling. On the free plan gpt-oss-120b gets 8,000 TPM:

| | words | speech |
|---|---|---|
| Two calls (the old design) at 8,000 TPM | ~600 | ~4 min |
| One call (now) at 8,000 TPM | **~2,030** | **~13 min** |

Every user-facing limit is derived from `GROQ_TPM`, never typed into the copy. Raise that one
variable after upgrading the Groq plan and the app immediately offers longer conversations, with
no code change and no new deploy of the frontend.

Free tier also caps you at **200,000 tokens/day**, which is roughly **35 to 40 analyses per day
across the whole cohort**. Fine for ten to twenty testers. It is the thing that will break first
if the trial grows.

---

## 2. Run the two SQL migrations  *(blocking: no per-user control without them)*

Supabase → SQL Editor → run each file's contents once, in order:

1. `backend/migrations/001-phase0.sql` — run this **if you have not already**. It creates
   `profiles` and `app_settings`. (It shipped in the last commit; run it if you never did.)
2. `backend/migrations/002-prelaunch.sql` — new. Adds `sessions.original` and
   `sessions.act1_mode`, seeds the admin switches, adds two indexes.

Both are guarded and safe to re-run. The backend degrades gracefully if they have not run (quotas
simply go unenforced), so it will not crash at you — it will just quietly not work.

---

## 3. Make yourself the admin  *(blocking: the console 403s until you do)*

1. Sign in to the app once with the email you want as admin.
2. Supabase → Authentication → Users → copy your user's UUID.
3. Render → Environment → `ADMIN_USER_IDS` = that UUID. Comma-separate for more than one.
4. Open `https://<your-vercel-domain>/admin.html`.

It is deliberately not linked from anywhere. Bookmark it.

---

## 4. Pin the origin and the guest secret

| Key | Value | Why |
|---|---|---|
| `ALLOWED_ORIGIN` | your exact Vercel URL, e.g. `https://samvaad.vercel.app` | Currently `*`. The backend logs a warning on every boot. |
| `GUEST_SECRET` | any long random string | Signs guest tokens. Without it guest mode is off (which may be what you want). |

---

## 5. Confirm SMTP is actually working

You said custom SMTP is set up. Verify it rather than assume: request a sign-in code ten times in
ten minutes from ten different addresses. Supabase's built-in mailer rate-limits hard and the
failure is silent, which is exactly the kind of thing that eats the first day of a trial.

---

## 6. Decide the guest switch before you invite anyone

Admin console → Metrics → Settings → **Guest access**.

Leave it on while you are testing. Turn it off before the invites go out: guests get the full
product with no persistence, so a guest tester generates cost and produces no retention data,
which is the only data this trial exists to collect.

---

## 7. Run the act-1 A/B

The walk-through now opens by replaying the real conversation. Three ways to deliver it are built
and switchable:

| Variant | What the tester sees |
|---|---|
| `voiced` | The avatars speak the couple's own lines through ElevenLabs |
| `real_audio` | Their actual recording plays, matched to the lines using Deepgram's turn timings. Falls back to `voiced` for pasted text, and for any line it cannot confidently match |
| `silent` | Avatars animate, lines appear as bubbles, no audio at all |

To test both against each other as you asked:

1. Admin → **People** → find your first account → set **Act 1** to `voiced`.
2. Sign up with a second email → set that account's **Act 1** to `real_audio`.
3. Run the same conversation through both. `real_audio` only differs when you **upload audio**;
   with a pasted transcript it deliberately behaves as `voiced`.
4. Admin → Metrics → **Act 1: which opening works** compares them on the one outcome that matters:
   the share of people who answered "yes" to *will you try this line?*

Each session records which variant was live when it ran, so the comparison stays readable even
after you change the default. Change the default for everyone in Settings → **Act 1 default**.

When one wins, tell me and I will delete the other two paths.

---

## 8. Things I could not verify from here

- I could not run a real analysis end to end, because the Groq key is dead. The request path,
  auth, quotas, caps and error handling are tested; the **shape of a real Groq response against
  the new strict schema is not**. First thing to do after step 1 is run one analysis and check
  that the report and both replay tracks populate.
- I could not test `real_audio` against a real recording, because that needs Deepgram turn
  timings from a live transcription. The matcher declines rather than guesses (it needs half the
  content words of a line to match a turn), and falls back to `voiced` if fewer than half the
  lines match, so the worst realistic case is that it quietly behaves like `voiced`.
- SMTP, Render env vars and the Supabase dashboard are all yours.

---

## Quick reference: what changed in this pass

**Backend** (`backend/server.js`)
- Groq model is env-driven; decommissioned-model and bad-key failures now log a sentence that
  tells you what to go and fix, instead of a bare 400.
- One analysis call with a strict schema, replacing two. Temperature 0 and a fixed seed, so the
  same conversation stops scoring differently on a re-run.
- Analysis also returns `original`: the pivotal stretch of the real conversation, verbatim.
- New: `GET /api/config` (public, switches only), `POST /api/profile/phone`,
  `GET /api/admin/users`, `PATCH /api/admin/users/:id`, `GET|PATCH /api/admin/settings`.
- `/api/me` now returns the real input limits, the account's act-1 variant, and whether "Just me"
  is open for them.
- Admin KPIs rebuilt around the trial funnel. The solo-to-couple conversion rate is gone: with a
  single Relationship mode there is no solo session to convert from, so it could only ever have
  read zero.

**App** (`web/app.html`)
- One intent, **Relationship**, always a two-person exchange (both names and consent required).
  "Just me" is intact and hidden behind a flag, not deleted.
- Walk-through reordered: score, breathe if it was heated, **the real conversation played back**,
  **what went wrong**, **what to say instead**, what you did well, the kinder version, check-in.
- Breathing is now reachable from every slide, not only the one where escalation earned it.
- Both replays run inside the walk-through instead of throwing you out to another screen.
- The dashboard no longer forgets everything on reload: `/api/history` is finally wired in.
- Every length limit in the copy comes from the backend.

**New** `web/intro.html` — the animated how-it-works shown once before login, skippable, and
switchable off from the admin console. Built in CSS and SVG rather than as an MP4: nothing to
host, nothing to buffer on a phone, and the copy is editable without re-rendering a film.

**Admin** (`web/admin.html`) — two tabs. Metrics for the funnel, the act-1 comparison, capacity
and quota. People for pausing, suspending, raising limits, resetting the month, and pinning a
tester to one act-1 variant.
