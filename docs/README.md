# docs

Everything written down about Samvaad. Not all of it is current, so each section says what it is.

**New to the project? Read [`handover/README.md`](handover/README.md) first.**

## handover/: start here

The six-part pack, kept current: [architecture](handover/01-ARCHITECTURE.md),
[operations](handover/02-OPERATIONS.md), [decisions](handover/03-DECISIONS.md),
[current state](handover/04-STATE.md), [what is next](handover/05-NEXT.md) and
[accounts](handover/06-ACCOUNTS.md).

## operations/: running it

| File | What it is |
|---|---|
| **[PRELAUNCH-OPS.md](operations/PRELAUNCH-OPS.md)** | The live operational handover: what is done, and the dashboard steps only an account owner can perform. |
| **[email-templates/](operations/email-templates/)** | Branded sign-in and confirmation emails. Paste into Supabase, Authentication, Email Templates. |
| **[STATE-OF-PLAY.md](operations/STATE-OF-PLAY.md)** | A full code audit from 2026-08-10. Findings 4.1, 4.2, 4.4 and 4.6 have since been fixed. For current state use [handover/04-STATE.md](handover/04-STATE.md). |

## product/: plans

Good thinking, written before real users. Treat it as a menu, not a queue:
[handover/05-NEXT.md](handover/05-NEXT.md) sets the order.

| File | Status |
|---|---|
| **[PLAN-PRELAUNCH.md](product/PLAN-PRELAUNCH.md)** | The pre-launch plan. Phase 0 is done. Phase 1 (deterministic scoring) and Phase 2 (async jobs) are not built. |
| **[ROADMAP.md](product/ROADMAP.md)** | The older epic list (E1 to E6). Partly shipped, partly superseded. Historical. |
| **[replay-rive-briefs.md](product/replay-rive-briefs.md)** | The original Rive replay briefs. R1 and R3 shipped; R2's goal, recorded audio with both speakers, is now met by the Record tab and multilingual transcription. |

## decks/: print-ready

| File | What it is |
|---|---|
| **[Samvaad-Board-Brief.html](decks/Samvaad-Board-Brief.html)** | Non-technical brief: the product, the USP, the Phase-A KPI targets. Print with background graphics on. |
| **[Samvaad-Technical-Overview.html](decks/Samvaad-Technical-Overview.html)** | Architecture, data flow, security layers, stack. Same print note. |

## media/ and archive/

| File | What it is |
|---|---|
| **[media/samvaad-intro.mp4](media/samvaad-intro.mp4)** | The marketing cut of the intro, recorded from `web/intro.html?film=1` by `tools/intro`. |
| **[archive/prototype-v1.html](archive/prototype-v1.html), [archive/prototype-v2.html](archive/prototype-v2.html)** | Superseded prototypes. Reference only. |
