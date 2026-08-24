-- Samvaad — Pre-launch migration (trial cohort).
-- Paste into the Supabase SQL editor and run once, AFTER 001-phase0.sql.
-- Safe to re-run: every statement is guarded.
--
-- Adds:  sessions.original     the pivotal stretch of the real conversation, for act 1 of the
--                              walk-through (the kinder version already lived in sessions.improved)
--        sessions.act1_mode    which act-1 delivery the account was on when this ran, so the
--                              A/B between the variants can actually be read back later
--        app_settings rows     the switches the admin console flips: act-1 variant, intro video,
--                              and the "Just me" mode, which is built but off for the trial
--        two indexes           the admin console reads every session and profile on each load

-- ---------------------------------------------------------------------------
-- sessions
-- ---------------------------------------------------------------------------
alter table public.sessions add column if not exists original  jsonb default '[]'::jsonb;
alter table public.sessions add column if not exists act1_mode text;

-- ---------------------------------------------------------------------------
-- app_settings — global switches. RLS is on with no policy, so these are service-role only and
-- can never be read or written from the browser.
-- ---------------------------------------------------------------------------
insert into public.app_settings (key, value) values
  -- which opening the walk-through uses: 'voiced' | 'real_audio' | 'silent'
  ('act1_mode',               '"voiced"'::jsonb),
  -- show the animated intro to first-time visitors before the login page
  ('intro_enabled',           'true'::jsonb),
  -- "Just me" / self reflection: kept in the code, closed for the trial cohort.
  -- Flip this true, or set features.self_reflection on one profile, to open it.
  ('self_reflection_enabled', 'false'::jsonb)
on conflict (key) do nothing;

-- ---------------------------------------------------------------------------
-- Indexes for the admin console. It lists every account with their last activity, which is a
-- full scan of sessions on each load. Cheap now, and cheaper to add before there is data.
-- ---------------------------------------------------------------------------
create index if not exists sessions_user_created on public.sessions (user_id, created_at desc);
create index if not exists profiles_status_idx  on public.profiles (status);

-- ---------------------------------------------------------------------------
-- Backfill: existing sessions predate the experiment. Leave act1_mode null rather than guessing
-- a variant they were never shown — the KPI query counts only rows that carry a real value.
-- ---------------------------------------------------------------------------
