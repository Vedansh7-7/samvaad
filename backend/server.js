// Samvaad backend — the secret-holding proxy.
// All API keys live here in env vars, never in the browser. Node 18+ (has global fetch).
// Run: npm i && node server.js   |   Deploy: Render / Railway / Fly free tier.

import express from 'express';
import cors from 'cors';
import crypto from 'crypto';
import { createClient } from '@supabase/supabase-js';

const app = express();

// CORS should be pinned to the frontend origin in production. We warn loudly rather than refusing
// to boot: a live backend going down over a config nit is worse than the wildcard it replaces.
if (!process.env.ALLOWED_ORIGIN || process.env.ALLOWED_ORIGIN === '*') {
  console.warn('[samvaad] WARNING: ALLOWED_ORIGIN is unset or "*". Set it to your Vercel origin.');
}
app.use(cors({ origin: process.env.ALLOWED_ORIGIN || '*' }));
app.use(express.json({ limit: '25mb' }));

const {
  GROQ_API_KEY, DEEPGRAM_KEY, ELEVENLABS_KEY, GUEST_SECRET,
  SUPABASE_URL, SUPABASE_SERVICE_KEY,
  ELEVEN_VOICE_A = 'EXAVITQu4vr4xnSDxMaL', ELEVEN_VOICE_B = 'onwK4e9ZLuTAKqWW03F9'
} = process.env;

const admin = (SUPABASE_URL && SUPABASE_SERVICE_KEY)
  ? createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY) : null;

// ---- Input ceilings (P0-T3). A 30-minute conversation is roughly 4,500 words / 25,000 chars. ----
const MAX_WORDS = 4500;
const MAX_CHARS = 25000;
const MAX_AUDIO_SECONDS = 35 * 60;      // hard reject beyond this; the advertised limit is derived below
const GUEST_ANALYSES_PER_DAY = 10;
const DEFAULT_MINUTES_QUOTA = 60;

// ---- The analysis model ----------------------------------------------------
// Groq deprecated llama-3.3-70b-versatile (announced 2026-06-17, stopped serving Aug 2026) and
// requests to it now come back `model_decommissioned`. gpt-oss-120b is Groq's own recommended
// replacement, and it brings something the old model did not: strict json_schema structured
// outputs. That is why the analysis is a SINGLE call now — see the note on the budget below.
// Model is env-settable so a future swap is a dashboard change, not a deploy.
const GROQ_MODEL = process.env.GROQ_MODEL || 'openai/gpt-oss-120b';

// The real ceiling is not our preference, it is Groq's tokens-per-minute limit: Groq counts
// prompt + max_tokens against TPM. The free plan gives gpt-oss-120b 8,000 TPM (the old model had
// 12,000), so the naive read is that we got *less* room. We got more, because the analysis used
// to be TWO calls inside the same minute and each could therefore use only half the budget:
//
//   two calls @ 8,000 TPM  ->  ~600 words   (~4 minutes of speech)
//   one call  @ 8,000 TPM  -> ~2,300 words  (~15 minutes of speech)
//
// Merging them was only safe once the model could guarantee a well-formed, bounded response, which
// is exactly what strict json_schema gives us. Raising GROQ_TPM after upgrading the Groq plan is
// the single knob that lifts the limit; nothing else needs to change.
const GROQ_TPM = Number(process.env.GROQ_TPM || 8000);
const GROQ_MAX_TOKENS = 2600;                 // reserved for the response, and counted against TPM
const CHARS_PER_TOKEN = 2.6;                  // measured on romanised Hinglish, which is dense
const PROMPT_OVERHEAD_TOKENS = 1100;          // instructions + the json_schema, which is itself input
const ANALYSIS_MAX_CHARS = Math.max(
  2000,
  Math.floor((GROQ_TPM - GROQ_MAX_TOKENS - PROMPT_OVERHEAD_TOKENS) * CHARS_PER_TOKEN)
);
// What we may honestly tell a user, derived rather than hardcoded so the copy can never drift from
// the actual limit. ~5.5 characters per word, ~150 spoken words per minute.
const EFFECTIVE_MAX_CHARS   = Math.min(MAX_CHARS, ANALYSIS_MAX_CHARS);
const EFFECTIVE_MAX_WORDS   = Math.min(MAX_WORDS, Math.floor(EFFECTIVE_MAX_CHARS / 5.5));
const EFFECTIVE_MAX_MINUTES = Math.max(1, Math.floor(EFFECTIVE_MAX_WORDS / 150));
// Audio is rejected at the length we can actually analyse rather than a bigger number we would
// then silently truncate. Paying Deepgram to transcribe 30 minutes we cannot read, and telling
// someone afterwards that we only looked at half their conversation, is the worse outcome.
// The 10% grace stops a 15:04 recording bouncing off a 15:00 wall.
const MAX_ANALYSABLE_SECONDS = Math.min(MAX_AUDIO_SECONDS, Math.round(EFFECTIVE_MAX_MINUTES * 60 * 1.1));
const LIMITS = {
  maxChars: EFFECTIVE_MAX_CHARS, maxWords: EFFECTIVE_MAX_WORDS,
  maxMinutes: EFFECTIVE_MAX_MINUTES, maxAudioSeconds: MAX_ANALYSABLE_SECONDS
};

// ============================================================================
// Principals: a signed-in Supabase user, or a short-lived guest token we issued.
// Nothing that costs money runs without one.
// ============================================================================

async function getUser(req) {
  const t = (req.headers.authorization || '').replace('Bearer ', '');
  if (!t || !admin) return null;
  const { data } = await admin.auth.getUser(t);
  return data?.user || null;
}

const b64u = (buf) => Buffer.from(buf).toString('base64url');
function signGuest(payload) {
  const body = b64u(JSON.stringify(payload));
  const mac = crypto.createHmac('sha256', GUEST_SECRET).update(body).digest('base64url');
  return body + '.' + mac;
}
function verifyGuest(token) {
  if (!token || !GUEST_SECRET) return null;
  const [body, mac] = String(token).split('.');
  if (!body || !mac) return null;
  const expect = crypto.createHmac('sha256', GUEST_SECRET).update(body).digest('base64url');
  // timing-safe compare; lengths must match first or timingSafeEqual throws
  if (mac.length !== expect.length || !crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(expect))) return null;
  try {
    const p = JSON.parse(Buffer.from(body, 'base64url').toString());
    if (!p.exp || p.exp < Date.now()) return null;
    return p;
  } catch { return null; }
}

