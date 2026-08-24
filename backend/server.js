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
// The trial allowance. Everyone who signs up gets this many analyses, full stop — not per month,
// not per day. It is a taste of the product, and raising it for someone is a deliberate act the
// admin takes on the People tab. Minutes remain as a second guard against one enormous upload
// eating the budget, but ANALYSES is the limit a tester will actually meet.
const DEFAULT_ANALYSES_QUOTA = 3;
const GUEST_ANALYSES_PER_DAY = 3;
const DEFAULT_MINUTES_QUOTA = 60;

// ---- The analysis model ----------------------------------------------------
// Groq retires models on a schedule. llama-3.3-70b-versatile was announced dead on 2026-06-17 and
// stopped being served in Aug 2026, and the failure mode was a bare `model_decommissioned` 400
// that cost a day to diagnose. So the model is no longer a constant: we ask Groq what it actually
// serves and take the best one we recognise. Setting GROQ_MODEL pins it explicitly and skips all
// of this; leaving it unset means the next decommission repairs itself.
//
// Ordered best-first. Only chat models that can follow a json_schema belong here — the account
// also lists whisper (speech), orpheus (TTS) and prompt-guard (moderation) models, which would
// each fail in their own confusing way if they were ever picked.
const MODEL_PREFERENCE = [
  'openai/gpt-oss-120b',
  'qwen/qwen3.6-27b',
  'openai/gpt-oss-20b',
  'groq/compound'
];
const PINNED_MODEL = process.env.GROQ_MODEL || null;
let resolvedModel = PINNED_MODEL;          // null until the first lookup succeeds
let modelLookup = null;                    // in-flight promise, so a burst does one lookup

async function listGroqModels() {
  const r = await fetch('https://api.groq.com/openai/v1/models', {
    headers: { authorization: 'Bearer ' + GROQ_API_KEY }
  });
  if (!r.ok) throw new Error('groq models ' + r.status);
  const d = await r.json();
  return (d.data || []).map(m => m.id);
}

// `force` re-resolves after a decommission, ignoring what we cached.
async function analysisModel(force = false) {
  if (PINNED_MODEL && !force) return PINNED_MODEL;
  if (resolvedModel && !force) return resolvedModel;
  if (!modelLookup) {
    modelLookup = (async () => {
      try {
        const ids = await listGroqModels();
        const pick = MODEL_PREFERENCE.find(m => ids.includes(m));
        if (pick) {
          if (pick !== resolvedModel) console.log('[samvaad] analysis model:', pick);
          resolvedModel = pick;
        } else {
          // Nothing we know is being served. Say so loudly and keep the last known good one:
          // a stale model that might still work beats guessing at an unknown one.
          console.error('[samvaad] none of the known models are available. Groq offers:', ids.join(', '),
            '\n  Add a current chat model to MODEL_PREFERENCE, or set GROQ_MODEL.');
        }
      } catch (e) {
        console.warn('[samvaad] could not list Groq models (' + e.message + '); using', resolvedModel || MODEL_PREFERENCE[0]);
      } finally {
        modelLookup = null;
      }
      return resolvedModel || MODEL_PREFERENCE[0];
    })();
  }
  return modelLookup;
}

