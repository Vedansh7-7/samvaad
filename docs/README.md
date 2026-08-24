# docs — index

Not everything here is current. This index says which is which, so you do not act on a document
that was overtaken months ago.

**If you are new to the project, read [`../handover/README.md`](../handover/README.md) first.**
This folder is the longer-form material behind it.

---

## Current

| File | What it is |
|---|---|
| **[PRELAUNCH-OPS.md](PRELAUNCH-OPS.md)** | The live operational handover: what is done, and the dashboard steps only an account owner can perform. Kept up to date. |
| **[media/samvaad-intro.mp4](media/) ** | The marketing cut of the intro, recorded from `web/intro.html?film=1`. |
| **[email-templates/](email-templates/)** | Branded sign-in and confirmation emails. Paste into Supabase → Auth → Email Templates. |
| **[Samvaad-Board-Brief.html](Samvaad-Board-Brief.html)** | Non-technical brief: the product, the USP, the Phase-A KPI *targets*. Print with background graphics on. |
| **[Samvaad-Technical-Overview.html](Samvaad-Technical-Overview.html)** | Architecture, data flow, security layers, stack. Same print note. |

## Planning — good thinking, written before real users

Treat these as a menu, not a queue. Both predate anyone outside the team using the product, and
[`../handover/05-NEXT.md`](../handover/05-NEXT.md) supersedes their sequencing.

| File | Status |
|---|---|
| **[PLAN-PRELAUNCH.md](PLAN-PRELAUNCH.md)** | The pre-launch plan. **Phase 0 is done.** Phase 1 (deterministic scoring engine) and Phase 2 (async job pipeline) are **not built** and are still the best description of what they would involve. Phase 3's funnel work is largely shipped. |
| **[../ROADMAP.md](../ROADMAP.md)** | The older epic list (E1-E6). Partly shipped, partly superseded. Historical. |

## Historical — accurate about their moment, not about now

| File | Status |
|---|---|
| **[STATE-OF-PLAY.md](STATE-OF-PLAY.md)** | A full code audit from 2026-08-10. Its findings 4.1 (dashboard amnesia), 4.2 (model drift), 4.4 (dead pre-sell funnel) and 4.6 (feedback insert) have all since been **fixed**. Still the best written description of how the system got here. For current state, use [`../handover/04-STATE.md`](../handover/04-STATE.md). |
| **[replay-rive-briefs.md](replay-rive-briefs.md)** | The original briefs for the Rive replay work. R1 and R3 shipped. R2 (MediaRecorder capture, to fix single-speaker recording) is still open and is the top build item in [`../handover/05-NEXT.md`](../handover/05-NEXT.md). |
| **[_archive-v1.html](_archive-v1.html), [_archive-v2.html](_archive-v2.html)** | Superseded prototypes. Reference only. |