// Resolve who is calling. Returns {kind:'user'|'guest', id, user?} or null.
async function getPrincipal(req) {
  const u = await getUser(req);
  if (u) return { kind: 'user', id: u.id, user: u };
  const g = verifyGuest(req.headers['x-guest-token']);
  return g ? { kind: 'guest', id: g.id } : null;
}

// Guard for every endpoint that spends money. Sends the 401 itself and returns null.
async function requirePrincipal(req, res) {
  const p = await getPrincipal(req);
  if (!p) { res.status(401).json({ error: 'Please sign in to continue.' }); return null; }
  return p;
}

// The service key bypasses RLS, so every user-scoped query must be filtered by hand.
// Route them all through this so the filter cannot be forgotten.
function forUser(table, principal) {
  if (!admin || principal.kind !== 'user') return null;
  return admin.from(table).select('*').eq('user_id', principal.id);
}

// Tolerant of the table not existing yet: an un-migrated database simply has no overrides.
async function settings() {
  if (!admin) return {};
  try {
    const { data, error } = await admin.from('app_settings').select('key, value');
    if (error) return {};
    return Object.fromEntries((data || []).map(r => [r.key, r.value]));
  } catch { return {}; }
}

// ---- The act-1 experiment ---------------------------------------------------
// The walk-through opens by replaying the conversation as it actually happened. There are three
// ways to deliver that, they are being A/B'd against real testers, and the loser gets deleted:
//   voiced     — the avatars speak the user's own lines through ElevenLabs
//   real_audio — their actual recording plays, avatars driven by the Deepgram turn timings
//                (falls back to `voiced` for pasted text, where there is no recording)
//   silent     — avatars animate, lines appear as bubbles, no voice at all
// A per-user flag beats the global default, so a fresh test account can be pinned to one variant.
const ACT1_MODES = ['voiced', 'real_audio', 'silent'];
const ACT1_DEFAULT = 'voiced';
function resolveAct1(profile, appSettings) {
  const perUser = profile && profile.features && profile.features.act1;
  if (ACT1_MODES.includes(perUser)) return perUser;
  const global = appSettings && appSettings.act1_mode;
  if (ACT1_MODES.includes(global)) return global;
  return ACT1_DEFAULT;
}

// ---- Quotas -----------------------------------------------------------------
// Signed-in users are metered in minutes against their profile; guests get a small
// in-memory daily allowance (they are for testing, and the process restarting is fine).
const guestUse = new Map();   // guestId -> {day, count}

// Returns null when profiles does not exist yet (pre-migration) so quotas simply go unenforced
// rather than 500-ing every analysis. Deploy order between git and the SQL editor stops mattering.
async function ensureProfile(principal) {
  if (!admin || principal.kind !== 'user') return null;
  try {
    const { data, error } = await admin.from('profiles').select('*').eq('user_id', principal.id).maybeSingle();
    if (error) { console.warn('[samvaad] profiles unavailable:', error.message); return null; }
    if (data) return data;
    const { data: made } = await admin.from('profiles')
      .insert({ user_id: principal.id, minutes_quota: DEFAULT_MINUTES_QUOTA })
      .select('*').single();
    return made || null;
  } catch (e) { console.warn('[samvaad] profiles unavailable:', e.message); return null; }
}

const monthKey = () => new Date().toISOString().slice(0, 7);   // "2026-08"

// Throws {status, message} when the caller may not spend. `minutes` is the estimated cost.
async function checkQuota(principal, minutes) {
  if (principal.kind === 'guest') {
    const day = new Date().toISOString().slice(0, 10);
    const u = guestUse.get(principal.id);
    const count = (u && u.day === day) ? u.count : 0;
    if (count >= GUEST_ANALYSES_PER_DAY) {
      throw { status: 429, message: 'Guest limit reached for today. Sign in to keep going.' };
    }
    return;
  }
  const p = await ensureProfile(principal);
  if (!p) return;                                     // no DB configured; nothing to enforce
  if (p.status === 'suspended') {
    throw { status: 403, message: 'This account is paused. Please reach out to us and we will sort it out.' };
  }
  const used = (p.quota_month === monthKey()) ? Number(p.minutes_used_month || 0) : 0;
  if (used + minutes > Number(p.minutes_quota || DEFAULT_MINUTES_QUOTA)) {
    throw { status: 429, message: 'You have used this month’s analysis time. Message us and we can raise it.' };
  }
}

async function chargeQuota(principal, minutes) {
  if (principal.kind === 'guest') {
    const day = new Date().toISOString().slice(0, 10);
    const u = guestUse.get(principal.id);
    guestUse.set(principal.id, { day, count: (u && u.day === day ? u.count : 0) + 1 });
    return;
  }
  if (!admin) return;
  const p = await ensureProfile(principal);
  if (!p) return;
  const used = (p.quota_month === monthKey()) ? Number(p.minutes_used_month || 0) : 0;
  await admin.from('profiles').update({
    minutes_used_month: used + minutes, quota_month: monthKey(), updated_at: new Date().toISOString()
  }).eq('user_id', principal.id);
}

const quotaFail = (res, e) => res.status(e.status || 500).json({ error: e.message || String(e) });

// ---- Coarse rate limiting: a backstop against a loop, not a billing control ----
const hits = new Map();
function rateLimit(id, perMinute) {
  const now = Date.now(), win = 60000;
  const arr = (hits.get(id) || []).filter(t => now - t < win);
  arr.push(now); hits.set(id, arr);
  return arr.length <= perMinute;
}

// ============================================================================

const json = (s) => { try { return JSON.parse(s); } catch { const a = s.indexOf('{'), b = s.lastIndexOf('}'); return JSON.parse(s.slice(a, b + 1)); } };

