# Architecture

## The shape of it

```
Browser (static HTML, no framework, no build step)
   │  Supabase JWT in Authorization, or a signed guest token in x-guest-token
   ▼
Render — backend/server.js (Express)          ← holds EVERY secret
   ├─ Deepgram   nova-2, diarize=true         → transcript + per-turn timings
   ├─ Groq       openai/gpt-oss-120b          → the whole analysis, in ONE call
   ├─ ElevenLabs eleven_multilingual_v2       → one mp3 per spoken replay line
   └─ Supabase   ap-south-1 (Mumbai), RLS on  → all persistence
```

The browser never holds a provider key. That is the single most important structural property of
this system, and it is why the backend exists at all.

**Hosting.** Frontend on Vercel (`samvaad-mu.vercel.app`), backend on Render
(`samvaad-backend-gyk9.onrender.com`). The Render URL is baked into the frontend as a default, so
users never configure anything; `localStorage['samvaad.beUrl']` overrides it for local work.

**Why one 1,300-line `server.js`.** It is deliberate, not neglect. The whole backend fits in one
reading, there is no module graph to hold in your head, and the file is organised top to bottom in
the order a request flows. Split it when it stops fitting in one reading, not before.

---

## Authentication and principals

Two kinds of caller, unified behind one idea:

- **User** — a Supabase Auth account (magic link or 6-digit OTP, via GoTrue REST; there is no
  Supabase JS SDK in the browser). The session lives in `sessionStorage`, per-tab, deliberately
  not `localStorage`: data minimisation.
- **Guest** — a short-lived HMAC token the backend issues from `POST /api/guest`, signed with
  `GUEST_SECRET`. Guests get the full product and persist nothing.

`getPrincipal(req)` resolves either into `{kind, id}`. `requirePrincipal` guards every endpoint
that spends money and 401s without one. Guest issuance can be switched off entirely from the admin
console (`app_settings.guest_enabled`).

**`forUser(table, principal)`** exists because the service-role key bypasses Row Level Security.
Every user-scoped query goes through it so the `user_id` filter cannot be forgotten. One
forgotten filter would leak every user's private analysis; the signed-in funnel test asserts this
holds.

---

## Endpoints

| Endpoint | Auth | Notes |
|---|---|---|
| `GET /health` | none | liveness |
| `GET /api/config` | none | the only public endpoint. Switches + input limits, nothing else. The pre-login pages need it before a principal exists. |
| `POST /api/event` | none | product analytics. Closed list of event names, payload capped, per-IP rate limit. |
| `POST /api/guest` | none | issues a signed, expiring guest token |
| `POST /api/transcribe` | principal | Deepgram; returns `transcript` **and** `turns[{speaker,start,end,text}]` |
| `POST /api/analyze` | principal | one Groq call; persists to `sessions` + `consents` when signed in |
| `POST /api/tts` | principal | ElevenLabs, one line at a time |
| `POST /api/feedback` | user | the `{context → intervention → outcome}` signal |
| `GET /api/history` | user | past sessions, used to rebuild the dashboard on load |
| `GET /api/me` | principal | status, allowance, act-1 variant, feature flags, **the real input limits** |
| `POST /api/profile/phone` | user | phone as the account key; unique, normalised to `91XXXXXXXXXX` |
| `POST /api/optin` | user | WhatsApp check-in consent ledger. **Stub: stores consent, sends nothing.** |
| `GET /api/admin/kpis` | admin | funnel, activity, quality, the act-1 experiment, capacity, intro funnel |
| `GET /api/admin/users` | admin | every account with its levers |
| `PATCH /api/admin/users/:id` | admin | status, allowance, minutes, resets, per-user flags |
| `GET/PATCH /api/admin/settings` | admin | the global switches |
| `GET /api/admin/schema` | admin | is the database up to date, and if not, exactly what is missing |
| `GET /api/admin/nudges` | admin | consented WhatsApp list + suggested message |

Admin is an allowlist of Supabase user ids in the `ADMIN_USER_IDS` environment variable. There is
no admin role in the database, on purpose: it cannot be escalated into.

---

## The analysis

One Groq call returns the entire report. The response schema (`ANALYSIS_SCHEMA` in `server.js`)
carries:

- `scores` — connection, empathy, escalation_risk, overall, each 0-100
- `summary`, `speakers` (name + inferred gender per side), `kpis`
- `patterns` (max 4), `strengths` (max 4), `improvements` (max 3)
- **`original`** (max 8 turns) — the pivotal stretch **verbatim** from the transcript. This is
  act 1 of the walk-through.
- **`improved`** (max 8 turns) — the same stretch replayed kindly. Act 2.

Every model output passes through `sane()`, which clamps scores, bounds array lengths, and maps
free-text emotion/gender/speaker values onto the small vocabularies the UI can render. Read
[03-DECISIONS.md](03-DECISIONS.md) before touching the schema — the absence of enums in it is
deliberate and hard-won.