// The real ceiling is not our preference, it is Groq's tokens-per-minute limit: Groq counts
// prompt + max_tokens against TPM. The analysis used to be TWO calls inside the same minute, so
// each could use only half the budget; merging them into one is most of why a real conversation
// fits at all. Raising GROQ_TPM after upgrading the Groq plan is the single knob that lifts the
// limit, and nothing else needs to change.
//
// Everything below is measured against the live API on 2026-08-25, not estimated:
//   instructions + schema, no transcript ...........  ~750 prompt tokens
//   completion at reasoning_effort 'low' ............ 1861-2069 tokens
//   completion at default (high) effort ............. 3837 tokens, of which 2252 are reasoning
// gpt-oss-120b is a reasoning model, so the default effort spends more than half the response
// budget thinking. At 'low' the same conversation scored identically across runs and came back in
// half the time, so that is what we send. max_tokens carries headroom over the observed peak
// because Groq charges the RESERVATION, not the usage — too high wastes throughput, too low
// truncates mid-JSON.
const GROQ_TPM = Number(process.env.GROQ_TPM || 8000);
const GROQ_MAX_TOKENS = 2800;                 // reserved for the response, and counted against TPM
const CHARS_PER_TOKEN = 2.6;                  // measured on romanised Hinglish, which is dense
const PROMPT_OVERHEAD_TOKENS = 850;           // instructions + the json_schema, which is itself input
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
    const s = await settings();
    const { data: made } = await admin.from('profiles')
      .insert({
        user_id: principal.id,
        minutes_quota: Number(s.default_minutes_quota ?? DEFAULT_MINUTES_QUOTA),
        analyses_quota: Number(s.default_analyses_quota ?? DEFAULT_ANALYSES_QUOTA)
      })
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
      // Same code as the signed-in wall so the app renders one kind of screen, different message
      // because the way out is different: a guest signs in, a member asks us for more.
      throw { status: 429, code: 'analyses_exhausted',
              message: `That is ${GUEST_ANALYSES_PER_DAY} for today as a guest. Sign in and your reflections start being saved, too.` };
    }
    return;
  }
  const p = await ensureProfile(principal);
  if (!p) return;                                     // no DB configured; nothing to enforce
  if (p.status === 'suspended') {
    throw { status: 403, message: 'This account is paused. Please reach out to us and we will sort it out.' };
  }
  // The trial allowance. `analyses_quota` is null on rows created before this existed — treat
  // those as the default rather than as unlimited, so an early tester is not accidentally exempt.
  const quota = Number(p.analyses_quota ?? DEFAULT_ANALYSES_QUOTA);
  const spent = Number(p.analyses_used || 0);
  if (spent >= quota) {
    throw {
      status: 429,
      message: `That was your last of ${quota} conversations on the trial. Message us and we will open up more.`,
      code: 'analyses_exhausted'
    };
  }
  const used = (p.quota_month === monthKey()) ? Number(p.minutes_used_month || 0) : 0;
  if (used + minutes > Number(p.minutes_quota || DEFAULT_MINUTES_QUOTA)) {
    throw { status: 429, message: 'You have used this month’s analysis time. Message us and we can raise it.' };
  }
}

// `countsAsAnalysis` is false for the transcribe step: an upload is transcribed and then analysed,
// and charging both would silently halve everyone's allowance.
async function chargeQuota(principal, minutes, countsAsAnalysis = false) {
  if (principal.kind === 'guest') {
    if (!countsAsAnalysis) return;
    const day = new Date().toISOString().slice(0, 10);
    const u = guestUse.get(principal.id);
    guestUse.set(principal.id, { day, count: (u && u.day === day ? u.count : 0) + 1 });
    return;
  }
  if (!admin) return;
  const p = await ensureProfile(principal);
  if (!p) return;
  const used = (p.quota_month === monthKey()) ? Number(p.minutes_used_month || 0) : 0;
  const patch = {
    minutes_used_month: used + minutes, quota_month: monthKey(), updated_at: new Date().toISOString()
  };
  if (countsAsAnalysis) patch.analyses_used = Number(p.analyses_used || 0) + 1;
  await admin.from('profiles').update(patch).eq('user_id', principal.id);
}

// What a caller has left, for /api/me and for the refusal message.
async function allowance(principal) {
  if (principal.kind === 'guest') {
    const day = new Date().toISOString().slice(0, 10);
    const u = guestUse.get(principal.id);
    const used = (u && u.day === day) ? u.count : 0;
    return { quota: GUEST_ANALYSES_PER_DAY, used, left: Math.max(0, GUEST_ANALYSES_PER_DAY - used), perDay: true };
  }
  const p = await ensureProfile(principal);
  if (!p) return { quota: null, used: 0, left: null, perDay: false };
  const quota = Number(p.analyses_quota ?? DEFAULT_ANALYSES_QUOTA);
  const used = Number(p.analyses_used || 0);
  return { quota, used, left: Math.max(0, quota - used), perDay: false };
}

const quotaFail = (res, e) => res.status(e.status || 500).json({ error: e.message || String(e), code: e.code || null });

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

// ---- Tokens-per-minute governor ---------------------------------------------
// Groq bills the RESERVATION (prompt + max_tokens) against a rolling per-minute ceiling, and one
// analysis reserves roughly 3,700 of the free tier's 8,000. So two people analysing in the same
// minute is not an edge case, it is Tuesday — and the raw failure is a 429 with a wall of English
// about upgrading your plan. Worse, the retry then re-reserves the whole amount and collides with
// itself, which is exactly what happened the first time this ran against a live key.
//
// So we queue instead of colliding: hold the tokens we are about to spend, and if a request does
// not fit the window, wait for the oldest spend to age out rather than firing and failing.
const tpmWindow = [];                         // [{ at, tokens }]
const TPM_MAX_WAIT_MS = 45000;                // beyond this, tell the user honestly