// Ask for a schema-constrained response when we have a schema, plain JSON otherwise.
// `strict: true` uses constrained decoding: the model physically cannot emit a token that would
// break the shape, which is what retires the old "Failed to generate JSON" retry dance.
async function groq(prompt, { schema = null, schemaName = 'result', tries = 3 } = {}) {
  const format = schema
    ? { type: 'json_schema', json_schema: { name: schemaName, strict: true, schema } }
    : { type: 'json_object' };
  let lastErr;
  for (let i = 0; i < tries; i++) {
    const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'authorization': 'Bearer ' + GROQ_API_KEY },
      // temperature 0 + a fixed seed: the same conversation should not score differently on a
      // re-run. Determinism is not guaranteed by the API, but this removes the deliberate variance.
      body: JSON.stringify({ model: GROQ_MODEL, max_tokens: GROQ_MAX_TOKENS, temperature: 0, seed: 7, response_format: format, messages: [{ role: 'user', content: prompt }] })
    });
    if (r.ok) { const d = await r.json(); return (d.choices || []).map(c => c.message?.content || '').join(''); }
    const body = (await r.text()).slice(0, 300);
    // 413 means we blew the tokens-per-minute ceiling. Raw Groq text is no help to a user.
    if (r.status === 413) throw new Error('This conversation is longer than we can read in one go right now. Try a shorter section.');
    // Groq retires models on a schedule and the failure is otherwise a silent 400 nobody decodes.
    // Say the operator sentence out loud: it cost a day the first time this happened.
    if (/model_decommissioned|does not exist|model_not_found/i.test(body)) {
      console.error('[samvaad] GROQ_MODEL "' + GROQ_MODEL + '" is no longer served. Set GROQ_MODEL to a current model id from https://console.groq.com/docs/models');
      throw new Error('Our analysis engine is being updated. Please try again shortly.');
    }
    if (r.status === 401 || r.status === 403) {
      console.error('[samvaad] Groq rejected the API key (' + r.status + '). Renew GROQ_API_KEY in the Render dashboard.');
      throw new Error('Our analysis engine is temporarily unavailable. Please try again shortly.');
    }
    lastErr = new Error('groq ' + r.status + ' ' + body);
    // retry the stochastic failures: JSON-generation 400s, rate limits, and 5xx.
    // A 429 is a tokens-per-minute collision and Groq tells us exactly how long to wait — honour
    // that instead of the old 350ms, which always retried far too early to help.
    const retryable = (r.status === 400 && /json/i.test(body)) || r.status === 429 || r.status >= 500;
    if (retryable && i < tries - 1) {
      let wait = 350 * (i + 1);
      if (r.status === 429) {
        const hdr = Number(r.headers.get('retry-after'));
        const m = body.match(/try again in ([\d.]+)s/i);
        const secs = hdr || (m ? Number(m[1]) : 0);
        wait = Math.min(Math.ceil((secs || 5) * 1000) + 250, 12000);
      }
      await new Promise(res => setTimeout(res, wait));
      continue;
    }
    throw lastErr;
  }
  throw lastErr;
}

// ---- The analysis schema ----------------------------------------------------
// Strict mode uses constrained decoding, and it supports only a subset of JSON Schema: type,
// properties, required, additionalProperties, enum, items. Bounds like maxItems and maximum are
// NOT enforced, so every cap here is asked for in the prompt and clamped in code afterwards.
// Every property must appear in `required` — that is a strict-mode rule, not a preference.
const S = { type: 'string' };
const ITEM = { type: 'object', additionalProperties: false, required: ['title', 'who', 'detail'], properties: { title: S, who: S, detail: S } };
const TURN = {
  type: 'object', additionalProperties: false, required: ['speaker', 'display', 'speak', 'emotion'],
  properties: {
    speaker: { type: 'string', enum: ['A', 'B'] },
    display: S,
    speak: S,
    emotion: { type: 'string', enum: ['sad', 'attentive', 'sorry', 'happy', 'warm', 'neutral'] }
  }
};
const PERSON = { type: 'object', additionalProperties: false, required: ['name', 'gender'], properties: { name: S, gender: { type: 'string', enum: ['female', 'male', 'unknown'] } } };

const ANALYSIS_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['scores', 'summary', 'speakers', 'patterns', 'strengths', 'improvements', 'kpis', 'original', 'improved'],
  properties: {
    scores: {
      type: 'object', additionalProperties: false,
      required: ['connection', 'empathy', 'escalation_risk', 'overall'],
      properties: { connection: { type: 'integer' }, empathy: { type: 'integer' }, escalation_risk: { type: 'integer' }, overall: { type: 'integer' } }
    },
    summary: S,
    speakers: { type: 'object', additionalProperties: false, required: ['A', 'B'], properties: { A: PERSON, B: PERSON } },
    patterns: { type: 'array', items: ITEM },
    strengths: { type: 'array', items: ITEM },
    improvements: {
      type: 'array',
      items: { type: 'object', additionalProperties: false, required: ['pattern', 'suggestion', 'script'], properties: { pattern: S, suggestion: S, script: S } }
    },
    kpis: {
      type: 'object', additionalProperties: false,
      required: ['talk_balance', 'question_ratio', 'repair_attempts', 'self_reference'],
      properties: { talk_balance: S, question_ratio: S, repair_attempts: { type: 'integer' }, self_reference: S }
    },
    original: { type: 'array', items: TURN },
    improved: { type: 'array', items: TURN }
  }
};

const clampInt = (v, lo, hi) => Math.max(lo, Math.min(hi, Math.round(Number(v) || 0)));

// Strict decoding guarantees the shape, never the sense. Bound the arrays the prompt was asked to
// bound, and keep scores inside 0-100 so a stray 250 can never reach the score ring.
function sane(rep) {
  const r = rep || {};
  const sc = r.scores || {};
  for (const k of ['connection', 'empathy', 'escalation_risk', 'overall']) sc[k] = clampInt(sc[k], 0, 100);
  r.scores = sc;
  r.patterns = (r.patterns || []).slice(0, 4);
  r.strengths = (r.strengths || []).slice(0, 4);
  r.improvements = (r.improvements || []).slice(0, 3);
  r.original = (r.original || []).slice(0, 8);
  r.improved = (r.improved || []).slice(0, 8);
  return r;
}

const countWords = (s) => (String(s || '').trim().match(/\S+/g) || []).length;

// Trim a speaker-labelled transcript to both ceilings on a line boundary, so we never cut
// mid-turn. Whichever limit bites first wins, and the caller always learns it happened —
// silently shortening someone's conversation and then scoring it would be dishonest.
function capTranscript(text, maxWords = MAX_WORDS, maxChars = Math.min(MAX_CHARS, ANALYSIS_MAX_CHARS)) {
  const wordsTotal = countWords(text);
  const out = []; let kept = 0, chars = 0;
  for (const line of String(text).split('\n')) {
    const n = countWords(line);
    if (kept + n > maxWords) break;
    if (chars + line.length + 1 > maxChars) break;
    out.push(line); kept += n; chars += line.length + 1;
  }
  if (!out.length) {                                  // one enormous unbroken line
    const slice = String(text).slice(0, maxChars);
    out.push(slice); kept = countWords(slice);
  }
  return { text: out.join('\n'), truncated: kept < wordsTotal, wordsKept: kept, wordsTotal };
}

