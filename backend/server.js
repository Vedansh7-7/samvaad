// Samvaad backend — the secret-holding proxy.
// All API keys live here in env vars, never in the browser. Node 18+ (has global fetch).
// Run: npm i && node server.js   |   Deploy: Render / Railway / Fly free tier.

import express from 'express';
import cors from 'cors';
import { createClient } from '@supabase/supabase-js';

const app = express();
app.use(cors({ origin: process.env.ALLOWED_ORIGIN || '*' }));
app.use(express.json({ limit: '25mb' }));

const {
  GROQ_API_KEY, DEEPGRAM_KEY, ELEVENLABS_KEY,
  SUPABASE_URL, SUPABASE_SERVICE_KEY,
  ELEVEN_VOICE_A = 'EXAVITQu4vr4xnSDxMaL', ELEVEN_VOICE_B = 'onwK4e9ZLuTAKqWW03F9'
} = process.env;

const admin = (SUPABASE_URL && SUPABASE_SERVICE_KEY)
  ? createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY) : null;

// Resolve the signed-in user from the Supabase JWT (optional — endpoints still work anonymously,
// they just don't persist).
async function getUser(req) {
  const t = (req.headers.authorization || '').replace('Bearer ', '');
  if (!t || !admin) return null;
  const { data } = await admin.auth.getUser(t);
  return data?.user || null;
}

const json = (s) => { try { return JSON.parse(s); } catch { const a = s.indexOf('{'), b = s.lastIndexOf('}'); return JSON.parse(s.slice(a, b + 1)); } };

async function claude(prompt) {
  const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'authorization': 'Bearer ' + GROQ_API_KEY },
    body: JSON.stringify({ model: 'llama-3.3-70b-versatile', max_tokens: 1200, response_format: { type: 'json_object' }, messages: [{ role: 'user', content: prompt }] })
  });
  if (!r.ok) throw new Error('groq ' + r.status + ' ' + (await r.text()).slice(0, 160));
  const d = await r.json();
  return (d.choices || []).map(c => c.message?.content || '').join('');
}

// ---- Transcribe (Deepgram, diarized) -> speaker-labelled transcript ----
app.post('/api/transcribe', async (req, res) => {
  try {
    const { audioBase64, mime = 'audio/mpeg', nameA = 'A', nameB = 'B' } = req.body;
    const bytes = Buffer.from(audioBase64, 'base64');
    const r = await fetch('https://api.deepgram.com/v1/listen?model=nova-2&diarize=true&punctuate=true&smart_format=true', {
      method: 'POST', headers: { Authorization: 'Token ' + DEEPGRAM_KEY, 'Content-Type': mime }, body: bytes });
    if (!r.ok) throw new Error('deepgram ' + r.status);
    const d = await r.json();
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
    res.json({ transcript: out, turns });
  } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
});

// ---- Analyse (Claude x2) + persist ----
app.post('/api/analyze', async (req, res) => {
  try {
    const { transcript, mode = 'relationship', submode = 'couple', nameA = 'Partner A', nameB = 'Partner B', consent } = req.body;
    const user = await getUser(req);

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
    const rep = json(await claude(p1));

    let improved = [];
    if (mode === 'relationship') {
      const p2 = `Rewrite the SAME conversation between ${nameA} (A) and ${nameB} (B) applying: ${JSON.stringify(rep.improvements)}.\n${transcript}\n\n` +
        `Return ONLY minified JSON: {"improved":[{"speaker":"A or B","display":"natural line (Hinglish/Devanagari ok)","speak":"clean Roman transliteration for TTS, no Devanagari","emotion":"sad|attentive|sorry|happy|warm|neutral"}]}. Max 8 short turns. CRITICAL: set "speaker" to exactly "A" or "B" (never a name), and alternate turns as a real back-and-forth (A, B, A, B…) — never label every turn the same speaker. Give each turn a fitting, varied "emotion"; do not default everything to neutral. The two people are named EXACTLY "${nameA}" (A) and "${nameB}" (B): wherever a line addresses the other person by name, use ONLY these two names — replace any other names that appear in the transcript, and never use any name other than "${nameA}" or "${nameB}". Each "display" and "speak" value must contain ONLY the words the person actually says — NEVER prefix a line with the speaker's name or a colon (e.g. write "Aaj phir call nahi kiya" NOT "${nameA}: Aaj phir call nahi kiya").`;
      improved = (json(await claude(p2)).improved) || [];
    }

    let sessionId = null;
    if (user && admin) {
      const { data } = await admin.from('sessions').insert({
        user_id: user.id, mode, submode, name_a: nameA, name_b: nameB,
        scores: rep.scores, summary: rep.summary, patterns: rep.patterns,
        strengths: rep.strengths, improvements: rep.improvements, improved, kpis: rep.kpis || {}
      }).select('id').single();
      sessionId = data?.id || null;
      if (sessionId && consent) await admin.from('consents').insert({ user_id: user.id, session_id: sessionId, kind: consent });
    }
    res.json({ ...rep, improved, sessionId });
  } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
});

