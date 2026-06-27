# Samvaad — project context (read me first)

This file is auto-loaded into every Claude Code session in this directory. It is the
handoff from the chat where Samvaad was designed and prototyped. Treat it as the source
of truth for decisions already made.

## What Samvaad is
A wellness-leaning web app for the Indian market (Hinglish + Devanagari) that helps people
understand their conversations. A user records / uploads / pastes a conversation and gets:
1. A **report** — scores, the patterns underneath, what each person did well, and exact
   lines to try next time ("scripts").
2. An **intervene layer** — three things, in the order a person actually needs them:
   - **Breathe**: a guided breathing exercise (inhale → hold → exhale → soften). Becomes
     prominent automatically when escalation risk is high.
   - **Scripts**: verbatim better lines.
   - **Replay**: a voiced, animated avatar replay of a kinder version of the conversation.

### Modes
- **Relationship** (pinkish palette) — `couple` (two people, consent required) or `solo`
  (one person describing a relationship situation).
- **Self / Introspection** (warm palette) — one person reflecting; cool-down + focus-on-self
  tone. A companion mascot "Sathi" reflects back.
The two modes cross-fade smoothly (background + accent swap on `body[data-mode]`).

## Design system (locked — do not drift)
- Soft wellness aesthetic from a reference meditation app: pastel gradients, **glassmorphism**
  cards (`backdrop-filter: blur`), single-continuous-line **lotus** signature, floating ochre
  birds / gold arcs.
- Type: **Fraunces** (serif headings) + **Mulish** (body) + **Noto Sans Devanagari**.
- Action color = **cherry** `#C8324B` (deep `#A52741`) — constant across both modes. (Was
  ochre `#C79A60`; redesigned 2026-06-27 because the warm-earth palette read as a meditation/
  "adhyatma" app, wrong for a couples product.) Relationship accent = cherry + warm blush-rose.
  Self accent = dusty plum-mauve `#9E6A86` (was amber). Risk/error = brick `#C0463C`.
- The login page (`web/login.html`) is the canonical reference for the look. The main app
  (`web/app.html`) already matches it.

## Architecture
Browser (static HTML) → **Node/Express backend proxy** (holds ALL secrets) → external APIs.
The browser must never hold provider secrets. The proxy is the key fix vs. the early demo.

- **STT (audio → text):** Deepgram `nova-2`, `diarize=true`. (One-time $200 credit.)
- **Analysis brain:** Claude API, model string **`claude-sonnet-4-6`**. Two-step call:
  (1) report JSON, (2) improved-conversation JSON — split to avoid truncation.
- **TTS (voices):** ElevenLabs `eleven_multilingual_v2` (good Hindi/Indian voices). Use a
  key **scoped to Text-to-Speech only**, with a monthly character cap, sent via `xi-api-key`
  header, server-side only. Free tier = 10k chars/mo (no PAYG overage until Starter $5/mo).
- **DB / Auth / Storage:** Supabase free tier (see live resources). Row-Level Security so a
  user only sees their own rows.
- **Payments:** Razorpay — deferred, not built yet.
- **Hosting:** Render / Railway / Vercel free tiers.

## Live resources already provisioned (real)
- **Supabase project `samvaad`** — region `ap-south-1` (Mumbai, for India DPDP residency).
  - project ref: `bwcszkbtvbvwzioycxxp`
  - URL: `https://bwcszkbtvbvwzioycxxp.supabase.co`
  - Publishable (browser-safe) key: `sb_publishable_1Ks92vUbYplxWzveOT7BtQ_seHUf3cW`
  - Tables (RLS on, policies lock rows to `auth.uid() = user_id`): `sessions`, `feedback`,
    `consents`. Schema mirrored in `backend/schema.sql`.
  - **service_role key** (backend secret) is NOT in this repo — copy it from the Supabase
    dashboard → Project Settings → API into `backend/.env` as `SUPABASE_SERVICE_KEY`.
  - TODO in dashboard: create a **private Storage bucket `audio`**; add an SMTP provider for
    auth emails; set the email template to include `{{ .Token }}` if using OTP codes.
- **Figma file** "Samvaad — Avatar & Expression Sheet": fileKey `uswu4pwbGQ7FtRp0nufkDn`
  (3 characters × 7 expressions, Rive-ready).

## File map
- `web/login.html` — magic-link / OTP login (Supabase Auth via REST, no SDK). Design reference.
- `web/app.html` — the main app (modes, inputs, analysis, intervene layer, dashboard).
  Set a **Backend URL** in its Settings drawer to route through the proxy; otherwise it runs
  standalone with keys pasted into Settings (demo only).
- `backend/server.js` — Express proxy: `/api/transcribe` (Deepgram), `/api/analyze`
  (Claude ×2 + persist to Supabase), `/api/tts` (ElevenLabs), `/api/feedback`, `/api/history`,
  `/api/optin` (WhatsApp daily check-in opt-in — **stub**, stores to `nudge_subscriptions`, no
  provider wired yet; user's own number only, DPDP-clean). Verifies the Supabase JWT via
  `getUser`. All secrets from env.
- `backend/.env.example` — copy to `backend/.env` and fill in. `SUPABASE_URL` is pre-filled.
- `backend/schema.sql` — the exact tables/RLS already applied to the live DB.
- `docs/_archive-*.html` — superseded prototypes, for reference only.

## Compliance posture (India DPDP Act 2023 + 2025 Rules)
Consent-first; purpose limitation; auto-delete raw audio after transcription; two-party
consent for couple recordings; no under-18 without parental consent; RLS everywhere; Mumbai
data residency. Keep all framing as **wellness awareness, not medical diagnosis**. Voice
biomarker KPIs (pitch/jitter/rate) are staged for later, not implemented.

## Next steps (suggested order)
1. `cd backend && npm install`, copy `.env.example` → `.env`, fill keys, `npm start`.
2. Create the free accounts: Deepgram, ElevenLabs, Anthropic (each has a no-card free start).
3. Wire **login → app** handoff (pass the Supabase session to `app.html`; gate on auth).
4. In the Supabase dashboard: create the private `audio` bucket; configure auth email
   (SMTP + `{{ .Token }}` template).
5. Deploy backend (Render/Railway), set the app's Backend URL to the deployed origin.
6. Later: dashboard "patterns over time" visualization; smarter breathing (4-7-8 vs box);
   feedback → contextual-bandit recommender ({context → intervention → outcome}); Razorpay.

## Guardrails for the agent
- NEVER commit secrets. Keys live in `backend/.env` (git-ignored). The publishable/anon
  Supabase key is public by design and may appear in frontend code; the service_role key
  must not.
- Keep the model string `claude-sonnet-4-6` unless deliberately upgrading.
- Preserve the design system above; don't replace the aesthetic.
