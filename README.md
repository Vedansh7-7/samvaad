# Samvaad

Talk, reflect, breathe. Upload a conversation and get a calm reading of it: a score, what went wrong,
the lines to try instead, and the moment played back and replayed kinder. Built for the Indian market,
in Hinglish, Hindi and English.

> **New here, or taking this project over? Start with [`docs/handover/README.md`](docs/handover/README.md).**
> `CLAUDE.md` carries the working rules and is auto-loaded by Claude Code.

## Where things are

```
samvaad/
├─ web/            The site. Static HTML, no build step. Vercel serves this folder.
├─ backend/        Node/Express proxy that holds every secret. Render runs this folder.
├─ docs/           Everything written down (index: docs/README.md)
│  ├─ handover/    The six-part handover pack. Read first.
│  ├─ operations/  Running it: pre-launch ops, the code audit, email templates
│  ├─ product/     Plans and the older roadmap
│  ├─ decks/       Board brief and technical overview (print-ready HTML)
│  ├─ media/       The marketing cut of the intro
│  └─ archive/     Superseded prototypes
├─ tools/          Scripts that are not part of the site
│  ├─ intro/       Records, cuts and checks the intro reel
│  └─ rive-test/   Test harness for the avatar rigs
├─ CLAUDE.md       Agent rules, auto-loaded
├─ PRODUCT.md      Brand, tone and design register
└─ render.yaml     Render blueprint for the backend
```

**Do not rename or move `web/` or `backend/`.** Vercel and Render deploy from them, and those
settings live in their dashboards, not in this repository.

## Run it locally

Frontend: `cd web && python -m http.server 8123`, then open http://localhost:8123/app.html. It uses
the live backend by default.

Backend:
```bash
cd backend
npm install
cp .env.example .env      # fill in the keys (SUPABASE_URL is pre-filled)
npm start                 # serves on PORT (default 8787)
```
To point the local site at a local backend, run
`localStorage.setItem('samvaad.beUrl', 'http://localhost:8787')` in the browser console.

## Services
- **Supabase**: database and sign-in, Mumbai region. Only the service_role key goes in `backend/.env`.
- **Deepgram**: speech to text, `nova-3` multilingual. $200 one-time credit.
- **Groq**: the analysis, `openai/gpt-oss-120b`, free tier.
- **ElevenLabs**: the voices, with a key scoped to Text-to-Speech only.
- **Vercel** hosts the site and its Web Analytics; **Render** hosts the backend.

Never commit `.env`. It is git-ignored.
