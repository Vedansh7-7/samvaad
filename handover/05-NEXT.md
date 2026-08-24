# What to do next

The product is feature-rich and has no users. That asymmetry should drive every decision you make
in the first month. Almost nothing on this list is "build another feature".

---

## Week one: make it usable by someone who is not you

These are configuration, not code, and each one currently blocks a real tester.

1. **Set `ADMIN_USER_IDS`** on Render to your Supabase user id, or the admin console 403s and you
   are flying blind.
2. **Pin `ALLOWED_ORIGIN`** to the Vercel origin. It is `*` today and the backend says so on every
   boot.
3. **Prove sign-in email works under load.** Request a code ten times in ten minutes from ten
   addresses. Supabase's built-in mailer rate-limits hard and fails *silently*, which is exactly
   the failure that eats the first day of a trial.
4. **Decide guest mode.** On, and you lower the bar to a first try but collect no retention data
   and pay for strangers. Off, and every analysis is attributable. Pick deliberately.
5. **Run the funnel tests against production** so you have seen them pass with your own keys.

---

## Then: settle the act-1 experiment

This is the single highest-value thing in the backlog, because it decides what the product's
signature moment actually is.

Three deliveries of the opening replay are live at once — `voiced` (the avatars speak the couple's
lines), `real_audio` (their own recording plays) and `silent` (bubbles only). Pin testers to
variants from the People tab; the Metrics tab compares them on the one outcome that matters: the
share who answered *yes* to "will you try this line?".

`real_audio` is the one to watch. It is the truest version of the idea and it has never been run
against a real recording. When one variant wins, delete the other two — carrying three code paths
for a settled question is pure cost.

---

## Then: the two real product gaps

**1. Recording drops the second speaker.**
The in-browser Record tab uses the Web Speech API, which is single-speaker, so a couple recording
becomes one unlabelled stream. Upload already works correctly through Deepgram. Replacing Record
with `MediaRecorder` + the existing `/api/transcribe` closes the gap and makes `real_audio` usable
from a live recording, not just an upload. This is the highest-craft, highest-value build on the
list.

**2. Scores come from the model.**
They are now *stable* (same conversation, same number) but not *grounded* — a 70B model is still
inventing four numbers. `docs/PLAN-PRELAUNCH.md` Phase 1 describes the alternative in detail: the
model emits discrete behavioural labels from a closed vocabulary, and code computes every score
from published weights. That is what makes a score defensible to a user who asks "why 64?".

Do this **only if** users start asking that question. If nobody challenges the number, the
engineering is not yet earning its keep.

---

## Only when the numbers say so

- **Upgrade Groq.** The moment "give it a minute" appears more than occasionally, or a tester
  wants to submit something longer than ~13 minutes. One environment variable, no code change.
- **Async job pipeline** (Phase 2 of the plan). Needed only when conversations exceed what a
  synchronous request can carry — which the Groq tier currently prevents anyway.
- **WhatsApp automation.** Manual sending is fine and deliberate up to roughly 200 users. Past
  that it stops being a choice and becomes a wall.
- **Payments.** Removed entirely. Re-introduce only after retention is proven, not before.

---

## How to judge whether it is working

The admin Metrics tab is built around four numbers, in the order they matter:

1. **Ran an analysis** ÷ signed up — did the product survive first contact?
2. **Came back** (2+ analyses) ÷ activated — the only number that predicts a business
3. **Used all 3** — if most testers hit the limit and ask for more, the product is working and the
   limit is too low. If nobody reaches three, the limit is not your problem.
4. **Act-1 "will try" rate** — which opening actually changes behaviour

The intro funnel sits alongside them: if most viewers leave on the same scene, that scene is the
problem and the fix is obvious.

---

## A word on scope

There is a long, thoughtful roadmap in `docs/PLAN-PRELAUNCH.md` and `ROADMAP.md`. Much of it is
good. All of it was written before anyone outside the team had used the product.

Treat those documents as a menu, not a queue. The next ten real users will tell you more about
what to build than either of them can.
