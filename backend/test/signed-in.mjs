// Samvaad — the signed-in funnel, end to end, against a real account.
//
//   node --env-file-if-exists=.env test/signed-in.mjs [baseUrl]
//
// The quick funnel exercises a guest, who deliberately persists nothing. This one covers what an
// actual trial user does: a profile row appearing, the 3-conversation allowance being counted in
// the database rather than in memory, sessions surviving into history, the phone becoming the
// account key, and the wall arriving on the fourth attempt.
//
// It creates a throwaway auth user through the service role and DELETES it at the end, along with
// everything it wrote (foreign keys cascade). It spends real Groq quota and waits out the
// tokens-per-minute window between analyses, so it takes a few minutes.

import { createClient } from '@supabase/supabase-js';

const BASE = (process.argv.find(a => a.startsWith('http')) || 'http://localhost:8787').replace(/\/+$/, '');
const url = process.env.SUPABASE_URL, key = process.env.SUPABASE_SERVICE_KEY;
if (!url || !key) { console.log('SUPABASE_URL / SUPABASE_SERVICE_KEY missing.'); process.exit(1); }
const db = createClient(url, key);

let pass = 0, fail = 0;
const out = [];
const check = (c, name, detail = '') => { c ? pass++ : fail++; out.push([c ? ' ok ' : 'FAIL', name, detail]); return c; };
const j = async (r) => { try { return await r.json(); } catch { return {}; } };
const wait = (ms) => new Promise(r => setTimeout(r, ms));

const TRANSCRIPT = [
  'Kavya: Rohit, aaj phir tumne mummy ko call nahi kiya. Unhe bura laga.',
  'Rohit: Yaar office mein kaam tha. Tum samajhti kyun nahi?',
  'Kavya: Samajhti hoon, but yeh daily ho raha hai. Hamesha koi excuse.',
  'Rohit: Excuse? Main hamare future ke liye kaam kar raha hoon.',
  'Kavya: Mujhe akela feel hota hai.',
  'Rohit: Shayad main sach mein kuch miss kar raha hoon.'
].join('\n');

const stamp = Date.now();
const email = `funnel+${stamp}@samvaad-test.invalid`;
const password = 'Fnl!' + Math.random().toString(36).slice(2, 12) + 'Aa1';
let userId = null, jwt = null;

console.log('Signed-in funnel →', BASE, '\nthrowaway account:', email, '\n');

