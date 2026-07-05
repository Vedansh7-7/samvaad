# Replay v2 — Rive avatars + real-voice reflection (agent task briefs)

Status: **planned, not started** (2026-07-02). Execution model: **one agent per file** (app.html
collisions are real — R2–R5 are the SAME file and must run as ONE agent, sequentially). Format
mirrors ROADMAP.md: Goal · Files · Approach · Done-when. No code until the owner says go.

## The thesis (locked in discussion)
Input type decides the replay:
- **Recorded/uploaded audio** → **Reflection = their REAL voices**, split across two avatars
  (Deepgram diarization + word timestamps), lip-synced. "See how it actually went."
- **Typed / pasted text** (incl. social-media chats) → **Reflection = ElevenLabs TTS** with
  per-speaker tone. (Reflection is ALWAYS produced.)
- **Kinder version** = the comparative *extra* deliverable, always TTS. Sequential narrative
  ("how it went" → "a kinder version") — the narrative arc is the USP.
- Audio is **client-side only** — used for transcription + local playback, never persisted.
  No save/share. Only metrics-only session summaries are retained.

## Root cause confirmed (code-verified 2026-07-02)
- `web/app.html:632-633` — live recording uses the **Web Speech API**
  (`SpeechRecognition`/`webkitSpeechRecognition`). It is single-speaker: no diarization, drops
  the second voice. THIS is the "bias to one speaker / missing words" bug.
- `web/app.html:671-676` — **upload** already does it right: audio → Deepgram `diarize=true`
  (`server.js:49`). But the parser keeps only `speaker`+`punctuated_word` and **discards
  `x.start`/`x.end`** — we need those for real-audio turn-switching.

## Architectural rule that de-risks everything
**Decouple engine from art.** The lip-sync/expression code talks ONLY to Rive state-machine
inputs (`mouthOpen` number, `expr` state), never to specific artwork. → we ship a remixed rig
now and swap in hero art later with ZERO code change.

---

## R0 — Rig contract + recolor  *(Rive editor, human-in-the-loop; not a code file)*
**Goal:** every Samvaad `.riv` exposes an identical input contract so any character is swappable.
**Files / assets:** `E:\claude\Vocalis\rig\*.riv` (3 collected). Output: recolored rigs for
`couple` (2 chars: A, B), `solo`/`self` (1 char).
**Approach:**
- Inspect the 3 collected rigs' state machines (Rive editor / runtime `stateMachineInputs`) to
  learn the existing mouth/expression pattern (start with the two small demo rigs).
- Define + expose on each rig:
  - `mouthOpen` — **number 0–100** (drives lip-sync from audio amplitude).
  - `expr` — **state/enum**: `neutral · warm · tense · sad · listening · surprised · soft`
    (maps to the analysis emotions; matches the 7-expression Figma sheet).
- Recolor fills to palette (cherry `#C8324B` / blush-rose bg / warm skin; plum-mauve tint for
  self mode). Warm the tone away from the dark refs; keep the big catchlit eyes + soft-3D forms.
- **Licensing:** verify each source file's license (CC0 / CC-BY only; skip All-Rights-Reserved);
  keep a Credits line on the You/About page for CC-BY attribution. Keep characters generic.
**Done-when:** 3 recolored `.riv` files, each exposing `mouthOpen` (num) + `expr` (state) with
the 7 states, on-palette; license cleared + attribution noted.

## R1 — Deepgram word timestamps  *(agent: samvaad-backend — parallel-safe)*
**Goal:** return per-turn timing so the client can switch the active avatar during real-audio replay.
**Files:** `backend/server.js` (only).
**Approach:** in `/api/transcribe`, keep `words` (`speaker`, `start`, `end`, `punctuated_word`).
Build `turns: [{speaker, start, end, text}]` from contiguous same-speaker words. Return
`{transcript, turns}` (+ existing fields). No secret/env changes; TTS + analyze untouched.
**Done-when:** response includes `turns` with per-turn `start`/`end`+`speaker`; upload path unchanged
in behaviour, richer in payload.

## R2 — Capture fix: kill Web Speech API  *(agent: samvaad-frontend — app.html, run FIRST)*
**Goal:** record real audio, diarize via Deepgram, retain the blob client-side.
**Files:** `web/app.html` (only).
**Approach:**
- Replace the `SR` block (632-634) with `getUserMedia` + `MediaRecorder`; collect chunks into a
  Blob in `S._audioBlob` (memory only — never uploaded except to `/api/transcribe`, never stored).
