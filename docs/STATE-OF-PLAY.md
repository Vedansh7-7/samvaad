# Samvaad — State of Play

_Written 2026-08-10 by reading the whole repo (code, not docs) at commit `f8b2775`.
Purpose: one place that says what actually exists, what the docs claim that the code doesn't do,
and what the real next decisions are. Where this file and `CLAUDE.md` / `ROADMAP.md` disagree,
**this file describes the code**._

---

## 1. The product in one paragraph

Samvaad takes a conversation (typed, recorded, or an uploaded audio file), transcribes it,
analyses it with an LLM through a Gottman-method lens, and returns a **report** (scores,
patterns, strengths, verbatim "scripts") plus an **intervene layer** (guided breathing → scripts
→ a voiced, animated avatar replay of a kinder version). Three intents: **Us two** (couple,
consent required), **A relationship** (solo), **Just me** (self/introspection, reframed as
"say these out loud" affirmations with a companion, Sathi). Hinglish + Devanagari first-class.
Wellness framing throughout. India / DPDP posture throughout.

Strategic thesis (from `ROADMAP.md`, still correct): the product is feature-rich; the open
question is **whether strangers will pay and return**. Everything should be judged against that.

---

## 2. Architecture as built

```
Browser (static HTML, no framework, no build step)
  │  Supabase JWT in the Authorization header (auth.js, REST only — no SDK)
  ▼
Render: Node/Express proxy  backend/server.js   ← holds ALL secrets
  ├─ Deepgram  nova-2, diarize=true      → transcript + per-turn timings
  ├─ Groq      llama-3.3-70b-versatile   → report JSON, then improved-conversation JSON
  ├─ ElevenLabs eleven_multilingual_v2   → mp3 per replay line
  └─ Supabase (ap-south-1 Mumbai, RLS)   → sessions, feedback, consents,
                                            nudge_subscriptions, founding_members
Frontend hosting: Vercel.  Backend: https://samvaad-backend-gyk9.onrender.com (baked in as default)
```

Auth: Supabase magic-link / 6-digit OTP via GoTrue REST. Session lives in **sessionStorage**
(per-tab, deliberately not localStorage — data-minimisation). Guest mode is a flag; guests get
the full app with **no persistence**.

### Endpoint inventory (`backend/server.js`, 279 lines)

| Endpoint | Auth | Notes |
|---|---|---|
| `POST /api/transcribe` | none | Deepgram; returns `transcript` **and** `turns[{speaker,start,end,text}]` |
| `POST /api/analyze` | optional | 2 LLM calls; persists to `sessions` + `consents` only if a JWT is sent |
| `POST /api/tts` | none | ElevenLabs; surfaces upstream error detail |
| `POST /api/feedback` | optional | inserts into `feedback` |
| `GET  /api/history` | required | **exists but the frontend never calls it** — see §4.1 |
| `POST /api/optin` | optional | WhatsApp consent ledger; **stub, sends nothing** |
| `POST /api/founding` | none (public) | writes `founding_members` |
| `GET  /api/admin/kpis` | `ADMIN_USER_IDS` allowlist | + live ElevenLabs quota |
| `GET  /api/admin/nudges` | `ADMIN_USER_IDS` allowlist | consented list + suggested message |
| `GET  /health` | none | |

### Page inventory (`web/`)

| File | Lines | State |
|---|---|---|
| `login.html` | 305 | Polished; canonical design reference. Magic link + OTP + guest. Links to `privacy.html`. |
| `app.html` | 1054 | The whole app: 4 views (Home / Analyse / Insights / You), breathing overlay, walk-through overlay, Rive replay engine. New UI + responsiveness pass done. |
| `admin.html` | 179 | Functional KPI + nudge dashboard. **Not linked from anywhere.** Needs design polish. |
| `founding.html` | 343 | ₹199 pre-sell page. Functional form. **Not linked from anywhere. Pay button is disabled.** |
| `privacy.html` | 66 | Simple, fine. |
| `index.html` | 15 | Redirect to `login.html` (Vercel `/` entry). |
| `rive-test.html` | 193 | Rig test harness (dev). |
| `auth.js` | 145 | Shared SDK-free auth helper. Publishable anon key only — correct. |
| `web/rive/*.riv` | 2 files | `samvaad_female.riv`, `samvaad_male.riv` — data-bound `expNum` / `phonemeNum`. |

---

## 3. Feature status — what actually works

**Working end to end**
- Three intents with palette cross-fade on `body[data-mode]`; sample loader for each.
- Paste transcript → analyse → score → guided walk-through → dashboard.
- Upload audio → Deepgram diarized transcript → analyse.
- Report: score ring, signals chips, "what went well" / "watch for" (auto-hidden when the
  exchange is healthy — the model is instructed not to pad), scripts, feedback chips.
- Escalation-aware breathing: `escalation_risk >= 60` promotes a breathe banner, pulses the
  walk-through CTA, and inserts a breathing slide into the walk-through.