// ---- Public config -----------------------------------------------------------
// The only endpoint that answers without a principal, and it says nothing about anyone: just the
// switches the pre-login pages need. Without it the admin's "intro animation" toggle would be
// decorative, because intro.html runs before there is anyone to authenticate.
app.get('/api/config', async (req, res) => {
  try {
    const s = await settings();
    res.json({
      introEnabled: s.intro_enabled !== false,
      guestEnabled: s.guest_enabled !== false,
      limits: LIMITS
    });
  } catch (e) { res.json({ introEnabled: true, guestEnabled: true, limits: LIMITS }); }
});

// ---- Guest token issue (P0-T1) ----
app.post('/api/guest', async (req, res) => {
  try {
    if (!GUEST_SECRET) return res.status(503).json({ error: 'Guest access is not configured.' });
    const s = await settings();
    if (s.guest_enabled === false) return res.status(403).json({ error: 'Guest access is currently closed.' });
    const token = signGuest({ id: 'g_' + crypto.randomBytes(9).toString('hex'), exp: Date.now() + 2 * 3600 * 1000 });
    res.json({ token, expiresIn: 7200 });
  } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
});

// ---- Transcribe (Deepgram, diarized) -> speaker-labelled transcript ----
app.post('/api/transcribe', async (req, res) => {
  try {
    const principal = await requirePrincipal(req, res); if (!principal) return;
    if (!rateLimit('tr:' + principal.id, 6)) return res.status(429).json({ error: 'Slow down a moment, then try again.' });

    const { audioBase64, mime = 'audio/mpeg', nameA = 'A', nameB = 'B' } = req.body;
    const bytes = Buffer.from(audioBase64, 'base64');

    try { await checkQuota(principal, 1); } catch (e) { return quotaFail(res, e); }

    const r = await fetch('https://api.deepgram.com/v1/listen?model=nova-2&diarize=true&punctuate=true&smart_format=true', {
      method: 'POST', headers: { Authorization: 'Token ' + DEEPGRAM_KEY, 'Content-Type': mime }, body: bytes });
    if (!r.ok) throw new Error('deepgram ' + r.status);
    const d = await r.json();

    const seconds = Number(d?.metadata?.duration || 0);
    if (seconds > MAX_ANALYSABLE_SECONDS) {
      return res.status(413).json({
        error: `Right now we can read up to about ${EFFECTIVE_MAX_MINUTES} minutes in one go, and this recording is longer. Trim it to the part that matters most and we will take a proper look.`,
        limits: LIMITS
      });
    }

    const words = d?.results?.channels?.[0]?.alternatives?.[0]?.words || [];
    let out = '', cur = null, line = '';
    // turns: group contiguous same-speaker words, mapped speaker 0 -> "A", else "B", with word-level timing.
    const turns = [], lbl = (sp) => (sp === 0 ? 'A' : 'B');
    let tcur = null, ttext = '', tstart = 0, tend = 0;
    for (const w of words) { const sp = w.speaker ?? 0;
      if (sp !== cur) { if (line) out += (cur === 0 ? nameA : nameB) + ': ' + line.trim() + '\n'; cur = sp; line = ''; }
      line += (w.punctuated_word || w.word) + ' ';
      if (sp !== tcur) { if (ttext) turns.push({ speaker: lbl(tcur), start: tstart, end: tend, text: ttext.trim() }); tcur = sp; ttext = ''; tstart = w.start; }
      ttext += (w.punctuated_word || w.word) + ' '; tend = w.end; }
    if (line) out += (cur === 0 ? nameA : nameB) + ': ' + line.trim() + '\n';
    if (ttext) turns.push({ speaker: lbl(tcur), start: tstart, end: tend, text: ttext.trim() });

    // Word ceiling: keep the opening of a long conversation rather than failing it outright.
    const cap = capTranscript(out);
    const keptTurns = cap.truncated ? turns.slice(0, cap.text.split('\n').filter(Boolean).length) : turns;

    await chargeQuota(principal, Math.max(1, Math.round(seconds / 60)));
    res.json({
      transcript: cap.text, turns: keptTurns,
      truncated: cap.truncated, wordsKept: cap.wordsKept, wordsTotal: cap.wordsTotal,
      seconds
    });
  } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
});

