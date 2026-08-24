# Samvaad — handover pack

**Read this file first. It is the map to everything else.**

You have been handed a working, deployed product. It is not a prototype: it runs in production,
it has paying-attention-worthy test coverage, and the last verified run against production was
41/41 on the public funnel and 37/37 on the signed-in funnel. What it does not yet have is users.

This folder is written for two readers at once: the person taking the project over, and the AI
coding agent they will point at it. Both should start here.

---

## What Samvaad is, in one paragraph

An Indian-market wellness product for couples. Someone hands it a difficult conversation — pasted
chat or an uploaded recording — and gets back a report (scores, the patterns underneath, what each
person did well, exact lines to try next time) plus an intervene layer: a guided breathing
exercise, better scripts, and an animated replay. The distinctive part is the walk-through: it
replays the pivotal moment **in their own words, acted out by animated avatars**, before it says
anything about what went wrong. Hinglish, Hindi and Devanagari are first-class. The product is
currently in a **pre-launch trial**: one mode, three free conversations per account, invited
testers only.

---

## The five minutes that will save you a day

1. **`cd backend && npm install && npm run schema:check`** — tells you instantly whether the
   database matches the code. If it does not, `backend/migrations/000-bring-schema-current.sql` is
   the single file that fixes it.
2. **`npm start`, then `npm run funnel`** — walks the whole product end to end and prints a
   pass/fail line per step. If this is green, the system works.
3. Read **[03-DECISIONS.md](03-DECISIONS.md)**. It is the most valuable file here. Several things
   in this codebase look wrong and are not, and it explains each one. Changing them back will cost
   you a day each, because they were each learned the hard way against a live API.

---

## The pack

| File | What it answers |
|---|---|
| **[01-ARCHITECTURE.md](01-ARCHITECTURE.md)** | How is it built? Every endpoint, every table, every page, how the replay engine works. |
| **[02-OPERATIONS.md](02-OPERATIONS.md)** | How do I run, deploy, test and fix it? Includes a symptom-to-cause runbook. |
| **[03-DECISIONS.md](03-DECISIONS.md)** | Why is it like this? The non-obvious choices and the failures behind them. **Read before changing anything.** |
| **[04-STATE.md](04-STATE.md)** | What works, what is stubbed, what is not built, what is verified and what is not. |
| **[05-NEXT.md](05-NEXT.md)** | What should I do next, and in what order? |
| **[06-ACCOUNTS.md](06-ACCOUNTS.md)** | What external services does this depend on, what do they cost, and what must be transferred and rotated? |

---

## Repository layout

```
samvaad/
├─ backend/              Node/Express proxy. Holds every secret. Deployed on Render.
│  ├─ server.js          The whole backend, ~1,300 lines, deliberately one file
│  ├─ schema.sql         Reference copy of the database shape
│  ├─ migrations/        000-bring-schema-current.sql is the only one you need
│  └─ test/              funnel.mjs, signed-in.mjs, schema.mjs
├─ web/                  Static frontend. No framework, no build step. Deployed on Vercel.
│  ├─ index.html         Entry: routes first-time visitors to the intro
│  ├─ intro.html         Animated, voiced introduction (Rive + ElevenLabs)
│  ├─ login.html         Magic link / OTP / guest. The canonical design reference.
│  ├─ app.html           The product: analyse, report, walk-through, replay, dashboard
│  ├─ admin.html         Internal console: metrics and per-user controls
│  ├─ privacy.html       Privacy notice
│  ├─ rive/              The two avatar rigs (.riv)
│  └─ audio/intro/       Narration for the intro
├─ docs/                 Longer-form documents and the decks
│  └─ media/             The marketing cut of the intro
├─ handover/             You are here
├─ CLAUDE.md             Auto-loaded by Claude Code. Project rules and guardrails.
├─ PRODUCT.md            Brand, tone and design register
└─ render.yaml           Render blueprint for the backend
```

**Do not rename `web/` or `backend/`.** Vercel's project root points at `web`, and Render's at
`backend`. Renaming them breaks both deploys, and the settings live in those dashboards, not in
this repository.

---

## If you are the AI agent

`CLAUDE.md` at the repository root loads automatically and carries the hard guardrails. This pack
is the context behind them. In particular:

- **Read [03-DECISIONS.md](03-DECISIONS.md) before your first edit.** It exists specifically to
  stop you from "fixing" things that are correct.
- There is no build step and no test framework. Verification is `npm run funnel`,
  `npm run funnel:signed-in` and `npm run schema:check`. Run them; they hit the real APIs.
- `web/app.html` is one large file that many features touch. Work on it sequentially, never in
  parallel with another agent.
- Never commit a secret. `backend/.env` is git-ignored and must stay that way. The Supabase
  publishable key in `web/auth.js` is public by design; the service key is not.