try {
  // ── create and sign in ─────────────────────────────────────────────────────
  {
    const { data, error } = await db.auth.admin.createUser({ email, password, email_confirm: true });
    if (!check(!error && data?.user?.id, 'throwaway account created', error?.message || '')) throw new Error('cannot continue');
    userId = data.user.id;

    const anon = createClient(url, process.env.SUPABASE_ANON_KEY ||
      'sb_publishable_1Ks92vUbYplxWzveOT7BtQ_seHUf3cW');
    const s = await anon.auth.signInWithPassword({ email, password });
    if (!check(!s.error && s.data?.session?.access_token, 'signed in, got a JWT', s.error?.message || '')) throw new Error('cannot continue');
    jwt = s.data.session.access_token;
  }
  const H = { 'content-type': 'application/json', authorization: 'Bearer ' + jwt };

  // ── the account describes itself ───────────────────────────────────────────
  let allowance;
  {
    const d = await j(await fetch(BASE + '/api/me', { headers: H }));
    check(d.kind === 'user', 'me knows this is a signed-in user', d.kind);
    check(d.status === 'active', 'new account starts active', d.status);
    check(d.allowance?.quota === 3 && d.allowance?.left === 3, 'new account gets 3 conversations',
          `${d.allowance?.left}/${d.allowance?.quota}`);
    check(d.selfMode === false, '"Just me" is closed for the trial', String(d.selfMode));
    allowance = d.allowance;

    const { data: prof } = await db.from('profiles').select('*').eq('user_id', userId).maybeSingle();
    check(!!prof, 'a profile row was created on first contact');
    check(Number(prof?.analyses_quota) === 3 && Number(prof?.analyses_used) === 0,
          'the allowance is stored in the database, not in memory',
          `${prof?.analyses_used}/${prof?.analyses_quota}`);
  }

  // ── phone becomes the account key ──────────────────────────────────────────
  {
    const r = await fetch(BASE + '/api/profile/phone', {
      method: 'POST', headers: H, body: JSON.stringify({ phone: '98765' + String(stamp).slice(-5), display_name: 'Funnel' })
    });
    const d = await j(r);
    check(r.ok && /^91\d{10}$/.test(d.phone || ''), 'phone saved and normalised to 91XXXXXXXXXX', d.phone || d.error);
    const bad = await fetch(BASE + '/api/profile/phone', { method: 'POST', headers: H, body: JSON.stringify({ phone: '123' }) });
    check(bad.status === 400, 'an invalid number is refused', 'HTTP ' + bad.status);
  }

  // ── three analyses, then the wall ──────────────────────────────────────────
  let sessionIds = [], refusal = null;
  for (let n = 1; n <= 4; n++) {
    if (n > 1) { console.log(`   waiting 65s for the per-minute window (${n} of 4)...`); await wait(65000); }
    const r = await fetch(BASE + '/api/analyze', {
      method: 'POST', headers: H,
      body: JSON.stringify({ transcript: TRANSCRIPT, mode: 'relationship', submode: 'couple',
                             nameA: 'Kavya', nameB: 'Rohit', source: 'text', consent: 'both_partners' })
    });
    const d = await j(r);
    if (r.ok) {
      sessionIds.push(d.sessionId);
      check(n <= 3, `analysis ${n} succeeded`, `left ${d.allowance?.left}/${d.allowance?.quota}`);
      check(!!d.sessionId, `analysis ${n} was persisted`, d.sessionId || '');
      check(d.allowance?.left === 3 - n, `allowance after ${n} is ${3 - n}`, String(d.allowance?.left));
    } else if (r.status === 429 && d.code === 'analyses_exhausted') {
      refusal = d;
      check(n === 4, 'the wall arrives on the fourth attempt, not before', 'attempt ' + n);
    } else if (r.status === 503) {
      console.log(`   (busy on attempt ${n}, retrying after the window)`); n--;
    } else {
      check(false, `analysis ${n}`, `HTTP ${r.status} ${d.error || ''}`);
      break;
    }
  }
  check(!!refusal, 'the trial allowance refuses a fourth conversation', refusal?.error || 'never refused');
  check(!/error|failed|denied/i.test(refusal?.error || ''), 'the refusal reads like a person wrote it', refusal?.error || '');

  // ── it all comes back ──────────────────────────────────────────────────────
  {
    const d = await j(await fetch(BASE + '/api/history', { headers: H }));
    check(Array.isArray(d.sessions) && d.sessions.length === sessionIds.length,
          'every analysis is in history', `${d.sessions?.length} of ${sessionIds.length}`);
    const row = (d.sessions || [])[0] || {};
    check(Array.isArray(row.original) && row.original.length > 0, 'history kept act 1', String(row.original?.length));
    check(Array.isArray(row.improved) && row.improved.length > 0, 'history kept act 2', String(row.improved?.length));
    check(row.speakers && row.speakers.A, 'history kept the speaker map the replay needs');
    check(['voiced','real_audio','silent'].includes(row.act1_mode), 'history recorded the act-1 variant', row.act1_mode);
    check(row.name_a === 'Kavya' && row.name_b === 'Rohit', 'history kept the names');
  }

  // ── feedback, now that there is a real session to attach it to ──────────────
  {
    const r = await fetch(BASE + '/api/feedback', {
      method: 'POST', headers: H,
      body: JSON.stringify({ session_id: sessionIds[0], will_try: 'yes', top_suggestion: 'Name the feeling', context: { mode: 'relationship' } })
    });
    const d = await j(r);
    check(r.ok && d.stored === true, 'feedback is actually stored for a signed-in user', JSON.stringify(d));
    const { data: rows } = await db.from('feedback').select('*').eq('user_id', userId);
    check((rows || []).length === 1 && rows[0].will_try === 'yes', 'the feedback row is in the database');
    check(rows?.[0]?.asked_at && !isNaN(Date.parse(rows[0].asked_at)), 'asked_at is a real timestamp', rows?.[0]?.asked_at || '');
  }

  // ── a suspended account is stopped ─────────────────────────────────────────
  {
    await db.from('profiles').update({ status: 'suspended' }).eq('user_id', userId);
    const r = await fetch(BASE + '/api/analyze', {
      method: 'POST', headers: H,
      body: JSON.stringify({ transcript: TRANSCRIPT, mode: 'relationship', submode: 'couple', nameA: 'Kavya', nameB: 'Rohit', source: 'text' })
    });
    const d = await j(r);
    check(r.status === 403, 'a suspended account cannot spend anything', 'HTTP ' + r.status);
    check(/paused/i.test(d.error || ''), 'and is told so kindly', d.error || '');

    // raising the limit should let them straight back in
    await db.from('profiles').update({ status: 'active', analyses_quota: 10 }).eq('user_id', userId);
    const me = await j(await fetch(BASE + '/api/me', { headers: H }));
    check(me.allowance?.quota === 10 && me.allowance?.left === 7,
          'raising the limit from admin takes effect immediately', `${me.allowance?.left}/${me.allowance?.quota}`);
  }

  // ── a user cannot raise their own limits ───────────────────────────────────
  {
    const anon = createClient(url, process.env.SUPABASE_ANON_KEY || 'sb_publishable_1Ks92vUbYplxWzveOT7BtQ_seHUf3cW',
      { global: { headers: { Authorization: 'Bearer ' + jwt } } });
    const { data: readable } = await anon.from('profiles').select('*').eq('user_id', userId);
    check((readable || []).length === 1, 'a user can read their own profile', String(readable?.length));
    const { error: wErr } = await anon.from('profiles').update({ analyses_quota: 9999 }).eq('user_id', userId);
    const { data: after } = await db.from('profiles').select('analyses_quota').eq('user_id', userId).maybeSingle();
    check(Number(after?.analyses_quota) === 10, 'a user CANNOT raise their own allowance',
          wErr ? 'blocked by RLS' : 'silently no-opped, value unchanged');
    const { data: others } = await anon.from('sessions').select('id').neq('user_id', userId);
    check((others || []).length === 0, 'a user cannot read anyone else\'s sessions', String(others?.length));
  }

} catch (e) {
  check(false, 'run completed', String(e.message || e));
} finally {
  if (userId) {
    const { error } = await db.auth.admin.deleteUser(userId);
    console.log('\ncleanup:', error ? 'FAILED to delete ' + userId + ' — ' + error.message : 'throwaway account and all its rows deleted');
  }
}

console.log('');
for (const [m, n, d] of out) console.log(`  ${m}  ${n}${d ? '  ·  ' + d : ''}`);
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