// ---- Text to speech (ElevenLabs) ----
app.post('/api/tts', async (req, res) => {
  try {
    const { text, speaker = 'A' } = req.body;
    const vid = speaker === 'A' ? ELEVEN_VOICE_A : ELEVEN_VOICE_B;
    const r = await fetch('https://api.elevenlabs.io/v1/text-to-speech/' + vid, {
      method: 'POST', headers: { 'xi-api-key': ELEVENLABS_KEY, 'content-type': 'application/json' },
      body: JSON.stringify({ text, model_id: 'eleven_multilingual_v2', voice_settings: { stability: 0.4, similarity_boost: 0.7 } }) });
    if (!r.ok) { let detail = ''; try { detail = await r.text(); } catch (_) {} return res.status(502).json({ error: 'eleven ' + r.status, detail: detail.slice(0, 700) }); }
    res.set('content-type', 'audio/mpeg'); res.send(Buffer.from(await r.arrayBuffer()));
  } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
});

// ---- Feedback loop ----
app.post('/api/feedback', async (req, res) => {
  try {
    const user = await getUser(req);
    if (user && admin) await admin.from('feedback').insert({ user_id: user.id, ...req.body });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
});

// ---- History for the dashboard ----
app.get('/api/history', async (req, res) => {
  try {
    const user = await getUser(req);
    if (!user || !admin) return res.json({ sessions: [] });
    const { data } = await admin.from('sessions').select('*').eq('user_id', user.id).order('created_at', { ascending: false }).limit(100);
    res.json({ sessions: data || [] });
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

// ---- Founding pre-sell capture (E5-T1) — PUBLIC, no auth ----
app.post('/api/founding', async (req, res) => {
  try {
    const { phone, name = null, txn_id = null, plan = null } = req.body || {};
    const norm = String(phone || '').replace(/[^\d+]/g, '');
    if (!/^(\+?91)?[6-9]\d{9}$/.test(norm)) return res.status(400).json({ error: 'Enter a valid Indian mobile number.' });
    if (admin) {
      await admin.from('founding_members').insert({ phone: norm, name, txn_id, plan: plan || 'founding_199' });
    }
    res.json({ ok: true, message: txn_id ? 'Welcome, founding member! 🌼' : 'Saved — your founding spot is reserved.' });
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

// ---- Admin: KPIs (E2-T2) — ADMIN only ----
app.get('/api/admin/kpis', async (req, res) => {
  try {
    if (!(await requireAdmin(req, res))) return;

    let sessionRows = [], optinsTotal = 0, foundingTotal = 0;
    if (admin) {
      const [s, o, f] = await Promise.all([
        admin.from('sessions').select('user_id, mode, submode'),
        admin.from('nudge_subscriptions').select('user_id', { count: 'exact', head: true }).eq('consent', true).eq('active', true),
        admin.from('founding_members').select('id', { count: 'exact', head: true })
      ]);
      sessionRows = s.data || [];
      optinsTotal = o.count || 0;
      foundingTotal = f.count || 0;
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
      users: { total: users.size },
      optins: { total: optinsTotal },
      founding: { total: foundingTotal },
      soloToCouple: { converted, rate },
      voice
    });
  } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
});

app.get('/health', (_, res) => res.json({ ok: true }));
app.listen(process.env.PORT || 8787, () => console.log('Samvaad backend on', process.env.PORT || 8787));