// ---- Analyse (Groq x2) + persist ----
app.post('/api/analyze', async (req, res) => {
  try {
    const principal = await requirePrincipal(req, res); if (!principal) return;
    if (!rateLimit('an:' + principal.id, 6)) return res.status(429).json({ error: 'Slow down a moment, then try again.' });

    const { mode = 'relationship', submode = 'couple', nameA = 'Partner A', nameB = 'Partner B', consent, source = 'text' } = req.body;
    const user = principal.kind === 'user' ? principal.user : null;

    const cap = capTranscript(String(req.body.transcript || ''));
    const transcript = cap.text;
    if (!transcript.trim()) return res.status(400).json({ error: 'There is nothing to analyse yet.' });

    // Audio already paid at the transcribe step; only meter text arriving straight from a paste.
    const estMinutes = Math.max(1, Math.round(countWords(transcript) / 150));
    if (source !== 'audio') {
      try { await checkQuota(principal, estMinutes); } catch (e) { return quotaFail(res, e); }
    }

    const lens = mode === 'self'
      ? `This is one person reflecting on themselves (introspection). Analyse THEIR emotional regulation, self-talk, language patterns, and stress markers — not a relationship.`
      : submode === 'solo'
        ? `Only ${nameA} is present, describing a relationship situation. Analyse how ${nameA} shows up; infer the likely state of the absent partner where reasonable (clearly marked as inference).`
        : `A conversation between ${nameA} (A) and ${nameB} (B). Analyse the dynamics between them.`;

    // ONE call, not two. Both halves of the old prompt live here, which is what buys back the
    // tokens-per-minute headroom (see the GROQ_TPM note at the top). Strict json_schema means the
    // shape is decided by ANALYSIS_SCHEMA, so the prompt only has to explain the *judgement*.
    const naming = `Set speakers.A.name to exactly "${nameA}"${mode === 'relationship' && submode === 'couple' ? ` and speakers.B.name to exactly "${nameB}"` : ''}. In every "who" field and in all text, refer to the two people ONLY as "${nameA}" and "${nameB}" — never any other name, even if the transcript uses different ones. Infer each person's likely gender from their name and how they are addressed; use "unknown" only if genuinely unclear.`;

    const prompt = `You are an expert communication analyst trained in the Gottman method. ${lens}

--- CONVERSATION ---
${transcript}
--- END ---

Produce the analysis. Rules:

SCORES are 0-100. Higher is better for connection, empathy and overall; higher escalation_risk means MORE heat.

BE HONEST, NEVER PAD. "patterns" (max 4) and "improvements" (max 3) are for real issues only — if this exchange was healthy, return empty arrays rather than inventing weaknesses. Always surface genuine "strengths" (max 4). Stay neutral and non-blaming. KPIs are short descriptive awareness signals, not diagnoses. ${naming}

"original" (max 8 turns) is the pivotal stretch of the conversation as it ACTUALLY happened — the moment the improvements are responding to. Copy each line VERBATIM from the transcript above; never paraphrase, soften or invent a line. Choose the consecutive turns where the exchange turned, not the opening pleasantries. "emotion" is what that person genuinely sounded like in that moment.

"improved" (max 8 turns) is the SAME stretch replayed kindly, applying your own "improvements". It should mirror "original" turn for turn so the two can be compared side by side.

For every turn in BOTH arrays: "speaker" is exactly "A" or "B" and never a name; alternate as a real back-and-forth rather than labelling every turn the same speaker; "display" is the natural line (Hinglish/Devanagari fine); "speak" is a clean Roman transliteration for text-to-speech with no Devanagari; "emotion" must be fitting and varied, not neutral by default. "display" and "speak" contain ONLY the words spoken — never prefix a line with the speaker's name or a colon (write "Aaj phir call nahi kiya", NOT "${nameA}: Aaj phir call nahi kiya").${mode === 'self' ? '\n\nThis is a solo reflection, so there is no back-and-forth to replay: return empty arrays for "original" and "improved".' : ''}`;

    const rep = sane(json(await groq(prompt, { schema: ANALYSIS_SCHEMA, schemaName: 'samvaad_analysis' })));
    const original = mode === 'relationship' ? (rep.original || []) : [];
    const improved = mode === 'relationship' ? (rep.improved || []) : [];

    if (source !== 'audio') await chargeQuota(principal, estMinutes);

    let sessionId = null;
    if (user && admin) {
      // Record which act-1 variant this account was on. Without it the A/B is unreadable later:
      // feedback rows would say how people responded but not to which version.
      const act1 = resolveAct1(await ensureProfile(principal), await settings());
      const base = {
        user_id: user.id, mode, submode, name_a: nameA, name_b: nameB,
        scores: rep.scores, summary: rep.summary, patterns: rep.patterns,
        strengths: rep.strengths, improvements: rep.improvements, improved, kpis: rep.kpis || {}
      };
      // speakers/truncated/original arrive with the migrations; fall back if they have not run yet.
      let { data, error } = await admin.from('sessions')
        .insert({ ...base, speakers: rep.speakers || {}, truncated: cap.truncated, original, act1_mode: act1 })
        .select('id').single();
      if (error) {
        console.warn('[samvaad] session insert fell back (run the Phase 0 migration):', error.message);
        ({ data } = await admin.from('sessions').insert(base).select('id').single());
      }
      sessionId = data?.id || null;
      if (sessionId && consent) await admin.from('consents').insert({ user_id: user.id, session_id: sessionId, kind: consent });
    }
    res.json({ ...rep, original, improved, sessionId, truncated: cap.truncated, wordsKept: cap.wordsKept, wordsTotal: cap.wordsTotal, limits: LIMITS });
  } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
});

// ---- Text to speech (ElevenLabs) ----
app.post('/api/tts', async (req, res) => {
  try {
    const principal = await requirePrincipal(req, res); if (!principal) return;
    if (!rateLimit('tts:' + principal.id, 40)) return res.status(429).json({ error: 'Too many voice requests.' });

    const { text, speaker = 'A' } = req.body;
    if (!text || String(text).length > 1000) return res.status(400).json({ error: 'Nothing to say, or the line is too long.' });
    const vid = speaker === 'A' ? ELEVEN_VOICE_A : ELEVEN_VOICE_B;
    const r = await fetch('https://api.elevenlabs.io/v1/text-to-speech/' + vid, {
      method: 'POST', headers: { 'xi-api-key': ELEVENLABS_KEY, 'content-type': 'application/json' },
      body: JSON.stringify({ text, model_id: 'eleven_multilingual_v2', voice_settings: { stability: 0.4, similarity_boost: 0.7 } }) });
    if (!r.ok) { let detail = ''; try { detail = await r.text(); } catch (_) {} return res.status(502).json({ error: 'eleven ' + r.status, detail: detail.slice(0, 700) }); }
    res.set('content-type', 'audio/mpeg'); res.send(Buffer.from(await r.arrayBuffer()));
  } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
});

// ---- Feedback loop ----
// Whitelist the columns and surface the error. Previously this spread req.body straight into the
// insert with a millisecond integer for asked_at (a timestamptz), and swallowed the failure.
app.post('/api/feedback', async (req, res) => {
  try {
    const user = await getUser(req);
    if (!user || !admin) return res.json({ ok: true, stored: false });
    const { session_id = null, context = {}, top_suggestion = null, will_try = null } = req.body || {};
    if (will_try && !['yes', 'maybe', 'no'].includes(will_try)) return res.status(400).json({ error: 'Bad value for will_try.' });
    const { error } = await admin.from('feedback').insert({
      user_id: user.id, session_id, context, top_suggestion, will_try,
      asked_at: new Date().toISOString()
    });
    if (error) { console.error('[samvaad] feedback insert failed:', error.message); return res.status(500).json({ error: 'Could not save that.' }); }
    res.json({ ok: true, stored: true });
  } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
});

// ---- History for the dashboard ----
app.get('/api/history', async (req, res) => {
  try {
    const p = await getPrincipal(req);
    const q = p ? forUser('sessions', p) : null;
    if (!q) return res.json({ sessions: [] });
    const { data } = await q.order('created_at', { ascending: false }).limit(100);
    res.json({ sessions: data || [] });
  } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
});