**Token budget.** Groq charges the *reservation* (`prompt + max_tokens`) against a per-minute
ceiling, not actual usage. One analysis reserves roughly 3,700 of the free tier's 8,000, so about
two fit per minute across the whole cohort. A `tpmReserve()` governor queues a third rather than
letting it fail, and returns a calm 503 if the wait would exceed 45 seconds. Every user-facing
length limit is **derived** from `GROQ_TPM` and served through `/api/me`, so the copy can never
promise more than the backend can read.

---

## Database

Seven tables, all in Supabase (`ap-south-1`, Mumbai, for India DPDP data residency). RLS is on
everywhere.

| Table | Purpose | RLS |
|---|---|---|
| `sessions` | one row per analysed conversation, including `original`, `improved`, `speakers`, `act1_mode` | own rows only |
| `feedback` | did they say they would try the suggested line | own rows only |
| `consents` | the attestation for a recording containing a second person | own rows only |
| `nudge_subscriptions` | WhatsApp check-in opt-ins, the user's own number only | own rows only |
| `profiles` | status, trial allowance, minutes, feature flags, phone | **read own, write never** |
| `app_settings` | the switches the admin console flips | service role only |
| `events` | product analytics, mainly the intro funnel | service role only |

`profiles` is readable by its owner and writable by nobody: status, quota and feature flags are
the admin's to set, and the backend writes them with the service role. A user cannot raise their
own limits, and the signed-in funnel test proves it.

`backend/migrations/000-bring-schema-current.sql` is idempotent and brings any state to current.
It ends with `notify pgrst, 'reload schema'`, which is what clears Supabase's
*"Could not find the table … in the schema cache"* error without waiting or restarting.

---

## The frontend

Static HTML with inline CSS and JS. No framework, no bundler, no build. Open a file, read the
whole feature. This is a deliberate constraint that has kept the project fast to change.

- **`index.html`** — routes a first-time visitor to `intro.html`, everyone else to `login.html`.
- **`intro.html`** — the animated introduction. The two Rive rigs introduce the product
  themselves, lip-synced to real ElevenLabs narration, six scenes, ~45 seconds. Opens on a poster
  with a play button because browsers refuse to autoplay audio. Emits a full funnel of events
  (started, per-scene, muted, audio-blocked, completed/skipped) using `sendBeacon` so a skip that
  navigates away still counts. `?film=1` strips the interactive chrome; that is how
  `docs/media/samvaad-intro.mp4` was recorded.
- **`login.html`** — magic link, OTP, guest. **The canonical design reference**: when in doubt
  about how something should look, look here.
- **`app.html`** — the product. Four views (Home, Analyse, Insights, You), the breathing overlay,
  the walk-through overlay, and the replay engine.
- **`admin.html`** — two tabs. Metrics (funnel, act-1 experiment, capacity, intro funnel) and
  People (pause, suspend, raise limits, reset counts, pin a tester to an act-1 variant). Not
  linked from anywhere; gated by `ADMIN_USER_IDS`.

### The walk-through

The intentional order, which should not be shuffled without a reason:

1. The score and a one-line summary
2. Breathing — but **only** when escalation actually ran high, so it means something
3. **Act 1: the conversation as it actually happened**, in their own words
4. What went wrong
5. What to say instead
6. What they did well
7. **Act 2: the same moment, kinder**
8. The daily check-in offer

Breathing is reachable from every slide, not only its own. Both replays run *inside* the
walk-through rather than sending the user to another screen.

### The replay engine

Two Rive rigs (`web/rive/samvaad_{female,male}.riv`), each exposing `expNum` (expression) and
`phonemeNum` (mouth shape) through a state machine or a ViewModel. `talkStart()` runs an
`AnalyserNode` over the playing audio and drives `phonemeNum` from its RMS, with randomised holds
and real closures so it never looks robotic.

The engine plays whichever **track** it is handed — `S.original` for act 1, `S.improved` for act 2
— through the same `buildScene → advance → speak` path. Act 1 has three switchable deliveries
(`voiced`, `real_audio`, `silent`) which are being A/B tested per account; see
[04-STATE.md](04-STATE.md).

**Names to preserve** if you refactor: `buildScene`, `advance`, `speak`, `speakEleven`,
`speakBackend`, `stopReplay`, `setNP`, `spk`, `stripSpk`, `replayWorth`, `trackOf`, `startAct1`,
`startAct2`, `S._alt`, `S._nm`, and the ids `#stage #scene #bubbles #playBtn #muteBtn #prog
#npLive`. The `report.speakers` contract picks which rig each person gets.

---

## Design system

Locked. Do not drift.

- Action colour **cherry `#C8324B`**, deep `#A52741`. Self mode accent plum-mauve `#9E6A86`.
  Risk brick `#C0463C`.
- Type: **Fraunces** (serif headings) + **Mulish** (body) + **Noto Sans Devanagari**.
- Glassmorphism cards, pastel gradients, a single-continuous-line lotus signature.
- `web/login.html` is the reference implementation of the look.