function tpmUsed(now) {
  while (tpmWindow.length && now - tpmWindow[0].at > 60000) tpmWindow.shift();
  return tpmWindow.reduce((a, x) => a + x.tokens, 0);
}
async function tpmReserve(tokens) {
  const deadline = Date.now() + TPM_MAX_WAIT_MS;
  for (;;) {
    const now = Date.now();
    const used = tpmUsed(now);
    if (used + tokens <= GROQ_TPM) { tpmWindow.push({ at: now, tokens }); return; }
    // wait just past the moment the oldest reservation leaves the 60s window
    const wait = tpmWindow.length ? (60000 - (now - tpmWindow[0].at)) + 250 : 1000;
    if (now + wait > deadline) {
      // Not a fault: the free tier's per-minute budget is genuinely spoken for. 503 + Retry-After
      // says "come back", where a 500 would say "we broke" and get logged as an outage.
      const e = new Error('A few conversations are being read right now. Give it a minute and try again.');
      e.status = 503; e.retryAfter = 60;
      throw e;
    }
    await new Promise(r => setTimeout(r, Math.max(500, wait)));
  }
}

// Ask for a schema-shaped response when we have a schema, plain JSON otherwise.
//
// A warning worth keeping: on Groq, `strict: true` is NOT constrained decoding. The model
// generates freely and the result is validated afterwards, so an enum value the model invents
// comes back as a 400 rather than being made impossible. That is why the schema this sends uses
// plain strings where the vocabulary matters and normalises them in code (see sane()) — an enum
// there turned perfectly good analyses into json_validate_failed.
async function groq(prompt, { schema = null, schemaName = 'result', tries = 3 } = {}) {
  const format = schema
    ? { type: 'json_schema', json_schema: { name: schemaName, strict: true, schema } }
    : { type: 'json_object' };
  const model = await analysisModel();
  const reserve = Math.ceil(prompt.length / CHARS_PER_TOKEN) + PROMPT_OVERHEAD_TOKENS + GROQ_MAX_TOKENS;
  let lastErr;
  for (let i = 0; i < tries; i++) {
    await tpmReserve(reserve);
    const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'authorization': 'Bearer ' + GROQ_API_KEY },
      // temperature 0 + a fixed seed + low reasoning effort: the same conversation should not score
      // differently on a re-run. Measured identical across consecutive runs.
      body: JSON.stringify({ model, max_tokens: GROQ_MAX_TOKENS, temperature: 0, seed: 7, reasoning_effort: 'low', response_format: format, messages: [{ role: 'user', content: prompt }] })
    });
    if (r.ok) { const d = await r.json(); return (d.choices || []).map(c => c.message?.content || '').join(''); }
    const body = (await r.text()).slice(0, 300);
    // 413 means we blew the tokens-per-minute ceiling. Raw Groq text is no help to a user.
    if (r.status === 413) throw new Error('This conversation is longer than we can read in one go right now. Try a shorter section.');
    // A retired model. Re-ask Groq what it serves and try again on the replacement, so the next
    // decommission is a blip in the logs instead of an outage. Only if the model was not pinned:
    // an explicit GROQ_MODEL is an instruction, and silently using a different one would be worse.
    if (/model_decommissioned|does not exist|model_not_found/i.test(body)) {
      console.error('[samvaad] model "' + model + '" is no longer served by Groq.');
      if (!PINNED_MODEL && i < tries - 1) {
        await analysisModel(true);
        continue;
      }
      console.error('[samvaad] set GROQ_MODEL to a current id from https://console.groq.com/docs/models, or unset it to auto-select.');
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
        // Honour what Groq actually asks for. The old 12s cap was below the ~18s it requested in
        // practice, so every rate-limit retry fired early, failed again, and burned the budget a
        // second time. If it wants 30s, wait 30s.
        wait = Math.min(Math.ceil((secs || 5) * 1000) + 250, 40000);
        // The window is already spoken for; do not let the governor double-count this attempt.
        tpmWindow.length = 0;
      }
      await new Promise(res => setTimeout(res, wait));
      continue;
    }
    throw lastErr;
  }
  throw lastErr;
}