// ---- Who am I: profile, quota and feature flags for the app shell ----
app.get('/api/me', async (req, res) => {
  try {
    const p = await getPrincipal(req);
    if (!p) return res.status(401).json({ error: 'Please sign in.' });
    const s = await settings();
    if (p.kind === 'guest') {
      return res.json({
        kind: 'guest', status: 'active', features: {}, quota: { minutes: null },
        act1: resolveAct1(null, s), limits: LIMITS, selfMode: s.self_reflection_enabled === true
      });
    }
    const prof = await ensureProfile(p);
    const used = (prof && prof.quota_month === monthKey()) ? Number(prof.minutes_used_month || 0) : 0;
    res.json({
      kind: 'user', email: p.user?.email || null,
      status: prof?.status || 'active',
      phone: prof?.phone || null, phoneVerified: !!prof?.phone_verified,
      features: prof?.features || {},
      quota: { minutes: Number(prof?.minutes_quota || DEFAULT_MINUTES_QUOTA), used },
      act1: resolveAct1(prof, s),
      limits: LIMITS,
      // "Just me" is built and kept, but it is off for the trial cohort unless someone is
      // explicitly flagged in. Global switch first, per-user flag can open it for one tester.
      selfMode: (prof?.features?.self_reflection === true) || s.self_reflection_enabled === true
    });
  } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
});

// ---- WhatsApp daily check-in opt-in (STUB — no messages sent yet) ----
// Captures the USER'S OWN number + explicit consent only. Partner numbers are intentionally
// never collected (DPDP two-party-consent posture). To go live: pick a provider (Meta WhatsApp
// Cloud API / Gupshup / Interakt / Twilio), add its keys to .env, and implement the send where
// the TODO is, plus a daily scheduler (cron / Supabase scheduled function) that reads this table.
app.post('/api/optin', async (req, res) => {
  try {
    const user = await getUser(req);
    const { phone, display_name = null, cadence = 'daily', consent = true, active = true } = req.body || {};
    const norm = String(phone || '').replace(/[^\d+]/g, '');
    if (!/^(\+?91)?[6-9]\d{9}$/.test(norm)) return res.status(400).json({ error: 'Enter a valid Indian mobile number.' });
    if (!consent) return res.status(400).json({ error: 'Consent is required to send check-ins.' });
    if (user && admin) {
      await admin.from('nudge_subscriptions').upsert({
        user_id: user.id, phone: norm, display_name, cadence,
        consent: !!consent, active: !!active, updated_at: new Date().toISOString()
      }, { onConflict: 'user_id' });
    }
    // TODO(provider): register/queue the daily template send here once WhatsApp is configured.
    res.json({ ok: true, stub: true, message: 'Saved — your daily check-in begins once messaging goes live. 🌼' });
  } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
});

// ---- Phone: the account key -------------------------------------------------
// The trial identifies people by WhatsApp number, because that is the channel the report is
// delivered on. Only the user's OWN number, never a partner's (DPDP two-party consent).
// `phone` is UNIQUE on profiles, so a second account claiming the same number is refused here
// rather than blowing up as a raw Postgres conflict.
const normalisePhone = (p) => {
  const d = String(p || '').replace(/[^\d]/g, '');
  return d.length === 10 ? '91' + d : d.replace(/^0+/, '');
};

app.post('/api/profile/phone', async (req, res) => {
  try {
    const user = await getUser(req);
    if (!user) return res.status(401).json({ error: 'Please sign in first.' });
    if (!admin) return res.status(503).json({ error: 'Not configured.' });

    const phone = normalisePhone(req.body?.phone);
    if (!/^91[6-9]\d{9}$/.test(phone)) return res.status(400).json({ error: 'Enter a valid Indian mobile number.' });

    const { data: taken } = await admin.from('profiles').select('user_id').eq('phone', phone).maybeSingle();
    if (taken && taken.user_id !== user.id) {
      return res.status(409).json({ error: 'That number is already linked to another account.' });
    }

    await ensureProfile({ kind: 'user', id: user.id, user });
    const { error } = await admin.from('profiles').update({
      phone, display_name: (req.body?.display_name || null), updated_at: new Date().toISOString()
    }).eq('user_id', user.id);
    if (error) { console.error('[samvaad] phone save failed:', error.message); return res.status(500).json({ error: 'Could not save that number.' }); }

    res.json({ ok: true, phone, verified: false });
  } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
});

// ---- Admin gate: allowlist of Supabase auth user ids in env ADMIN_USER_IDS ----
async function requireAdmin(req, res) {
  const u = await getUser(req);
  const ids = (process.env.ADMIN_USER_IDS || '').split(',').map(s => s.trim()).filter(Boolean);
  if (!ids.length) {
    console.warn('[samvaad] ADMIN_USER_IDS is unset — every admin call will be refused.');
  }
  if (!u || !ids.includes(u.id)) { res.status(403).json({ error: 'Admin only.' }); return null; }
  return u;
}

