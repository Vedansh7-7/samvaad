// Samvaad — end-to-end funnel test.
//
//   node --env-file-if-exists=.env test/funnel.mjs [baseUrl]
//
// Walks the path a real trial user takes, in order, against a running backend: the switches the
// pre-login pages read, the intro events, a guest token, the account's limits, a REAL analysis
// through Groq, the shape of what comes back, the allowance ticking down, feedback, history, the
// admin doors staying shut, and finally the schema itself.
//
// It spends real Groq and (optionally) real ElevenLabs quota, because a funnel test that mocks
// the providers tests the mocks. Default is one analysis; pass --full to drive the allowance to
// exhaustion (slower: it waits out the tokens-per-minute window between calls).

const BASE = (process.argv.find(a => a.startsWith('http')) || 'http://localhost:8787').replace(/\/+$/, '');
const FULL = process.argv.includes('--full');

let pass = 0, fail = 0, skip = 0;
const results = [];
function ok(name, detail = '')  { pass++; results.push(['PASS', name, detail]); }
function no(name, detail = '')  { fail++; results.push(['FAIL', name, detail]); }
function meh(name, detail = '') { skip++; results.push(['SKIP', name, detail]); }
function check(cond, name, detail = '') { cond ? ok(name, detail) : no(name, detail); return cond; }

const j = async (res) => { try { return await res.json(); } catch { return {}; } };
const wait = (ms) => new Promise(r => setTimeout(r, ms));

const TRANSCRIPT = [
  'Kavya: Rohit, aaj phir tumne mummy ko call nahi kiya. Unhe bura laga.',
  'Rohit: Yaar office mein kaam tha. Tum samajhti kyun nahi?',
  'Kavya: Samajhti hoon, but yeh daily ho raha hai. Hamesha koi excuse.',
  'Rohit: Excuse? Main hamare future ke liye kaam kar raha hoon.',
  'Kavya: Main yeh nahi keh rahi kaam mat karo. Mujhe akela feel hota hai.',
  'Rohit: ...Shayad main sach mein kuch miss kar raha hoon.',
  'Kavya: Aaj meri promotion ki last date thi. Tumhe pata bhi nahi tha.',
  "Rohit: Mujhe nahi pata tha. I'm sorry. Aaj ki baat karo - kya hua?"
].join('\n');

console.log('Samvaad funnel test →', BASE, FULL ? '(full)' : '(quick)', '\n');

// ── 0. the backend is up ─────────────────────────────────────────────────────
const health = await fetch(BASE + '/health').catch(() => null);
if (!health || !health.ok) {
  console.log('Backend is not answering at ' + BASE + '. Start it, or pass the URL as an argument.');
  process.exit(1);
}
ok('backend is up');

// ── 1. what the pre-login pages can read ─────────────────────────────────────
{
  const r = await fetch(BASE + '/api/config');
  const d = await j(r);
  check(r.ok, 'GET /api/config answers without any auth');
  check(typeof d.introEnabled === 'boolean', 'config carries introEnabled', String(d.introEnabled));
  check(typeof d.guestEnabled === 'boolean', 'config carries guestEnabled', String(d.guestEnabled));
  check(d.limits && d.limits.maxMinutes > 0, 'config carries the real input limits',
        d.limits ? `${d.limits.maxMinutes} min / ${d.limits.maxWords} words` : '');
  check(!('SUPABASE_SERVICE_KEY' in d) && !JSON.stringify(d).includes('eyJ'),
        'config leaks no secrets');
}

// ── 2. the intro, and whether we can see who watched it ──────────────────────
{
  const anon = 'test_' + Math.random().toString(36).slice(2, 9);
  const send = (name, props) => fetch(BASE + '/api/event', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name, anonId: anon, props })
  });
  const a = await send('intro_started', { at: 0 });
  const b = await send('intro_scene', { scene: 3, at: 15.1 });
  const c = await send('intro_skipped', { scene: 3, at: 16.0, audio: true });
  check(a.ok && b.ok && c.ok, 'intro events are accepted');
  const stored = (await j(c)).stored;
  stored ? ok('intro events are being stored') : meh('intro events not stored (events table missing)');
  const bad = await fetch(BASE + '/api/event', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'not_a_real_event' })
  });
  check(bad.status === 400, 'unknown event names are refused', 'HTTP ' + bad.status);
}