// ---- The analysis schema ----------------------------------------------------
// Two hard-won rules live in this shape.
//
// 1. NO ENUMS. Groq validates the finished JSON instead of constraining generation, so an enum is
//    not a guarantee, it is a tripwire: the model returned emotion "defensive" (a perfectly
//    reasonable reading of the conversation) and the whole analysis came back as a 400. Every
//    controlled vocabulary is a plain string here and is mapped onto ours in sane().
// 2. Every property must appear in `required`, and bounds like maxItems are ignored, so the caps
//    are asked for in the prompt and enforced in code.
const S = { type: 'string' };
const ITEM = { type: 'object', additionalProperties: false, required: ['title', 'who', 'detail'], properties: { title: S, who: S, detail: S } };
const TURN = {
  type: 'object', additionalProperties: false, required: ['speaker', 'display', 'speak', 'emotion'],
  properties: { speaker: S, display: S, speak: S, emotion: S }
};
const PERSON = { type: 'object', additionalProperties: false, required: ['name', 'gender'], properties: { name: S, gender: S } };

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

// The avatars can wear six expressions. The model, asked for a feeling, reaches for the whole
// English language — "defensive", "frustrated", "hopeful". Map onto what the rigs can actually
// show rather than refusing the answer; an unrecognised word lands on neutral, which is a fine
// face for a line we could not read.
const EMOTIONS = ['sad', 'attentive', 'sorry', 'happy', 'warm', 'neutral'];
const EMOTION_ALIAS = {
  angry: 'sad', frustrated: 'sad', upset: 'sad', hurt: 'sad', defensive: 'sad', anxious: 'sad',
  disappointed: 'sad', lonely: 'sad', dismissive: 'sad', tense: 'sad', worried: 'sad',
  apologetic: 'sorry', regretful: 'sorry', remorseful: 'sorry', guilty: 'sorry',
  loving: 'warm', affectionate: 'warm', tender: 'warm', caring: 'warm', hopeful: 'warm', reassuring: 'warm',
  joyful: 'happy', glad: 'happy', relieved: 'happy', pleased: 'happy', grateful: 'happy',
  listening: 'attentive', curious: 'attentive', concerned: 'attentive', thoughtful: 'attentive',
  understanding: 'attentive', empathetic: 'attentive',
  calm: 'neutral', flat: 'neutral', matter_of_fact: 'neutral', explaining: 'neutral'
};
function normEmotion(v) {
  const k = String(v || '').trim().toLowerCase().replace(/[\s-]+/g, '_');
  if (EMOTIONS.includes(k)) return k;
  return EMOTION_ALIAS[k] || 'neutral';
}
const normGender = (v) => (/^f/i.test(String(v || '')) ? 'female' : /^m/i.test(String(v || '')) ? 'male' : 'unknown');
// "A", "a" and "Speaker A" all mean A. Anything else — usually the person's own name — is passed
// through UNCHANGED on purpose: the frontend's spk() resolves a name against the two it was given,
// and collapsing it to "A" here would silently put every line in one person's mouth. (It did, the
// first time: the model answered with names and all eight turns came back as speaker A.)
function normSpeaker(v) {
  const raw = String(v == null ? '' : v).trim();
  if (/^(speaker\s*)?a$/i.test(raw)) return 'A';
  if (/^(speaker\s*)?b$/i.test(raw)) return 'B';
  return raw || 'A';
}

function normTurns(arr) {
  return (arr || []).slice(0, 8).map(t => ({
    speaker: normSpeaker(t && t.speaker),
    display: String((t && t.display) || ''),
    speak: String((t && t.speak) || (t && t.display) || ''),
    emotion: normEmotion(t && t.emotion)
  })).filter(t => t.display.trim());
}

