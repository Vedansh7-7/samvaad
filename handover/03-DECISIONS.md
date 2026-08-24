# Decisions — why it looks like this

Several things in this codebase look like mistakes and are not. Each entry below was learned by
something breaking against a live API. **Read this before your first change.** The cost of
re-learning any one of these is roughly a day.

---

## 1. The analysis is ONE Groq call, not two

It used to be two: report first, then the improved conversation, split apart so a long response
could not get truncated.

Groq charges the **reservation** (`prompt + max_tokens`) against a per-minute ceiling, not actual
usage. Two calls inside the same minute therefore each get half the budget. On the free tier's
8,000 TPM that worked out to about 600 words — roughly four minutes of speech. Merging them into
one call gives the whole budget to one request and takes the ceiling to about 2,000 words, near
13 minutes.

**Do not split it back up** to "keep things tidy" without recalculating the budget.

---

## 2. The response schema has NO enums, on purpose

Groq's `strict: true` is **post-generation validation, not constrained decoding**. The model
generates freely and the result is checked afterwards, so an enum is not a guarantee — it is a
tripwire. The model read a line as `"defensive"`, a perfectly fair reading of the conversation,
and the entire analysis came back as HTTP 400 `json_validate_failed`.

Every controlled vocabulary (emotion, gender, speaker) is a plain `string` in the schema and is
mapped onto ours in `sane()`. An unrecognised emotion lands on `neutral`, which is a fine face for
a line we could not read.

**Putting the enums back will make analyses fail intermittently and look like a Groq outage.**

---

## 3. `reasoning_effort: 'low'` is deliberate

`openai/gpt-oss-120b` is a reasoning model. Measured on the real API:

| | reasoning tokens | completion | latency |
|---|---|---|---|
| default effort | 2,252 | 3,837 | 8.6s |
| `low` | **6** | 1,861-2,069 | **4.7s** |

Identical scores across consecutive runs at `low`. More than half the response budget at default
effort was spent thinking, for no measurable gain in quality — and it pushed `max_tokens` high
enough to eat the transcript's share of the per-minute budget.

Also: `temperature: 0` and a fixed `seed`. The same conversation should not score differently on a
re-run, because a user who re-submits and sees a different number stops trusting the number.

---

## 4. `GROQ_MODEL` is normally unset

Groq retires models on a schedule. `llama-3.3-70b-versatile` was announced dead on 2026-06-17 and
stopped being served that August; the failure was a bare 400 that cost a day to diagnose.

The backend now asks Groq which models it actually serves and takes the best match from
`MODEL_PREFERENCE`, re-resolving mid-flight if one is retired. Pinning `GROQ_MODEL` disables that
self-repair. Pin it only when you specifically want one model.

---

## 5. Every user-facing limit is derived, never typed

The copy once promised "30 minutes" while the backend could read ten. Nothing in the product now
contains a hardcoded minute or character figure: `LIMITS` is computed from `GROQ_TPM`,
`GROQ_MAX_TOKENS` and the measured prompt overhead, then served through `/api/config` and
`/api/me`, and the frontend renders whatever it is told.

**If you find yourself typing a number of minutes into a string, stop.**

---

## 6. The busy path is a 503, and costs nothing

When the per-minute budget is full, a request queues in `tpmReserve()` and, if the wait would
exceed 45 seconds, returns **503 with a sentence a person can act on** — not a 500. It is not a
fault; the free tier is genuinely that small.

Crucially the allowance is charged **only after a report succeeds**. A failed or refused analysis
must never cost someone one of their three. The transcript is also cached against the uploaded
file, so retrying after a busy minute does not pay Deepgram twice.

---

## 7. Speaker labels pass through unchanged when they are not "A"/"B"

The model sometimes answers with the person's name instead of `A`/`B`. An early version of
`normSpeaker` collapsed anything unrecognised to `A`, which put all eight turns in one person's
mouth.