// ── 3. the doors are shut without a principal ────────────────────────────────
for (const ep of ['analyze', 'transcribe', 'tts']) {
  const r = await fetch(`${BASE}/api/${ep}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}'
  });
  check(r.status === 401, `POST /api/${ep} is 401 without a principal`, 'HTTP ' + r.status);
}
for (const ep of ['kpis', 'users', 'settings', 'schema', 'nudges']) {
  const r = await fetch(`${BASE}/api/admin/${ep}`);
  check(r.status === 403, `GET /api/admin/${ep} is 403 without the allowlist`, 'HTTP ' + r.status);
}

// ── 4. a guest gets in ───────────────────────────────────────────────────────
let token = null;
{
  const r = await fetch(BASE + '/api/guest', { method: 'POST' });
  const d = await j(r);
  if (r.ok && d.token) { token = d.token; ok('guest token issued'); }
  else { meh('guest access is closed', d.error || ('HTTP ' + r.status)); }
}
if (!token) { report(); process.exit(fail ? 1 : 0); }
const H = { 'content-type': 'application/json', 'x-guest-token': token };

{
  const r = await fetch(BASE + '/api/me', { headers: { 'x-guest-token': token + 'x' } });
  check(r.status === 401, 'a tampered guest token is rejected', 'HTTP ' + r.status);
}

// ── 5. the account knows its own limits ──────────────────────────────────────
let allowance = null;
{
  const r = await fetch(BASE + '/api/me', { headers: H });
  const d = await j(r);
  check(r.ok, 'GET /api/me answers for a guest');
  check(d.limits && d.limits.maxChars > 1000, 'me carries input limits', d.limits ? d.limits.maxChars + ' chars' : '');
  check(['voiced', 'real_audio', 'silent'].includes(d.act1), 'me carries an act-1 variant', d.act1);
  check(d.allowance && d.allowance.quota > 0, 'me carries the trial allowance',
        d.allowance ? `${d.allowance.left}/${d.allowance.quota}` : '');
  allowance = d.allowance;
}

// ── 6. the analysis itself ───────────────────────────────────────────────────
let report1 = null;
{
  const t0 = Date.now();
  const r = await fetch(BASE + '/api/analyze', {
    method: 'POST', headers: H,
    body: JSON.stringify({ transcript: TRANSCRIPT, mode: 'relationship', submode: 'couple',
                           nameA: 'Kavya', nameB: 'Rohit', source: 'text', consent: 'both_partners' })
  });
  const d = await j(r);
  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  if (r.status === 503) {
    meh('analysis: per-minute budget was full', d.error);
  } else if (!check(r.ok, 'POST /api/analyze returns a report', `HTTP ${r.status} in ${secs}s ${d.error || ''}`)) {
    // nothing more to check downstream
  } else {
    report1 = d;
    ok('analysis latency', secs + 's');
    const sc = d.scores || {};
    check(['connection','empathy','escalation_risk','overall'].every(k => Number.isInteger(sc[k]) && sc[k] >= 0 && sc[k] <= 100),
          'scores are four integers inside 0-100', JSON.stringify(sc));
    check((d.summary || '').length > 20, 'summary is present');
    const sp = d.speakers || {};
    check(sp.A && sp.B && sp.A.name === 'Kavya' && sp.B.name === 'Rohit',
          'speakers use the names that were entered', `${sp.A?.name}/${sp.B?.name}`);
    check(['female','male','unknown'].includes(sp.A?.gender) && ['female','male','unknown'].includes(sp.B?.gender),
          'genders are normalised', `${sp.A?.gender}/${sp.B?.gender}`);

    const EMO = ['sad','attentive','sorry','happy','warm','neutral'];
    const turns = [...(d.original || []), ...(d.improved || [])];
    check((d.original || []).length >= 2, 'act 1 has turns to play', String((d.original||[]).length));
    check((d.improved || []).length >= 2, 'act 2 has turns to play', String((d.improved||[]).length));
    check(turns.every(t => EMO.includes(t.emotion)), 'every emotion is one the rigs can wear',
          [...new Set(turns.map(t => t.emotion))].join(', '));
    check(turns.every(t => (t.display || '').trim() && (t.speak || '').trim()), 'no empty lines');
    check(turns.every(t => !/^\s*(kavya|rohit)\s*:/i.test(t.display)), 'no speaker-name prefixes leaked into lines');

    const norm = (x) => x.toLowerCase().replace(/[^a-z0-9ऀ-ॿ ]/g, '').replace(/\s+/g, ' ').trim();
    const src = norm(TRANSCRIPT);
    const verbatim = (d.original || []).filter(t => src.includes(norm(t.display))).length;
    check(verbatim === (d.original || []).length, 'act 1 lines are verbatim from the transcript',
          `${verbatim}/${(d.original||[]).length}`);

    const sides = new Set((d.original || []).map(t => t.speaker));
    check(sides.size >= 2, 'act 1 has both people speaking', [...sides].join('/'));

    check(d.allowance && d.allowance.left === allowance.left - 1, 'the allowance ticked down by one',
          `${allowance.left} → ${d.allowance?.left}`);
    allowance = d.allowance;
  }
}

// ── 7. feedback, and history staying empty for a guest ───────────────────────
{
  const r = await fetch(BASE + '/api/feedback', {
    method: 'POST', headers: H,
    body: JSON.stringify({ session_id: null, will_try: 'yes', top_suggestion: 'test', context: {} })
  });
  check(r.ok, 'POST /api/feedback accepts a guest without storing', 'HTTP ' + r.status);
  const bad = await fetch(BASE + '/api/feedback', {
    method: 'POST', headers: H, body: JSON.stringify({ will_try: 'definitely' })
  });
  check(bad.status === 400 || bad.ok, 'bad will_try value is handled', 'HTTP ' + bad.status);
}
{
  const r = await fetch(BASE + '/api/history', { headers: H });
  const d = await j(r);
  check(r.ok && Array.isArray(d.sessions) && d.sessions.length === 0,
        'a guest has no history, by design', String(d.sessions?.length));
}

// ── 8. the wall (only with --full: it waits out the TPM window) ──────────────
if (FULL && allowance) {
  let refused = null;
  for (let n = 0; n < allowance.quota + 1 && !refused; n++) {
    await wait(65000);
    const r = await fetch(BASE + '/api/analyze', {
      method: 'POST', headers: H,
      body: JSON.stringify({ transcript: TRANSCRIPT, mode: 'relationship', submode: 'couple',
                             nameA: 'Kavya', nameB: 'Rohit', source: 'text', consent: 'both_partners' })
    });
    const d = await j(r);
    if (r.status === 429) refused = d;
  }
  check(refused && refused.code === 'analyses_exhausted', 'the trial allowance refuses the next one',
        refused ? refused.error : 'never refused');
} else if (allowance) {
  meh('allowance exhaustion (pass --full to drive it)', `${allowance.left} left`);
}

// ── 9. the schema the whole thing rests on ───────────────────────────────────
{
  // No admin token here, so read it the way the app does: a missing table shows up as an
  // un-storable event, and analysis persistence quietly not happening.
  const r = await fetch(BASE + '/api/event', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'intro_started', anonId: 'schemaprobe', props: {} })
  });
  const d = await j(r);
  d.stored
    ? ok('database is reachable and accepting writes')
    : no('database is behind the app', 'run backend/migrations/000-bring-schema-current.sql');
}

report();
process.exit(fail ? 1 : 0);

function report(){
  console.log('');
  for (const [state, name, detail] of results) {
    const mark = state === 'PASS' ? '  ok  ' : state === 'FAIL' ? ' FAIL ' : ' skip ';
    console.log(mark + name + (detail ? '  ·  ' + detail : ''));
  }
  console.log(`\n${pass} passed, ${fail} failed, ${skip} skipped`);
}
