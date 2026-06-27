# Samvaad — Roadmap & agentic execution plan
_Last updated 2026-06-27. Source: founder's plan PDF (projectSoundIntentandHealth2, 34pp) +
founder product directives + current shipped state. CLAUDE.md links here._

## 0. The one thing that matters (strategic thesis)
Samvaad is already feature-rich (analysis, breathe, scripts, replay, walk-through, solo mode,
WhatsApp opt-in). **The #1 risk is NOT more features — it is whether real strangers will PAY and
RETURN.** The PDF says this repeatedly: _"You're testing if people will do something that costs
them — money, time, or effort. Those are the only signals that matter."_ So the plan is
**validation-first**: instrument → get a small paid cohort of strangers → prove a retention loop →
only then scale features. The always-on voice-biomarker **wearable is explicitly parked** ("a
Series A conversation, not a day-one decision").

Bar to clear (from PDF): **answer "will people pay" in <30 days, <₹10,000 spend.** Strong signals =
20+ strangers at ₹199, or 10+ at ₹499, or 50+ ₹1-UPI tokens. **Friends paying means nothing.**

## 1. What's already shipped (don't rebuild)
Modes (couple/solo/self), Groq `llama-3.3-70b-versatile` analysis (report + replay), Deepgram
`nova-2` transcribe, ElevenLabs replay, breathing, guided walk-through slideshow, WhatsApp opt-in
**stub** (`/api/optin` + `nudge_subscriptions`), Supabase (RLS) persistence, login/guest auth,
deploy = Vercel (web) + Render (backend). See CLAUDE.md for the locked design/architecture.

**Shipped 2026-06-27 (this session):** Phase A largely done — `founding.html` (₹199 pre-sell,
`POST /api/founding` → `founding_members`), `admin.html` (KPIs + manual WhatsApp nudge list,
`/api/admin/kpis` + `/api/admin/nudges`, gated by `ADMIN_USER_IDS`), `privacy.html`. Post-analysis
flow restructured: centered "Walk me through it" → finish redirects to Dashboard → tappable tiles
open full reports (`openSession`). Self-mode "say aloud" reframing. Magic-link redirect fixed.
**Remaining for Phase A:** founder sets `ADMIN_USER_IDS` + Razorpay link + custom SMTP; then share
`founding.html` for paying strangers. **Next focus = UI polish (E6-T1) via impeccable.**

## 2. Epics (each task is written to be handed to a subagent)
IDs: E#-T# . Each task lists **Goal · Files · Approach · Done-when**. Backend = `backend/`,
frontend = `web/app.html` (coordinate — aesthetics agent also edits it).

### E1 — Trust & data transparency  (founder directive #1; PDF Module 5 "Privacy & Safety")
- **E1-T1 "Your data" panel (view + delete only, immutable).** Goal: a user-openable view of
  everything we store about them (sessions, opt-in, consents) that they can **view or delete,
  never edit** (append-only protects against manipulation; delete = DPDP right to erasure).
  Files: `web/app.html` (new "Your data" view under Account), `backend/server.js`
  (`GET /api/me/data` returns the user's rows; `DELETE /api/me/data` erases them + audio).
  Approach: read via service key scoped to `auth.uid()`; export button downloads a JSON file
  ("openable file" the founder asked for). Done-when: signed-in user sees their data, can export
  it, and can delete it; no edit path exists.
- **E1-T2 Data-flow transparency screen.** Goal: plain-language "where your data goes" (browser →
  proxy → Groq/Deepgram/ElevenLabs → Supabase Mumbai; audio auto-deleted after transcription;
  RLS). Files: `web/app.html` (a small info modal/section), `README.md`. Done-when: reachable from
  login + settings.
- **E1-T3 Guest aliasing made explicit.** Goal: guest sessions clearly aliased + "not saved"
  messaging; real customers validated by phone + Razorpay transaction id (link account ↔ payment).
  Files: `web/app.html`, `web/login.html`. Done-when: guest state visibly distinct; a paid user is
  flagged via stored transaction id.

### E2 — Measurement: event logging + Admin dashboard  (founder directive #2)
- **E2-T1 Event logging.** Goal: instrument the funnel. Events: `analysis_started`,
  `analysis_completed`, `walkthrough_opened`, `breathing_taken`, `optin_submitted`,
  `invite_partner_clicked`, `solo_to_couple`. Files: `backend/schema.sql` (new `events` table,
  RLS), `backend/server.js` (`POST /api/event`), `web/app.html` (fire events). Done-when: events
  land in Supabase keyed to user (or anon id for guests).
- **E2-T2 Admin dashboard + KPIs.** Goal: a protected admin view aggregating: DAU, analyses,
  completion rate, opt-in rate, **solo→couple conversion (core Phase-1 KPI per PDF)**, day-1/7
  retention, willingness-to-pay. Files: `web/admin.html` (new), `backend/server.js`
  (`GET /api/admin/kpis`, gated by an admin allowlist of user ids in env `ADMIN_USER_IDS`).
  Done-when: only allowlisted users see aggregated KPIs; numbers are real from `events`/`sessions`.

### E3 — Retention loop: WhatsApp (manual first, consented)  (founder directive #3; PDF GTM)
- Privacy note (answers founder's "would that be a breach?" worry): **manually messaging
  consented opt-in users is NOT a breach** — it's consent-based. Rules: only message users who
  ticked consent (`nudge_subscriptions.consent=true, active=true`), only their OWN number, honor
  STOP, log it. Never message partners or non-consenting users.
- **E3-T1 Admin "today's nudges" list.** Goal: so the founder can copy-paste-send daily to the 10
  cohort now (provider wired later). Files: `web/admin.html`, `backend/server.js`
  (`GET /api/admin/nudges` → consented active subscribers + a suggested message). Done-when:
  founder sees a daily send list with prefilled "how was your day?" / journal-nudge copy.
- **E3-T2 WhatsApp summary deliverable (two tones).** Goal: from any report, generate a WhatsApp-
  ready summary in **Warm & Encouraging** and **Direct & Concise** tones (PDF p23). Files:
  `web/app.html` (a "Share on WhatsApp" action on the report → `wa.me` link with prefilled text).
  Done-when: one tap copies/opens a formatted WhatsApp summary.
- **E3-T3 (later) Wire a provider** (Gupshup/Interakt/Twilio) + daily scheduler reading
  `nudge_subscriptions`. Implement the `TODO(provider)` in `/api/optin`. Deferred until the manual
  loop shows retention.

### E4 — Solo → Couple growth loop  (PDF: "your biggest acquisition channel")
- **E4-T1 Invite-partner prompt.** Goal: on every solo/self report, surface _"This is 3x more
  powerful with your partner's voice — invite them."_ Files: `web/app.html`. Fires
  `invite_partner_clicked` (E2-T1). Done-when: prompt appears in solo/self results + walk-through.
- **E4-T2 Conversion tracking + history carry-over.** Goal: track solo→couple conversion; when a
  solo user adds a partner, carry their history. Files: `backend/server.js`, `web/app.html`.
  Done-when: conversion event recorded; admin KPI (E2-T2) shows the rate.

### E5 — Monetization: founding pre-sell (validation)  (PDF Methods + India/UPI)
- **E5-T1 Founding-member CTA + Razorpay/UPI link.** Goal: a "Founding access ₹199" CTA that opens
  a Razorpay payment link; record the transaction id against the account (ties to E1-T3 real-
  customer validation). Files: `web/app.html`/`web/login.html`, optionally `backend` to record.
  Done-when: a stranger can pay and be marked a founding member. (Razorpay is in CLAUDE.md as
  deferred — this is the minimal first step, not full billing.)
- **E5-T2 Monthly report = the subscription hook** (PDF: "what turns it into something people pay
  monthly for"). Goal: a 30-day trajectory report (scores vs 30-day avg + verbatim scripts + one
  weekly focus). Files: `web/app.html` dashboard, `backend` history aggregation. Done-when: a
  returning user sees their month over time. (Build after retention is shown.)

### E6 — Quality & polish (in flight / continuous)
- **E6-T1 Premium replay + video tiles** — assigned to the impeccable/aesthetics agent (prompt
  already delivered). Preserve avatar-animation JS wiring.
- **E6-T2 Analysis quality on Groq.** Goal: confirm `llama-3.3-70b-versatile` output quality vs
  needs; tighten prompts; consider eval on 10 sample conversations. Files: `backend/server.js`.

## 3. Recommended sequencing
- **Phase A — Validate (this week):** E5-T1 (founding pre-sell) + E1-T3 (guest/paid) + E3-T1
  (manual nudge list) → push for **10 paying strangers** and a daily check-in. Answers "will they
  pay + come back."
- **Phase B — Instrument:** E2-T1 then E2-T2 (logging + admin KPIs). You can't improve what you
  can't see.
- **Phase C — Loops:** E4 (solo→couple) + E3-T2 (WhatsApp summaries) + E1-T1/T2 (trust).
- **Phase D — Scale:** E5-T2 (monthly subscription), E3-T3 (provider + scheduler), E6-T2, then
  revisit the wearable only with traction.

## 4. North-star KPIs
Solo→couple conversion rate (Phase-1 core), willingness-to-pay (paying strangers), D7 retention,
analysis completion rate, opt-in rate. Wire all into E2-T2.

## 5. How we execute (agentic mode)
- `/agents` (Claude Code) manages **custom subagent definitions** stored in `.claude/agents/`.
  We can define project agents (e.g. `samvaad-frontend`, `samvaad-backend`) so each has the right
  scope + instructions. Optional but tidy.
- Day-to-day, tasks above are run by spawning subagents (the Task/Agent tool) — one task per
  agent, **one agent per file** to avoid the app.html collisions we hit. Backend/admin tasks
  (E1-T1 backend, E2, E3-T1, E5) are collision-free and good first parallel work.
- Each task here is self-contained (Goal · Files · Approach · Done-when) so it can be pasted to an
  agent verbatim.