- On Analyse: if `S.tab==='rec'`, POST the blob to `/api/transcribe` exactly like upload; on
  `up`, retain the chosen File as `S._audioBlob` too. Keep an object URL for reflection playback.
- Store the returned `turns` in `S.turns`. Update mic UI (record → stop → "recorded").
**Done-when:** two people recorded live diarize correctly; `S._audioBlob` + `S.turns` populated;
nothing persisted; upload path also retains its blob.

## R3 — Rive engine replaces SVG rig  *(agent: samvaad-frontend — app.html, after R2)*
**Goal:** swap `face()`/`setExpr()` SVG for the Rive runtime, keeping the sequencer contract intact.
**Files:** `web/app.html` (only).
**Approach:**
- Load `@rive-app/canvas` (CDN). In `buildScene`, instantiate a Rive instance + StateMachine per
  visible character (2 for couple, 1 for solo/self), load the recolored `.riv`.
- Reimplement `setExpr(side,emotion)` → set the Rive `expr` state. Add `setMouth(side,v)` → set
  `mouthOpen`. Drive `mouthOpen` from a **Web Audio `AnalyserNode`** (RMS of the currently-playing
  Audio element) — works for BOTH real audio and TTS. Idle = gentle blink/breathe (Rive idle state).
- **PRESERVE** the sequencer wiring: `buildScene/advance/speak/stopReplay/setNP/spk/S._alt/S._nm/
  replayWorth` and ids `#playBtn/#muteBtn/#prog/#scene/#stage/#npLive`. Only the *rendering* layer
  (SVG → Rive) and the mouth/expr drivers change. `stopReplay()` must also stop the AnalyserNode.
**Done-when:** replay renders Rive avatars with amplitude lip-sync + per-emotion expressions;
`stopReplay` halts audio + speech + analyser + loop; "Analyse another" is clean.

## R4 — Two-act reflection branching  *(agent: samvaad-frontend — app.html, after R3)*
**Goal:** Act 1 Reflection (real voices OR TTS) → Act 2 Kinder (TTS), as a narrative.
**Files:** `web/app.html` (only).
**Approach:**
- **Act 1:** if `S._audioBlob` exists → play it once; switch active avatar by `S.turns[].start/end`;
  lip-sync from amplitude — REAL voices. Else (text) → TTS the **original** transcript per speaker
  with tone. New builder `buildReflection()` reusing the Rive scene + speak plumbing.
- **Act 2 (extra):** the existing improved-conversation replay (TTS) = "a kinder version."
- Present sequentially: reflection auto-offered; finishing it reveals a "Show me a kinder version"
  CTA (keep the current walk-through → dashboard flow intact). `replayWorth` still gates Act 2.
**Done-when:** audio input → real-voice reflection; text input → TTS reflection; kinder version is
the comparative second act; narrative arc preserved; stopReplay covers both acts.

## R5 — Honest engaged-waiting interstitial  *(agent: samvaad-frontend — app.html, after R4)*
**Goal:** keep the user held during the Deepgram+Claude+TTS wait — narrative, not a fake bar.
**Files:** `web/app.html` (only).
**Approach:** extend the existing `PROC`/`setProc` (650-651): rotate **mode-aware wellness insight
strings** (relationship vs self) one at a time, ~3.5s gentle crossfade, over an **indeterminate**
breathing animation. Show honest stage labels when known (Listening → Understanding → Composing).
**No fake percentage.**
**Done-when:** insights rotate calmly during processing; honest stages; no deceptive progress.

---

### Run order
1. **R0** (Rive rigs — human, unblocks R3/R4 art) ∥ **R1** (server.js — independent agent).
2. Then **R2 → R3 → R4 → R5** as ONE frontend agent on `app.html`, sequential (same file).

### Preserve list (do not break)
`buildScene · advance · speak · speakEleven · speakBackend · stopReplay · setNP · spk · S._alt ·
S._nm · replayWorth · report.speakers` and ids `mouth-*/eye/bl-*/brow-*/ch-*/tag-* → superseded by
Rive, but keep `#playBtn/#muteBtn/#prog/#scene/#stage/#npLive` and the buildScene/advance/speak flow`.