// A valid shape is not the same as a sane one. Bound the arrays the prompt was asked to bound,
// keep scores inside 0-100 so a stray 250 can never reach the score ring, and put every free-text
// vocabulary back into the small set the UI knows how to render.
function sane(rep) {
  const r = rep || {};
  const sc = r.scores || {};
  for (const k of ['connection', 'empathy', 'escalation_risk', 'overall']) sc[k] = clampInt(sc[k], 0, 100);
  r.scores = sc;
  r.patterns = (r.patterns || []).slice(0, 4);
  r.strengths = (r.strengths || []).slice(0, 4);
  r.improvements = (r.improvements || []).slice(0, 3);
  r.original = normTurns(r.original);
  r.improved = normTurns(r.improved);
  const sp = r.speakers || {};
  r.speakers = {
    A: { name: String((sp.A && sp.A.name) || ''), gender: normGender(sp.A && sp.A.gender) },
    B: { name: String((sp.B && sp.B.name) || ''), gender: normGender(sp.B && sp.B.gender) }
  };
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

// ---- Events ------------------------------------------------------------------
// Small, append-only product analytics. Public on purpose: the intro plays BEFORE anyone signs in
// or even gets a guest token, and an intro funnel you cannot measure is an intro you cannot
// improve. Guarded instead by a closed list of event names, a hard cap on the payload, and a
// per-IP rate limit — nothing here is user content and nothing costs money.
const EVENT_NAMES = new Set([
  'intro_started', 'intro_scene', 'intro_completed', 'intro_skipped', 'intro_audio_blocked',
  'intro_muted', 'intro_replayed',
  'signup_started', 'phone_submitted',
  'analysis_started', 'analysis_ready', 'analysis_refused',
  'walkthrough_opened', 'walkthrough_completed', 'act1_played', 'act1_finished',
  'replay_played', 'breathing_opened', 'feedback_given', 'report_opened'
]);

app.post('/api/event', async (req, res) => {
  try {
    const { name, props = {}, anonId = null } = req.body || {};
    if (!EVENT_NAMES.has(name)) return res.status(400).json({ error: 'Unknown event.' });
    const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'anon').split(',')[0].trim();
    if (!rateLimit('ev:' + ip, 120)) return res.status(429).json({ error: 'Too many events.' });
    if (!admin) return res.json({ ok: true, stored: false });

    const user = await getUser(req);
    // Keep the payload small and flat; this table is for counting, not for storing content.
    const safe = {};
    for (const [k, v] of Object.entries(props)) {
      if (Object.keys(safe).length >= 12) break;
      if (v === null || ['string', 'number', 'boolean'].includes(typeof v)) {
        safe[String(k).slice(0, 40)] = typeof v === 'string' ? v.slice(0, 200) : v;
      }
    }
    const { error } = await admin.from('events').insert({
      user_id: user ? user.id : null,
      anon_id: user ? null : String(anonId || '').slice(0, 64) || null,
      name, props: safe
    });
    if (error && !/schema cache|does not exist/i.test(error.message)) {
      console.warn('[samvaad] event insert failed:', error.message);
    }
    res.json({ ok: true, stored: !error });
  } catch (e) { res.json({ ok: true, stored: false }); }
});

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

    await chargeQuota(principal, Math.max(1, Math.round(seconds / 60)), false);
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

    // Minutes for audio were already paid at the transcribe step, so only text arriving straight
    // from a paste is metered for time. The ANALYSIS allowance is checked either way — an upload
    // that skipped this check would be a free hole straight through the trial limit.
    const estMinutes = Math.max(1, Math.round(countWords(transcript) / 150));
    const chargeMinutes = source === 'audio' ? 0 : estMinutes;
    try { await checkQuota(principal, chargeMinutes); } catch (e) { return quotaFail(res, e); }

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

BE HONEST, NEVER PAD. "patterns" (max 4) and "improvements" (max 3) are for real issues only — if this exchange was healthy, return empty arrays rather than inventing weaknesses. Always surface genuine "strengths" (max 4). Stay neutral and non-blaming. KPIs are short, plain-language observations about how the conversation went. ${naming}

"original" (max 8 turns) is the pivotal stretch of the conversation as it ACTUALLY happened — the moment the improvements are responding to. Copy each line VERBATIM from the transcript above; never paraphrase, soften or invent a line. Choose the consecutive turns where the exchange turned, not the opening pleasantries. "emotion" is what that person genuinely sounded like in that moment.

"improved" (max 8 turns) is the SAME stretch replayed kindly, applying your own "improvements". It should mirror "original" turn for turn so the two can be compared side by side.

Each "script" in improvements is the exact line that person should SAY next time, in their own everyday register (Hinglish/Devanagari fine, matching how they already speak), two sentences at most. It contains ONLY the spoken words: no name prefix, no quotation marks, no stage directions.

