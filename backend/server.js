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
const MAX_AUDIO_SECONDS = 35 * 60;      // hard reject beyond this; 30 min is the advertised limit
const GUEST_ANALYSES_PER_DAY = 10;
const DEFAULT_MINUTES_QUOTA = 60;

// The real ceiling is not our preference, it is Groq's tokens-per-minute limit. Groq counts
// prompt + max_tokens against TPM, and one analysis makes TWO calls inside the same minute, so
// each call may use at most half the budget. Free tier is 12,000 TPM, which works out to roughly
// 9,000 characters (about 10 minutes of speech) — well short of the 30 minutes we want to offer.
// Raising GROQ_TPM after upgrading the Groq plan is the single knob that lifts this.
const GROQ_TPM = Number(process.env.GROQ_TPM || 12000);
const GROQ_MAX_TOKENS = 2000;                 // reserved per call, and counted against TPM
const CHARS_PER_TOKEN = 2.6;                  // measured on romanised Hinglish, which is dense
const PROMPT_OVERHEAD_TOKENS = 700;           // instructions + JSON scaffolding around the transcript
const ANALYSIS_MAX_CHARS = Math.max(
  2000,
  Math.floor(((GROQ_TPM / 2) - GROQ_MAX_TOKENS - PROMPT_OVERHEAD_TOKENS) * CHARS_PER_TOKEN)
);

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