Names now pass through untouched, and the frontend's `spk()` resolves them against the two names
it was given, with strict alternation as a last-resort fallback (`S._alt`). Do not "tidy" this
into a strict A/B normaliser.

---

## 8. Neither Rive canvas is flipped in `intro.html`

The rigs are drawn facing inward for their default positions: the female artboard looks right
(correct on the left), the male looks left (correct on the right). `app.html` flips a rig **only**
when it sits on the side it was not drawn for.

Adding `.flip` to the male canvas on the right turned him to face the same way as the woman, and
they talked past each other for the entire film. There is a comment in the source saying so.

---

## 9. The intro opens on a poster with a play button

Browsers refuse to autoplay audio without a user gesture. Starting the film automatically would
mean a large share of the audience watching a **silent** movie and never knowing there was a
voice-over at all.

One tap buys audio for the whole run. If audio is blocked anyway, the intro falls back to a timed
silent run rather than freezing, and fires `intro_audio_blocked` so you can see how often it
happens.

---

## 10. The walk-through shows the real conversation before it judges it

Act 1 replays the pivotal moment in the couple's own words, verbatim, **before** a single word
about what went wrong. The diagnosis only means something once you have watched the thing being
diagnosed.

That is why `sessions.original` exists and why the model is told to copy those lines exactly
rather than paraphrase. If act 1 starts paraphrasing, the feature has quietly lost its point.

---

## 11. No "not medical" disclaimers anywhere

Samvaad is a wellness product and the copy simply reads as one. Explicit *"this is not medical
advice"* / *"not a diagnosis"* lines were removed from the app, the emails and the decks in August
2026: naming the thing you are not invites the comparison and reads defensively.

Say what it is — gentler, calmer, private — and let that carry it. This is a standing instruction,
also recorded in `CLAUDE.md` and `PRODUCT.md`.

---

## 12. One mode, and "Just me" is hidden rather than deleted

The trial runs a single **Relationship** intent, always a two-person exchange with both names and
consent. Self reflection ("Just me") is fully built and simply closed:
`app_settings.self_reflection_enabled` globally, or `profiles.features.self_reflection` for one
account. **Do not delete its code** — it comes back through the same wiring.

The consequence, accepted knowingly: the solo-to-couple conversion metric is no longer meaningful
and was removed from the admin dashboard rather than left to read zero forever.

---

## 13. Guests exist, and persist nothing

Guest mode is for testing and for lowering the bar to a first try. Guests get the full product,
three analyses a day, and **no persistence at all**. That is why a guest's dashboard is always
empty and why `/api/history` returns nothing for them — it is not a bug.

Guest issuance is killable from the admin console. Turn it off before a real cohort, because a
guest generates cost and produces no retention data.

---

## 14. `profiles` is readable by its owner and writable by nobody

Status, quota and feature flags are the admin's to set. The backend writes them with the service
role, which bypasses RLS. A user can read their own row and cannot change it — the signed-in
funnel test asserts that a direct update through the user's own JWT silently fails to change the
value.

This is also why `forUser()` exists: the service key ignores RLS, so every user-scoped query must
carry its filter by hand.

---

## 15. The admin console leads with the database

A missing table and a user with no row look identical from the outside. The console used to render
plausible defaults and only confess as PostgREST jargon in a browser alert when you pressed Save.

Now `GET /api/admin/schema` probes every table and column, both tabs lead with a banner naming
exactly what is missing, PostgREST's error is rewritten into the sentence that helps, and
`npm run schema:check` answers the same question from a terminal. Keep that property: **a
misconfiguration should announce itself, not hide behind convincing defaults.**

---

## 16. Static HTML, no build step

No framework, no bundler, no transpiler. Open a file and read the whole feature. This has kept the
project fast to change with a single developer and an AI agent, and it is why `app.html` is large.

If you introduce a build step, you are trading that property away — do it deliberately, for a
reason you can name, not because large files feel untidy.