// ---- Admin: every account, with the levers attached -------------------------
// One row per signed-up user: who they are, what they have used, and the state the admin can
// change. Deliberately assembled here rather than in the browser so admin.html stays a thin view.
app.get('/api/admin/users', async (req, res) => {
  try {
    if (!(await requireAdmin(req, res))) return;
    if (!admin) return res.json({ users: [] });

    const [authList, profRes, sessRes, optRes] = await Promise.all([
      admin.auth.admin.listUsers({ page: 1, perPage: 500 }),
      admin.from('profiles').select('*'),
      admin.from('sessions').select('user_id, created_at, scores, act1_mode'),
      admin.from('nudge_subscriptions').select('user_id, phone, active, consent')
    ]);

    const profiles = new Map((profRes.data || []).map(p => [p.user_id, p]));
    const optins = new Map((optRes.data || []).map(o => [o.user_id, o]));
    const stats = new Map();
    for (const s of (sessRes.data || [])) {
      if (!s.user_id) continue;
      const st = stats.get(s.user_id) || { count: 0, last: null, scoreSum: 0, scoreN: 0 };
      st.count++;
      if (!st.last || s.created_at > st.last) st.last = s.created_at;
      const ov = Number(s.scores?.overall);
      if (Number.isFinite(ov)) { st.scoreSum += ov; st.scoreN++; }
      stats.set(s.user_id, st);
    }

    const s = await settings();
    const users = (authList?.data?.users || []).map(u => {
      const p = profiles.get(u.id) || {};
      const st = stats.get(u.id) || { count: 0, last: null, scoreSum: 0, scoreN: 0 };
      const usedThisMonth = p.quota_month === monthKey() ? Number(p.minutes_used_month || 0) : 0;
      return {
        id: u.id,
        email: u.email || null,
        phone: p.phone || optins.get(u.id)?.phone || null,
        phoneVerified: !!p.phone_verified,
        displayName: p.display_name || null,
        status: p.status || 'active',
        act1: resolveAct1(p, s),
        act1Override: (p.features && p.features.act1) || null,
        features: p.features || {},
        minutesQuota: Number(p.minutes_quota ?? DEFAULT_MINUTES_QUOTA),
        minutesUsed: usedThisMonth,
        analyses: st.count,
        avgScore: st.scoreN ? Math.round(st.scoreSum / st.scoreN) : null,
        lastActive: st.last,
        signedUpAt: u.created_at || null,
        lastSignInAt: u.last_sign_in_at || null,
        nudgeOptIn: !!(optins.get(u.id)?.consent && optins.get(u.id)?.active),
        hasProfile: profiles.has(u.id)
      };
    });

    users.sort((a, b) => String(b.lastActive || b.signedUpAt || '').localeCompare(String(a.lastActive || a.signedUpAt || '')));
    res.json({ users, count: users.length });
  } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
});

// ---- Admin: change one account ----------------------------------------------
// Pause, resume, suspend, raise the limit, reset the month, pin an act-1 variant. Whitelisted:
// this endpoint writes with the service role, so an unfiltered body spread would be a way to
// write anything into anyone's profile.
app.patch('/api/admin/users/:id', async (req, res) => {
  try {
    if (!(await requireAdmin(req, res))) return;
    if (!admin) return res.status(503).json({ error: 'Not configured.' });

    const id = String(req.params.id || '');
    if (!/^[0-9a-f-]{36}$/i.test(id)) return res.status(400).json({ error: 'Bad user id.' });

    const { data: existing } = await admin.from('profiles').select('*').eq('user_id', id).maybeSingle();
    const patch = { updated_at: new Date().toISOString() };
    const body = req.body || {};

    if (body.status !== undefined) {
      if (!['active', 'limited', 'suspended'].includes(body.status)) return res.status(400).json({ error: 'Bad status.' });
      patch.status = body.status;
    }
    if (body.minutesQuota !== undefined) {
      const q = Number(body.minutesQuota);
      if (!Number.isFinite(q) || q < 0 || q > 100000) return res.status(400).json({ error: 'Bad quota.' });
      patch.minutes_quota = q;
    }
    if (body.resetUsage === true) { patch.minutes_used_month = 0; patch.quota_month = monthKey(); }
    if (body.act1 !== undefined) {
      // null clears the override and hands the account back to the global default
      if (body.act1 !== null && !ACT1_MODES.includes(body.act1)) return res.status(400).json({ error: 'Bad act1 mode.' });
      const features = { ...(existing?.features || {}) };
      if (body.act1 === null) delete features.act1; else features.act1 = body.act1;
      patch.features = features;
    }
    if (body.selfMode !== undefined) {
      const features = { ...(patch.features || existing?.features || {}) };
      features.self_reflection = !!body.selfMode;
      patch.features = features;
    }
    if (Object.keys(patch).length === 1) return res.status(400).json({ error: 'Nothing to change.' });

    if (existing) {
      const { error } = await admin.from('profiles').update(patch).eq('user_id', id);
      if (error) throw new Error(error.message);
    } else {
      const { error } = await admin.from('profiles').insert({ user_id: id, minutes_quota: DEFAULT_MINUTES_QUOTA, ...patch });
      if (error) throw new Error(error.message);
    }

    const { data: after } = await admin.from('profiles').select('*').eq('user_id', id).maybeSingle();
    res.json({ ok: true, profile: after || null });
  } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
});

// ---- Admin: the global switches ---------------------------------------------
// Everything here is something a non-technical admin should be able to flip without an env var
// or a deploy, which was the whole point of app_settings.
const SETTING_KEYS = {
  guest_enabled: v => typeof v === 'boolean',
  self_reflection_enabled: v => typeof v === 'boolean',
  intro_enabled: v => typeof v === 'boolean',
  act1_mode: v => ACT1_MODES.includes(v),
  default_minutes_quota: v => Number.isFinite(Number(v)) && Number(v) >= 0
};

app.get('/api/admin/settings', async (req, res) => {
  try {
    if (!(await requireAdmin(req, res))) return;
    const s = await settings();
    res.json({
      settings: {
        guest_enabled: s.guest_enabled !== false,
        self_reflection_enabled: s.self_reflection_enabled === true,
        intro_enabled: s.intro_enabled !== false,
        act1_mode: ACT1_MODES.includes(s.act1_mode) ? s.act1_mode : ACT1_DEFAULT,
        default_minutes_quota: Number(s.default_minutes_quota ?? DEFAULT_MINUTES_QUOTA)
      },
      act1Modes: ACT1_MODES,
      engine: { model: GROQ_MODEL, tpm: GROQ_TPM, limits: LIMITS }
    });
  } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
});