- Replay: Rive avatars, gender chosen from `report.speakers`, per-emotion expressions
  (`expNum`), audio-RMS lip-sync with randomised holds and real closures (`phonemeNum`),
  living-room backdrop, media-player chrome, `replayWorth()` gate that drops <2s clips,
  `stopReplay()` on tab change / "Analyse another".
- Robustness the code earned the hard way: speaker-label stripping (`stripSpk`), alternation
  fallback when the model labels every turn the same (`S._alt` / `spk`), Groq JSON-failure
  retry with backoff, name authority enforced in both prompts.
- Admin: real KPIs from `sessions`, founding count, opt-in count, solo→couple rate, live
  ElevenLabs character quota with an exhausted banner, one-tap `wa.me` nudge links.

**Built but inert**
- `GET /api/history` — server-side only; nothing calls it (§4.1).
- WhatsApp check-ins — the consent ledger fills up; no provider, no scheduler, no message sent.
- Founding pre-sell — the page works, but `RAZORPAY_LINK = ""` so the CTA renders as a
  disabled "Payment link coming soon". **No one can currently pay.**

**Not built (claimed or planned)**
- E1 — "Your data" view/export/delete panel; data-flow transparency screen; explicit guest-vs-paid.
- E2-T1 — event logging (`events` table, `POST /api/event`). Admin KPIs are inferred from
  `sessions` rows only: no DAU, no retention, no completion rate, no walkthrough/breathe events.
- E3-T2 — "Share on WhatsApp" summary from a report (two tones).
- E4 — invite-partner prompt on solo/self reports. The solo→couple KPI is measured but nothing
  in the product nudges the conversion it measures.
- E5-T2 — monthly trajectory report (the intended subscription hook).
- Replay v2 briefs R2 / R4 / R5 (§4.3).

---

## 4. Findings — the things worth acting on

### 4.1 The dashboard forgets everything on reload  ← biggest one
`S.sessions` is initialised to `[]` and only ever appended to by `run()`. **`/api/history` is
never fetched.** Consequences for a signed-in user who reloads or comes back tomorrow:
- Insights view says "No sessions yet"; the trend graph never draws.
- Home "Recent reflections" is empty; the streak chip resets to "New".
- Dashboard tiles are the only route to a full report (by design) — so past reports are
  unreachable.

The data *is* in Supabase. This is a one-function fix on the frontend plus a shape mapping
(`sessions` rows → the `{ts, mode, sub, a, b, overall, pattern, full}` shape the UI expects).
For a product whose entire thesis is **retention**, "your history disappears" is the wrong
first impression. I'd put this at the top of the list.

Related: `sessions` has no `speakers` column, so a report restored from the server would lose
the gender mapping the replay uses. Add the column (or nest it into `kpis`/a new `jsonb`) when
wiring history.

### 4.2 The docs name three different analysis models
- `CLAUDE.md` + `README.md`: Claude `claude-sonnet-4-6`.
- `backend/server.js`: Groq `llama-3.3-70b-versatile` (in a function still named `claude()`).
- `render.yaml` comment: "Mixtral-8x7B".

The running system is **Groq llama-3.3-70b-versatile**. Worth deciding deliberately: Groq is
free/fast, and the prompts have been hardened around its failure modes (JSON 400s, same-speaker
labelling, name drift). Moving to a Claude model would likely improve report nuance and let you
drop several defensive hacks — but it costs money per analysis and the retry/repair code would
need revisiting. Either way, one string should be true in all four places.

### 4.3 Recording still drops the second speaker
`app.html` line 641 uses the Web Speech API (`SpeechRecognition`). It is single-speaker: for a
**couple** recording it merges both voices into one unlabelled stream. Upload does it correctly
(Deepgram, diarized). This is exactly the bug `docs/replay-rive-briefs.md` R2 was written to
fix; R1 (server-side `turns`) and R3 (Rive engine) shipped, **R2 / R4 / R5 did not**. So the
"real voices reflection" narrative arc (Act 1 real audio → Act 2 kinder version) — described in
the briefs as the USP — does not exist yet; only the kinder-version act is built.

### 4.4 The paid-cohort funnel has no entry and no exit
`founding.html` is not linked from `login.html`, `app.html`, or `index.html`, and its pay CTA is
disabled. So Phase A's stated goal ("10 paying strangers") is blocked on two small things: paste
a Razorpay link into `founding.html`, and give the page a route in. `admin.html` is likewise
unlinked (fine as a secret URL, but you must also set `ADMIN_USER_IDS` on Render — until then
every admin call 403s).

### 4.5 The expensive endpoints are open to the internet
`/api/transcribe`, `/api/analyze`, and `/api/tts` accept unauthenticated requests by design
(guest mode). `ALLOWED_ORIGIN` sets a CORS header, which browsers honour and scripts do not.
Anyone who finds the Render URL can burn your Deepgram credit, Groq quota, and the 10k/month
ElevenLabs characters. Nothing has gone wrong yet, and the mitigation is small (per-IP rate
limit, a size cap, maybe requiring a JWT or a signed guest token) — but it's the kind of thing
that ruins a demo week.