async function groq(prompt, tries = 3) {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'authorization': 'Bearer ' + GROQ_API_KEY },
      body: JSON.stringify({ model: 'llama-3.3-70b-versatile', max_tokens: GROQ_MAX_TOKENS, temperature: 0.6, response_format: { type: 'json_object' }, messages: [{ role: 'user', content: prompt }] })
    });
    if (r.ok) { const d = await r.json(); return (d.choices || []).map(c => c.message?.content || '').join(''); }
    const body = (await r.text()).slice(0, 300);
    // 413 means we blew the tokens-per-minute ceiling. Raw Groq text is no help to a user.
    if (r.status === 413) throw new Error('This conversation is longer than we can read in one go right now. Try a shorter section.');
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
    if (seconds > MAX_AUDIO_SECONDS) {
      return res.status(413).json({ error: 'That recording is longer than 30 minutes. Please trim it and try again.' });
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

    const p1 = `You are an expert communication analyst trained in the Gottman method. ${lens}\n\n${transcript}\n\n` +
      `Return ONLY minified JSON: {"scores":{"connection":0-100,"empathy":0-100,"escalation_risk":0-100,"overall":0-100},` +
      `"summary":"<=2 sentences","speakers":{"A":{"name":"","gender":"female|male|unknown"},"B":{"name":"","gender":"female|male|unknown"}},"patterns":[{"title":"","who":"","detail":"<=1 sentence"}],` +
      `"strengths":[{"title":"","who":"","detail":""}],` +
      `"improvements":[{"pattern":"","suggestion":"","script":"verbatim line in their own language/Hinglish, <=2 sentences"}],` +
      `"kpis":{"talk_balance":"","question_ratio":"","repair_attempts":0,"self_reference":""}}. ` +
      `Be honest and dynamic, never pad: include ONLY genuine items. "patterns" (max 4) and "improvements" (max 3) ONLY where a real issue exists — if the exchange is healthy (high scores, low escalation), return [] for them rather than inventing weaknesses. Always surface real "strengths" (max 4). Neutral, non-blaming. KPIs are descriptive text awareness signals, not diagnoses. For "speakers": infer each person's likely gender from their name and how they are addressed (use "unknown" only if genuinely unclear). "A" is ${nameA}; for a solo reflection "B" is the other person ${nameA} describes — give B's name if stated, else "". Set speakers.A.name to exactly "${nameA}" and (for a couple) speakers.B.name to exactly "${nameB}". In every "who" field and all text, refer to the two people ONLY as "${nameA}" and "${nameB}" — never use any other names even if the transcript uses different ones.`;
    const rep = json(await groq(p1));

    let improved = [];
    if (mode === 'relationship') {
      const p2 = `Rewrite the SAME conversation between ${nameA} (A) and ${nameB} (B) applying: ${JSON.stringify(rep.improvements)}.\n${transcript}\n\n` +
        `Return ONLY minified JSON: {"improved":[{"speaker":"A or B","display":"natural line (Hinglish/Devanagari ok)","speak":"clean Roman transliteration for TTS, no Devanagari","emotion":"sad|attentive|sorry|happy|warm|neutral"}]}. Max 8 short turns. CRITICAL: set "speaker" to exactly "A" or "B" (never a name), and alternate turns as a real back-and-forth (A, B, A, B…) — never label every turn the same speaker. Give each turn a fitting, varied "emotion"; do not default everything to neutral. The two people are named EXACTLY "${nameA}" (A) and "${nameB}" (B): wherever a line addresses the other person by name, use ONLY these two names — replace any other names that appear in the transcript, and never use any name other than "${nameA}" or "${nameB}". Each "display" and "speak" value must contain ONLY the words the person actually says — NEVER prefix a line with the speaker's name or a colon (e.g. write "Aaj phir call nahi kiya" NOT "${nameA}: Aaj phir call nahi kiya").`;
      improved = (json(await groq(p2)).improved) || [];
    }

    if (source !== 'audio') await chargeQuota(principal, estMinutes);

    let sessionId = null;
    if (user && admin) {
      const base = {
        user_id: user.id, mode, submode, name_a: nameA, name_b: nameB,
        scores: rep.scores, summary: rep.summary, patterns: rep.patterns,
        strengths: rep.strengths, improvements: rep.improvements, improved, kpis: rep.kpis || {}
      };
      // speakers/truncated arrive with the Phase 0 migration; fall back if it has not run yet.
      let { data, error } = await admin.from('sessions')
        .insert({ ...base, speakers: rep.speakers || {}, truncated: cap.truncated })
        .select('id').single();
      if (error) {
        console.warn('[samvaad] session insert fell back (run the Phase 0 migration):', error.message);
        ({ data } = await admin.from('sessions').insert(base).select('id').single());
      }
      sessionId = data?.id || null;
      if (sessionId && consent) await admin.from('consents').insert({ user_id: user.id, session_id: sessionId, kind: consent });
    }
    res.json({ ...rep, improved, sessionId, truncated: cap.truncated, wordsKept: cap.wordsKept, wordsTotal: cap.wordsTotal });
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
    if (p.kind === 'guest') {
      return res.json({ kind: 'guest', status: 'active', features: {}, quota: { minutes: null } });
    }
    const prof = await ensureProfile(p);
    const used = (prof && prof.quota_month === monthKey()) ? Number(prof.minutes_used_month || 0) : 0;
    res.json({
      kind: 'user', email: p.user?.email || null,
      status: prof?.status || 'active',
      phone: prof?.phone || null, phoneVerified: !!prof?.phone_verified,
      features: prof?.features || {},
      quota: { minutes: Number(prof?.minutes_quota || DEFAULT_MINUTES_QUOTA), used }
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

// ---- Admin gate: allowlist of Supabase auth user ids in env ADMIN_USER_IDS ----
async function requireAdmin(req, res) {
  const u = await getUser(req);
  const ids = (process.env.ADMIN_USER_IDS || '').split(',').map(s => s.trim()).filter(Boolean);
  if (!u || !ids.includes(u.id)) { res.status(403).json({ error: 'Admin only.' }); return null; }
  return u;
}

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

// ---- Admin: KPIs (E2-T2) — ADMIN only ----
app.get('/api/admin/kpis', async (req, res) => {
  try {
    if (!(await requireAdmin(req, res))) return;

    let sessionRows = [], optinsTotal = 0, profileRows = [];
    if (admin) {
      const [s, o, pr] = await Promise.all([
        admin.from('sessions').select('user_id, mode, submode'),
        admin.from('nudge_subscriptions').select('user_id', { count: 'exact', head: true }).eq('consent', true).eq('active', true),
        admin.from('profiles').select('user_id, status, minutes_used_month')
      ]);
      sessionRows = s.data || [];
      optinsTotal = o.count || 0;
      profileRows = pr.data || [];
    }

    const byMode = { relationship: 0, self: 0 };
    const bySubmode = { couple: 0, solo: 0 };
    const users = new Set();
    const coupleUsers = new Set();      // users with >=1 submode='couple' session
    const selfSoloUsers = new Set();    // users with >=1 session where mode='self' OR submode='solo'

    for (const r of sessionRows) {
      if (r.mode === 'relationship') byMode.relationship++;
      else if (r.mode === 'self') byMode.self++;
      if (r.submode === 'couple') bySubmode.couple++;
      else if (r.submode === 'solo') bySubmode.solo++;
      if (r.user_id) {
        users.add(r.user_id);
        if (r.submode === 'couple') coupleUsers.add(r.user_id);
        if (r.mode === 'self' || r.submode === 'solo') selfSoloUsers.add(r.user_id);
      }
    }

    let converted = 0;
    for (const id of selfSoloUsers) if (coupleUsers.has(id)) converted++;
    const denom = Math.max(1, selfSoloUsers.size);
    const rate = Math.round((converted / denom) * 100) / 100;

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
      sessions: { total: sessionRows.length, byMode, bySubmode },
      users: { total: users.size, registered: profileRows.length, suspended: profileRows.filter(p => p.status === 'suspended').length },
      optins: { total: optinsTotal },
      soloToCouple: { converted, rate },
      voice
    });
  } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
});

app.get('/health', (_, res) => res.json({ ok: true }));
app.listen(process.env.PORT || 8787, () => console.log('Samvaad backend on', process.env.PORT || 8787));
