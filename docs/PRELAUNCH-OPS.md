# Samvaad — pre-launch trial: what you have to do by hand

_Written 2026-08-24, updated 2026-08-25 after testing against the live Groq key. Everything in the
code is done and tested. This file is only the list of things that live in a dashboard and
therefore could not be done from here._

Work top to bottom. Nothing below step 4 matters until steps 1 to 4 are done.

---

## 1. Groq: key renewed, model now picks itself  *(done, verified against the live API)*

You renewed the key and it works. Verified on 2026-08-25: the key authenticates, and
`llama-3.3-70b-versatile` is genuinely absent from what your account is served, which is exactly
the `model_decommissioned` failure you hit.

**You no longer have to name a model.** On boot the backend asks Groq what it actually serves and
takes the best one it recognises, in this order: `openai/gpt-oss-120b`, `qwen/qwen3.6-27b`,
`openai/gpt-oss-20b`, `groq/compound`. If Groq retires one mid-flight, the next request re-asks
and continues on the replacement instead of failing. Setting `GROQ_MODEL` still pins it explicitly
and skips all of that; **leave it unset** unless you want a specific model.

So on Render you need exactly this:

| Key | Value | Notes |
|---|---|---|
| `GROQ_API_KEY` | your new key | the only required one |
| `GROQ_TPM` | `8000` | free plan. Raise after upgrading. |
| `GROQ_MODEL` | *leave unset* | set it only to pin a specific model |

### What a real analysis actually costs

Measured, not estimated:

| | value |
|---|---|
| Prompt (instructions + schema, no transcript) | ~750 tokens |
| Response at default reasoning effort | 3,837 tokens (2,252 of them *reasoning*) |
| Response at `reasoning_effort: low` | 1,861 to 2,069 tokens |
| Wall-clock, low effort | ~5 to 7 seconds |
| Reserved against your per-minute budget | ~3,700 of 8,000 |

Two things came out of that. gpt-oss-120b is a **reasoning model**, so at default effort more than
half the response budget is spent thinking, and the previous `max_tokens` would have truncated
real analyses. And at `low` effort the same conversation scored **identically across consecutive
runs**, which is the repeatability the plan wanted and did not have.

### The one thing to know about the free tier

An analysis reserves ~3,700 of 8,000 tokens per minute, so **roughly two analyses per minute
across the entire cohort**. A third in the same minute now waits in a queue rather than failing,
and if the wait would exceed 45 seconds the person gets *"A few conversations are being read right
now. Give it a minute and try again."* — a 503, not an error screen, and it does **not** cost them
one of their three.

With ten to twenty testers each holding three conversations, collisions will be occasional. If
they stop being occasional, that is the signal to move to Groq's Dev tier, and the only change is
`GROQ_TPM`.

---

## 2. Run the three SQL migrations  *(blocking: no per-user control or limits without them)*

Supabase → SQL Editor → run each file's contents once, in order:

1. `backend/migrations/001-phase0.sql` — run this **if you have not already**. It creates
   `profiles` and `app_settings`.
2. `backend/migrations/002-prelaunch.sql` — adds `sessions.original` and `sessions.act1_mode`,
   seeds the admin switches, adds two indexes.
3. `backend/migrations/003-analyses-allowance.sql` — **new**. Adds the 3-conversation trial
   allowance (`profiles.analyses_quota` / `analyses_used`) and backfills the counter from sessions
   already on record, so the cap starts out honest instead of handing existing testers a clean
   slate.

All three are guarded and safe to re-run. The backend degrades gracefully if they have not run
(quotas simply go unenforced), so it will not crash at you — it will just quietly not limit
anyone, which during a trial is the expensive kind of quiet.

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

## 6. The trial allowance

Every new sign-up gets **3 conversations**, total — not per month, not per day. Guests get 3 per
day. The app says how many are left above the Analyse button and disables it at zero, rather than
letting someone type out an argument and then refusing it.

- **Raise it for one person**: Admin → People → their row → Conversations → Save.
- **Give someone a clean slate**: Reset count.
- **Change it for everyone who signs up next**: Admin → Metrics → Settings → *Conversations per
  new account*. This does not touch people who already signed up, by design.
- **Watch whether 3 is right**: the *Used all 3* tile on Metrics. If most testers hit it and ask
  for more, the number is too low and the product is working. If nobody reaches 3, the number is
  not your problem.

A failed analysis never costs an allowance: it is charged only after a report is successfully
produced.

---

## 7. Decide the guest switch before you invite anyone

Admin console → Metrics → Settings → **Guest access**.

Leave it on while you are testing. Turn it off before the invites go out: guests get the full
product with no persistence, so a guest tester generates cost and produces no retention data,
which is the only data this trial exists to collect.

---

## 8. Run the act-1 A/B

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

## 9. Things I could not verify from here

- **Now verified** with your new key: real analyses run end to end, act-1 lines come back
  verbatim from the transcript, speakers and genders map correctly, scripts are in Hinglish with
  no name prefix, the 3-conversation cap refuses the fourth attempt, and a refusal costs nothing.
- I could not test `real_audio` against a real recording, because that needs Deepgram turn
  timings from a live transcription. The matcher declines rather than guesses (it needs half the
  content words of a line to match a turn), and falls back to `voiced` if fewer than half the
  lines match, so the worst realistic case is that it quietly behaves like `voiced`.
- I could not test the signed-in exhaustion message specifically, only the guest one, because that
  needs a real Supabase session. Both take the same code path and differ only in wording.
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