Two smaller notes in the same area:
- `express.json({limit:'25mb'})` with base64 audio caps uploads at roughly 18 MB of real audio,
  and the failure surfaces as a generic error.
- `POST /api/founding` is public and unvalidated beyond the phone regex — spammable.

### 4.6 The feedback insert is probably failing silently
`app.html` posts `asked_at: Date.now()` (a millisecond integer) into a `timestamptz` column, and
`/api/feedback` neither checks nor logs the Supabase error. So the "will you try this?" signal —
the `{context → intervention → outcome}` record the whole recommender idea rests on — may be
writing nothing. Worth verifying against the live table before building anything on top of it.

### 4.7 Dead code that reads as live
`app.html:700` defines a `claude()` that POSTs to `api.anthropic.com` with no API key and no
`anthropic-version` header. It's only reachable if `be()` is falsy, which it can't be (the Render
URL is baked in as the default). It would 401 if it ever ran. Same for the hidden `dgKey`/`elKey`
inputs and their standalone paths. Harmless today, misleading to the next reader, and a
resurfacing risk for the "never show users API-key fields" rule.

### 4.8 Documentation drift
- `E:\claude\Vocalis\CLAUDE.md` (parent) is a stale copy missing the roadmap and build-state
  sections that `samvaad/CLAUDE.md` has. Both auto-load. Consider deleting the parent copy.
- `backend/README.md` and `schema.sql` describe a private `audio` Storage bucket and a 24h purge
  job. Neither exists — audio is streamed through the request body and never persisted, which is
  actually the *stronger* DPDP position. The docs should say what the code does.
- `ROADMAP.md` marks E2-T2 done; the dashboard is real, but the KPI list it promises (DAU,
  D1/D7 retention, completion rate) is not computable without E2-T1 event logging.

---

## 5. What's locked (don't drift)

- **Design system**: cherry `#C8324B` / deep `#A52741` action colour, plum-mauve `#9E6A86` for
  self mode, brick `#C0463C` for risk; Fraunces + Mulish + Noto Sans Devanagari; glassmorphism,
  single-line lotus, pastel gradients. `login.html` is the reference.
- **Intentional flows**: post-analysis shows *only* a centred score + "✦ Walk me through it";
  finishing the walk-through lands on the Dashboard; full reports live behind dashboard tiles.
  Self mode says "Say these out loud", not "try saying".
- **Replay wiring**: `buildScene` / `advance` / `speak` / `speakEleven` / `speakBackend` /
  `stopReplay` / `setNP` / `spk` / `S._alt` / `S._nm` / `replayWorth`, ids `#playBtn` `#muteBtn`
  `#prog` `#scene` `#stage` `#npLive`, and the `report.speakers` contract.
- **Secrets**: only `backend/.env` (gitignored, verified untracked) and Render env vars. The
  Supabase publishable/anon key in `auth.js` is public by design.
- **Execution rule**: one agent per file — `app.html` collisions are real.

---

## 6. Where I'd go next — three coherent options

**A. Make it remember (repair the loop).**
Wire `/api/history` into boot, persist `speakers`, verify the feedback insert, add event logging
+ the KPIs that depend on it. Everything about retention is unmeasurable and unfelt until this
works. Cheapest work, largest effect on whether Phase A can even be evaluated.

**B. Open the paid funnel (finish Phase A).**
Razorpay link into `founding.html`, route users to it, set `ADMIN_USER_IDS`, custom SMTP so
sign-in isn't rate-limited, rate-limit the open endpoints so a shared URL can't be drained.
This is mostly configuration, not code — and it's what "10 paying strangers" is blocked on.

**C. Finish the replay USP (R2 → R4 → R5).**
Replace Web Speech with `MediaRecorder` + Deepgram so couple recordings actually diarize, then
build the two-act narrative (their real voices → the kinder version) that the briefs call the
differentiator. Highest craft value, highest effort, one sequential agent on `app.html`.

My read: **A, then B, then C.** A is small and unblocks judging anything; B is configuration
standing between you and the actual validation question; C is the thing worth building *once you
know people come back*.

---

## 7. Open questions for the founder

1. **Analysis model** — stay on Groq llama-3.3-70b (free, hardened prompts) or move to Claude
   (better nuance, per-call cost)? This decides whether several defensive hacks stay.
2. **Razorpay** — do you have a payment link yet? Without it Phase A cannot start.
3. **Guest mode** — keep the frictionless open-endpoint guest path (and pay for rate-limiting),
   or require sign-in before an analysis runs?
4. **Real-voice replay** — is the two-act "how it went → a kinder version" arc still the USP you
   want to build, or has the Rive kinder-replay alone become the product?
5. **Deployment truth** — is the Vercel frontend currently deployed and pointing at the live
   Render backend, and is `ADMIN_USER_IDS` set? Several findings above are "can't be used yet"
   rather than "broken" and I can't check the dashboards from here.