For every turn in BOTH arrays: "speaker" is exactly "A" or "B" and never a name; alternate as a real back-and-forth rather than labelling every turn the same speaker; "display" is the natural line (Hinglish/Devanagari fine); "speak" is a clean Roman transliteration for text-to-speech with no Devanagari; "emotion" is one of sad, attentive, sorry, happy, warm or neutral, fitting and varied rather than neutral by default. "display" and "speak" contain ONLY the words spoken — never prefix a line with the speaker's name or a colon (write "Aaj phir call nahi kiya", NOT "${nameA}: Aaj phir call nahi kiya").${mode === 'self' ? '\n\nThis is a solo reflection, so there is no back-and-forth to replay: return empty arrays for "original" and "improved".' : ''}`;

    const rep = sane(json(await groq(prompt, { schema: ANALYSIS_SCHEMA, schemaName: 'samvaad_analysis' })));
    const original = mode === 'relationship' ? (rep.original || []) : [];
    const improved = mode === 'relationship' ? (rep.improved || []) : [];

    // Charged only now that the analysis actually succeeded: a failed Groq call must never cost
    // someone one of their three.
    await chargeQuota(principal, chargeMinutes, true);

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
    res.json({ ...rep, original, improved, sessionId, truncated: cap.truncated, wordsKept: cap.wordsKept, wordsTotal: cap.wordsTotal, limits: LIMITS, allowance: await allowance(principal) });
  } catch (e) {
    if (e && e.retryAfter) res.set('retry-after', String(e.retryAfter));
    res.status((e && e.status) || 500).json({ error: String(e.message || e), code: (e && e.code) || null });
  }
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
        allowance: await allowance(p),
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
      allowance: await allowance(p),
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

// ---- Admin: is the database actually up to date? ----------------------------
// The failure this replaces: someone opens Admin -> People, taps Save, and gets a browser alert
// reading "Could not find the table 'public.profiles' in the schema cache". That sentence is true
// and completely useless. It means a migration was never run, and nothing in the product said so —
// the page even rendered plausible-looking defaults, because a missing profiles table and a user
// with no profile row look identical from the outside.
//
// So the backend now checks, and the console leads with the answer.
const SCHEMA_EXPECTED = {
  sessions: ['id', 'user_id', 'mode', 'submode', 'name_a', 'name_b', 'scores', 'summary', 'patterns',
             'strengths', 'improvements', 'original', 'improved', 'kpis', 'speakers', 'truncated',
             'act1_mode', 'created_at'],
  feedback: ['id', 'user_id', 'session_id', 'asked_at', 'context', 'top_suggestion', 'will_try'],
  consents: ['id', 'user_id', 'session_id', 'kind', 'attested', 'created_at'],
  nudge_subscriptions: ['user_id', 'phone', 'display_name', 'cadence', 'consent', 'active'],
  profiles: ['user_id', 'phone', 'phone_verified', 'display_name', 'status', 'minutes_quota',
             'minutes_used_month', 'quota_month', 'features', 'analyses_quota', 'analyses_used'],
  app_settings: ['key', 'value', 'updated_at'],
  events: ['id', 'user_id', 'anon_id', 'name', 'props', 'created_at']
};

async function schemaReport() {
  if (!admin) return { ok: false, configured: false, tables: [], missingTables: [], missingColumns: [] };
  const tables = [], missingTables = [], missingColumns = [];
  for (const [table, cols] of Object.entries(SCHEMA_EXPECTED)) {
    const probe = await admin.from(table).select('*').limit(1);
    if (probe.error) { missingTables.push(table); tables.push({ table, present: false, missing: cols }); continue; }
    // PostgREST rejects a select naming a column that does not exist, which is a cheap per-column
    // existence check without needing rights on information_schema.
    const missing = [];
    for (const c of cols) {
      const r = await admin.from(table).select(c).limit(1);
      if (r.error) missing.push(c);
    }
    if (missing.length) missingColumns.push({ table, columns: missing });
    tables.push({ table, present: true, missing });
  }
  return {
    ok: !missingTables.length && !missingColumns.length,
    configured: true,
    tables, missingTables, missingColumns,
    fix: 'Run backend/migrations/000-bring-schema-current.sql once in the Supabase SQL editor.'
  };
}

