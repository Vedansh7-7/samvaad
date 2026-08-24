// Samvaad — does the live database match what the code expects?
//
//   cd backend && npm run schema:check
//
// Reads SUPABASE_URL / SUPABASE_SERVICE_KEY from .env and probes every table and column the
// backend uses. Needs no running server. If anything is missing it prints the one file to run.
//
// This exists because the failure it catches is invisible: a missing `profiles` table and a user
// who simply has no profile row look identical from the outside, so the admin console renders
// plausible defaults and only reveals the truth as a PostgREST error when you press Save.

import { createClient } from '@supabase/supabase-js';

const url = process.env.SUPABASE_URL, key = process.env.SUPABASE_SERVICE_KEY;
if (!url || !key) {
  console.log('SUPABASE_URL / SUPABASE_SERVICE_KEY are not set. Fill them into backend/.env.');
  process.exit(1);
}
const db = createClient(url, key);

const EXPECTED = {
  sessions: ['id','user_id','mode','submode','name_a','name_b','scores','summary','patterns',
             'strengths','improvements','original','improved','kpis','speakers','truncated',
             'act1_mode','created_at'],
  feedback: ['id','user_id','session_id','asked_at','context','top_suggestion','will_try'],
  consents: ['id','user_id','session_id','kind','attested','created_at'],
  nudge_subscriptions: ['user_id','phone','display_name','cadence','consent','active'],
  profiles: ['user_id','phone','phone_verified','display_name','status','minutes_quota',
             'minutes_used_month','quota_month','features','analyses_quota','analyses_used'],
  app_settings: ['key','value','updated_at'],
  events: ['id','user_id','anon_id','name','props','created_at']
};

console.log('checking', url, '\n');
let bad = 0;

for (const [table, cols] of Object.entries(EXPECTED)) {
  const probe = await db.from(table).select('*').limit(1);
  if (probe.error) { console.log(`  MISSING  ${table}`); bad++; continue; }
  const missing = [];
  for (const c of cols) {
    const r = await db.from(table).select(c).limit(1);
    if (r.error) missing.push(c);
  }
  if (missing.length) { console.log(`  PARTIAL  ${table} — missing: ${missing.join(', ')}`); bad++; }
  else console.log(`  ok       ${table} (${cols.length} columns)`);
}

// Things that should be gone
const gone = await db.from('founding_members').select('*').limit(1);
if (!gone.error) { console.log('  STALE    founding_members still exists (the pre-sell was removed)'); bad++; }

// The switches the admin console flips
const settings = await db.from('app_settings').select('key');
if (!settings.error) {
  const have = new Set((settings.data || []).map(r => r.key));
  const want = ['guest_enabled','default_minutes_quota','default_analyses_quota','act1_mode',
                'intro_enabled','self_reflection_enabled'];
  const missing = want.filter(k => !have.has(k));
  if (missing.length) { console.log('  PARTIAL  app_settings rows missing: ' + missing.join(', ')); bad++; }
  else console.log('  ok       app_settings seeded (' + want.length + ' switches)');
}

console.log('');
if (bad) {
  console.log(`${bad} problem(s). Fix all of them by running ONE file:`);
  console.log('  Supabase dashboard → SQL Editor → New query');
  console.log('  paste backend/migrations/000-bring-schema-current.sql → Run');
  process.exit(1);
}
console.log('Database matches the code.');