app.patch('/api/admin/settings', async (req, res) => {
  try {
    if (!(await requireAdmin(req, res))) return;
    if (!admin) return res.status(503).json({ error: 'Not configured.' });

    const rows = [];
    for (const [k, v] of Object.entries(req.body || {})) {
      const ok = SETTING_KEYS[k];
      if (!ok) return res.status(400).json({ error: 'Unknown setting: ' + k });
      if (!ok(v)) return res.status(400).json({ error: 'Bad value for ' + k });
      rows.push({ key: k, value: v, updated_at: new Date().toISOString() });
    }
    if (!rows.length) return res.status(400).json({ error: 'Nothing to change.' });

    const { error } = await admin.from('app_settings').upsert(rows, { onConflict: 'key' });
    if (error) throw new Error(error.message);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
});

// ---- Admin: today's manual WhatsApp nudge list (E3-T1) — ADMIN only ----
app.get('/api/admin/nudges', async (req, res) => {
  try {
    if (!(await requireAdmin(req, res))) return;
    const suggestedMessage = 'Hi! How was your day today? 🌿 Take a minute to reflect — open Samvaad, try "Just me", and let it help you unwind.';
    let nudges = [];
    if (admin) {
      const { data } = await admin.from('nudge_subscriptions')
        .select('phone, display_name, cadence, created_at')
        .eq('consent', true).eq('active', true);
      nudges = data || [];
    }
    res.json({ count: nudges.length, suggestedMessage, nudges });
  } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
});

// ---- Admin: pre-launch business metrics — ADMIN only ----
// Rewritten for the trial cohort. The old solo-to-couple conversion rate is gone: with a single
// Relationship mode there is no solo session to convert FROM, so reporting it would be a number
// that can only ever read zero. What replaces it is the funnel that actually exists now —
// signed up, gave a number, ran something, came back — plus the act-1 A/B this trial is here
// to settle.
app.get('/api/admin/kpis', async (req, res) => {
  try {
    if (!(await requireAdmin(req, res))) return;

    let sessionRows = [], profileRows = [], feedbackRows = [], optinsTotal = 0, authUsers = [];
    if (admin) {
      const [s, o, pr, fb, au] = await Promise.all([
        admin.from('sessions').select('id, user_id, mode, submode, created_at, scores, act1_mode, truncated'),
        admin.from('nudge_subscriptions').select('user_id', { count: 'exact', head: true }).eq('consent', true).eq('active', true),
        admin.from('profiles').select('user_id, status, phone, minutes_used_month, quota_month'),
        admin.from('feedback').select('will_try, session_id, asked_at'),
        admin.auth.admin.listUsers({ page: 1, perPage: 500 })
      ]);
      sessionRows = s.data || [];
      optinsTotal = o.count || 0;
      profileRows = pr.data || [];
      feedbackRows = fb.data || [];
      authUsers = au?.data?.users || [];
    }

    const now = Date.now(), DAY = 86400000;
    const since = (d) => new Date(now - d * DAY).toISOString();
    const d1 = since(1), d7 = since(7);

    // --- activity ---
    const perUser = new Map();
    let scoreSum = 0, scoreN = 0, riskSum = 0, riskN = 0, truncated = 0;
    for (const r of sessionRows) {
      if (r.user_id) perUser.set(r.user_id, (perUser.get(r.user_id) || 0) + 1);
      const ov = Number(r.scores?.overall); if (Number.isFinite(ov)) { scoreSum += ov; scoreN++; }
      const rk = Number(r.scores?.escalation_risk); if (Number.isFinite(rk)) { riskSum += rk; riskN++; }
      if (r.truncated) truncated++;
    }
    const activated = perUser.size;
    const returning = [...perUser.values()].filter(n => n >= 2).length;

    // --- funnel ---
    const withPhone = profileRows.filter(p => p.phone).length;
    const byStatus = { active: 0, limited: 0, suspended: 0 };
    for (const p of profileRows) byStatus[p.status] = (byStatus[p.status] || 0) + 1;
    const signups = authUsers.length || profileRows.length;
    const activeLast7 = new Set(sessionRows.filter(r => r.created_at >= d7).map(r => r.user_id)).size;

    // --- the act-1 experiment ---
    // Which replay opening makes someone say they will actually try the suggested line.
    // That "will_try = yes" rate is the only outcome worth comparing the two variants on.
    const sessionAct1 = new Map(sessionRows.map(r => [r.id || r.session_id, r.act1_mode]));
    const exp = {};
    for (const m of ACT1_MODES) exp[m] = { sessions: 0, feedback: 0, yes: 0, maybe: 0, no: 0, willTryRate: null };
    for (const r of sessionRows) { const m = r.act1_mode; if (exp[m]) exp[m].sessions++; }
    for (const f of feedbackRows) {
      const m = sessionAct1.get(f.session_id);
      if (!exp[m] || !f.will_try) continue;
      exp[m].feedback++;
      if (exp[m][f.will_try] !== undefined) exp[m][f.will_try]++;
    }
    for (const m of ACT1_MODES) {
      const e = exp[m];
      e.willTryRate = e.feedback ? Math.round((e.yes / e.feedback) * 100) : null;
    }

    // --- capacity ---
    const minutesThisMonth = profileRows
      .filter(p => p.quota_month === monthKey())
      .reduce((a, p) => a + Number(p.minutes_used_month || 0), 0);

    // voice (ElevenLabs) quota — best effort, never fails the KPI response
    let voice = { ok: false, error: 'no key set' };
    try {
      if (ELEVENLABS_KEY) {
        const vr = await fetch('https://api.elevenlabs.io/v1/user/subscription', { headers: { 'xi-api-key': ELEVENLABS_KEY } });
        if (vr.ok) {
          const v = await vr.json();
          const used = v.character_count || 0, limit = v.character_limit || 0;
          voice = { ok: true, tier: v.tier || '', used, limit, remaining: Math.max(0, limit - used), exhausted: limit > 0 && used >= limit, resetUnix: v.next_character_count_reset_unix || null };
        } else {
          let d = ''; try { d = await vr.text(); } catch (_) {}
          voice = { ok: false, error: 'eleven ' + vr.status, detail: d.slice(0, 300) };
        }
      }
    } catch (e) { voice = { ok: false, error: String(e.message || e) }; }

    res.json({
      funnel: {
        signups, withPhone, activated, returning,
        activationRate: signups ? Math.round((activated / signups) * 100) : 0,
        returnRate: activated ? Math.round((returning / activated) * 100) : 0,
        optins: optinsTotal
      },
      activity: {
        analyses: sessionRows.length,
        today: sessionRows.filter(r => r.created_at >= d1).length,
        last7: sessionRows.filter(r => r.created_at >= d7).length,
        activeLast7,
        perActivatedUser: activated ? Math.round((sessionRows.length / activated) * 10) / 10 : 0,
        truncated
      },
      quality: {
        avgScore: scoreN ? Math.round(scoreSum / scoreN) : null,
        avgEscalation: riskN ? Math.round(riskSum / riskN) : null,
        feedbackGiven: feedbackRows.filter(f => f.will_try).length
      },
      accounts: byStatus,
      experiment: exp,
      capacity: { minutesThisMonth, model: GROQ_MODEL, tpm: GROQ_TPM, limits: LIMITS },
      voice
    });
  } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
});

app.get('/health', (_, res) => res.json({ ok: true }));
app.listen(process.env.PORT || 8787, () => console.log('Samvaad backend on', process.env.PORT || 8787));