app.get('/api/admin/schema', async (req, res) => {
  try {
    if (!(await requireAdmin(req, res))) return;
    res.json(await schemaReport());
  } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
});

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
        analysesQuota: Number(p.analyses_quota ?? DEFAULT_ANALYSES_QUOTA),
        analysesUsed: Number(p.analyses_used || 0),
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
    if (body.analysesQuota !== undefined) {
      const q = Number(body.analysesQuota);
      if (!Number.isFinite(q) || q < 0 || q > 10000) return res.status(400).json({ error: 'Bad analyses quota.' });
      patch.analyses_quota = q;
    }
    if (body.resetUsage === true) { patch.minutes_used_month = 0; patch.quota_month = monthKey(); }
    if (body.resetAnalyses === true) { patch.analyses_used = 0; }
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

    const explain = (msg) => /schema cache|does not exist|relation .* does not exist/i.test(msg)
      ? 'The database is missing the profiles table. Run backend/migrations/000-bring-schema-current.sql once in the Supabase SQL editor, then reload this page.'
      : msg;
    if (existing) {
      const { error } = await admin.from('profiles').update(patch).eq('user_id', id);
      if (error) throw new Error(explain(error.message));
    } else {
      const { error } = await admin.from('profiles').insert({ user_id: id, minutes_quota: DEFAULT_MINUTES_QUOTA, ...patch });
      if (error) throw new Error(explain(error.message));
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
  default_minutes_quota: v => Number.isFinite(Number(v)) && Number(v) >= 0,
  default_analyses_quota: v => Number.isFinite(Number(v)) && Number(v) >= 0
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
        default_minutes_quota: Number(s.default_minutes_quota ?? DEFAULT_MINUTES_QUOTA),
        default_analyses_quota: Number(s.default_analyses_quota ?? DEFAULT_ANALYSES_QUOTA)
      },
      act1Modes: ACT1_MODES,
      engine: { model: await analysisModel(), pinned: !!PINNED_MODEL, tpm: GROQ_TPM, limits: LIMITS }
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
    if (error) throw new Error(/schema cache|does not exist/i.test(error.message)
      ? 'The database is missing the app_settings table. Run backend/migrations/000-bring-schema-current.sql once in the Supabase SQL editor, then reload this page.'
      : error.message);
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
        admin.from('profiles').select('user_id, status, phone, minutes_used_month, quota_month, analyses_used, analyses_quota'),
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
    const exhausted = profileRows.filter(p =>
      Number(p.analyses_used || 0) >= Number(p.analyses_quota ?? DEFAULT_ANALYSES_QUOTA)).length;
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

    // --- the intro funnel ---
    // How many people met the animation, how many sat through it, how far the skippers got, and
    // whether the voice-over actually played (browsers block autoplay audio far more often than
    // anyone expects, and a silent intro is a different product).
    let intro = { started: 0, completed: 0, skipped: 0, audioBlocked: 0, muted: 0, completionRate: null, avgSceneOnSkip: null };
    if (admin) {
      const ev = await admin.from('events').select('name, props').in('name',
        ['intro_started', 'intro_completed', 'intro_skipped', 'intro_audio_blocked', 'intro_muted']);
      if (!ev.error) {
        const rows = ev.data || [];
        const count = (n) => rows.filter(r => r.name === n).length;
        intro.started = count('intro_started');
        intro.completed = count('intro_completed');
        intro.skipped = count('intro_skipped');
        intro.audioBlocked = count('intro_audio_blocked');
        intro.muted = count('intro_muted');
        intro.completionRate = intro.started ? Math.round((intro.completed / intro.started) * 100) : null;
        const skips = rows.filter(r => r.name === 'intro_skipped' && Number.isFinite(Number(r.props?.scene)));
        intro.avgSceneOnSkip = skips.length
          ? Math.round((skips.reduce((a, r) => a + Number(r.props.scene), 0) / skips.length) * 10) / 10
          : null;
      }
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
        exhausted,
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
      intro,
      schema: await schemaReport(),
      experiment: exp,
      capacity: { minutesThisMonth, model: await analysisModel(), pinned: !!PINNED_MODEL, tpm: GROQ_TPM, limits: LIMITS },
      voice
    });
  } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
});

app.get('/health', (_, res) => res.json({ ok: true }));
app.listen(process.env.PORT || 8787, () => console.log('Samvaad backend on', process.env.PORT || 8787));
