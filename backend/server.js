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
    for (const w of words) { const sp = w.speaker ?? 0;
      if (sp !== cur) { if (line) out += (cur === 0 ? nameA : nameB) + ': ' + line.trim() + '\n'; cur = sp; line = ''; }
      line += (w.punctuated_word || w.word) + ' '; }
    if (line) out += (cur === 0 ? nameA : nameB) + ': ' + line.trim() + '\n';
    res.json({ transcript: out });
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
      `"summary":"<=2 sentences","patterns":[{"title":"","who":"","detail":"<=1 sentence"}],` +
      `"strengths":[{"title":"","who":"","detail":""}],` +
      `"improvements":[{"pattern":"","suggestion":"","script":"verbatim line in their own language/Hinglish, <=2 sentences"}],` +
      `"kpis":{"talk_balance":"","question_ratio":"","repair_attempts":0,"self_reference":""}}. ` +
      `Max 4 patterns, 4 strengths, 3 improvements. Neutral, non-blaming. KPIs are descriptive text awareness signals, not diagnoses.`;
    const rep = json(await claude(p1));

    let improved = [];
    if (mode === 'relationship') {
      const p2 = `Rewrite the SAME conversation between ${nameA} (A) and ${nameB} (B) applying: ${JSON.stringify(rep.improvements)}.\n${transcript}\n\n` +
        `Return ONLY minified JSON: {"improved":[{"speaker":"A or B","display":"natural line (Hinglish/Devanagari ok)","speak":"clean Roman transliteration for TTS, no Devanagari","emotion":"sad|attentive|sorry|happy|warm|neutral"}]}. Max 8 short turns.`;
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
    if (!r.ok) throw new Error('eleven ' + r.status);
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

app.get('/health', (_, res) => res.json({ ok: true }));
app.listen(process.env.PORT || 8787, () => console.log('Samvaad backend on', process.env.PORT || 8787));
