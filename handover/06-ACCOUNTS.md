# Accounts, secrets and transfer

**No secret appears in this repository, and none should ever be added to it.** This file lists
what exists, what each thing is for, and what has to happen for the handover to be complete. The
values themselves must be passed through a channel that is not a git repository, an email body, or
a chat message that will still exist next year.

---

## External services

| Service | Used for | Where its key lives | Account to transfer |
|---|---|---|---|
| **Supabase** | Auth, database, RLS. Project `bwcszkbtvbvwzioycxxp`, region `ap-south-1` (Mumbai) | `SUPABASE_SERVICE_KEY` (secret) and the publishable key in `web/auth.js` (public by design) | yes — organisation ownership |
| **Groq** | The analysis model | `GROQ_API_KEY` | yes |
| **Deepgram** | Speech to text, diarized | `DEEPGRAM_KEY` | yes |
| **ElevenLabs** | Replay and intro voices | `ELEVENLABS_KEY`, scoped to text-to-speech only | yes |
| **Render** | Backend hosting | env vars set in its dashboard | yes — service ownership |
| **Vercel** | Frontend hosting | none | yes — project ownership |
| **GitHub** | This repository | none | yes |
| **SMTP provider** | Sign-in emails | configured inside Supabase Auth | yes |

Region matters: Supabase is deliberately in **Mumbai** for India DPDP data residency. If the
project is ever recreated, recreate it in `ap-south-1`.

---

## Transfer checklist

**Rotate every key.** A handover means the previous holder still knows the old values. Rotating is
not a statement of distrust; it is the only way the new owner can say the keys are theirs.

- [ ] Transfer the **GitHub** repository to the new owner or organisation
- [ ] Transfer the **Supabase** project (Organisation → Settings → Transfer). Then rotate the
      **service_role** key and update it on Render
- [ ] Transfer the **Render** service. Re-enter every environment variable with new values
- [ ] Transfer the **Vercel** project. Confirm the project root is still `web`
- [ ] Create a new **Groq** key; delete the old one
- [ ] Create a new **Deepgram** key; delete the old one
- [ ] Create a new **ElevenLabs** key, scoped to text-to-speech only, with a monthly character
      cap; delete the old one
- [ ] Re-point the **SMTP** credentials inside Supabase Auth
- [ ] Set **`ADMIN_USER_IDS`** to the new owner's Supabase user id and remove the previous one
- [ ] Set **`GUEST_SECRET`** to a new random string. This invalidates every outstanding guest
      token, which is the intended effect
- [ ] Set **`ALLOWED_ORIGIN`** to the production frontend origin
- [ ] Run `npm run schema:check`, `npm run funnel` and `npm run funnel:signed-in` against
      production. Green means the transfer is complete

---

## Repository hygiene — verified 2026-08-25

Checked, so you do not have to take it on trust:

- **No `.env` has ever been committed**, on any branch, in any commit. The only environment file
  in history is `.env.example`. Re-check any time with
  `git log --all --pretty=format: --name-only | sort -u | grep -E '(^|/)\.env$'` — it should
  return nothing.
- **`backend/.env` is git-ignored** (`.gitignore:2`).
- **`.env.example` contains no real values** — every secret line is blank.

Two things still worth the new owner's attention:

- [ ] **Share the repository, not a zip of the folder.** A zip does not respect `.gitignore`, so
      `backend/.env` with live keys would travel inside it. This is the single easiest way to leak
      every key in one action.
- [ ] Delete any personal test accounts left in Supabase Auth.

---

## Compliance posture to preserve

The product was built to the **India DPDP Act 2023 and its 2025 Rules** from the start. These are
not decorative:

- **Consent first.** A recording containing a second person requires an explicit attestation, and
  it is recorded in the `consents` table against the session.
- **Purpose limitation.** Audio is streamed through the request and **never persisted**. There is
  no audio bucket. If you add one, you must add its deletion schedule at the same time.
- **Data residency.** Mumbai, deliberately.
- **Minimal collection.** The user's own WhatsApp number only — never a partner's. Sessions are
  per-tab, in `sessionStorage`, not `localStorage`.
- **Row Level Security everywhere**, with `forUser()` in the backend because the service role
  bypasses RLS.
- **No under-18 users** without parental consent.
- Framing is a **wellness product**, and the copy never carries a disclaimer denying it is
  medical. See [03-DECISIONS.md](03-DECISIONS.md) §11.

---

## Assets that are not code

- `web/rive/samvaad_{female,male}.riv` — the two avatar rigs, authored in Rive. The source Rive
  file and the Figma expression sheet (`uswu4pwbGQ7FtRp0nufkDn`) sit outside this repository and
  should be transferred with it if the new owner needs to edit the characters.
- `web/audio/intro/*.mp3` — generated narration. Regenerable from `script.json` with an
  ElevenLabs key; see [02-OPERATIONS.md](02-OPERATIONS.md).
- `docs/media/samvaad-intro.mp4` — the marketing cut, recorded from `intro.html?film=1`.
- `docs/Samvaad-Board-Brief.html` and `docs/Samvaad-Technical-Overview.html` — print-ready
  reference decks. Print with *Background graphics* enabled.

---

## Licensing

This repository carries **no licence file**, which by default means all rights reserved. Whether
that is correct depends on the terms of the transfer, and it is a decision for the parties
involved rather than something to be inferred from the code. Add a `LICENSE` deliberately, or
leave it absent deliberately, but do not leave it unconsidered.
