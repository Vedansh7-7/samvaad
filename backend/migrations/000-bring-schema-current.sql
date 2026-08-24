-- =============================================================================
-- Samvaad — ONE migration that brings any database up to the current schema.
--
-- Run this and nothing else. Paste the whole file into the Supabase SQL editor
-- (Dashboard -> SQL Editor -> New query -> paste -> Run) and press Run once.
--
-- It is safe on a fresh database, safe on a half-migrated one, and safe to run
-- again: every statement is guarded, no statement destroys user data, and it
-- supersedes 001-phase0 / 002-prelaunch / 003-analyses-allowance (kept in this
-- folder only as history — you do not need to run them).
--
-- After it finishes, check the backend: Admin -> Metrics shows a green
-- "Database is up to date" line, or tells you exactly what is still missing.
-- =============================================================================

create extension if not exists "pgcrypto";

-- -----------------------------------------------------------------------------
-- 1. sessions — one row per analysed conversation
-- -----------------------------------------------------------------------------
create table if not exists public.sessions (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references auth.users(id) on delete cascade,
  mode         text not null check (mode in ('relationship','self')),
  submode      text not null check (submode in ('couple','solo')),
  language     text default 'mixed',
  name_a       text,
  name_b       text,
  scores       jsonb not null default '{}'::jsonb,
  summary      text,
  patterns     jsonb default '[]'::jsonb,
  strengths    jsonb default '[]'::jsonb,
  improvements jsonb default '[]'::jsonb,
  improved     jsonb default '[]'::jsonb,
  kpis         jsonb default '{}'::jsonb,
  created_at   timestamptz not null default now()
);

-- Added after the first release. The replay needs `speakers` to pick the right rig, the
-- walk-through's act 1 needs `original`, and `act1_mode` records which variant was live so the
-- A/B can still be read after the default changes.
alter table public.sessions add column if not exists original   jsonb   default '[]'::jsonb;
alter table public.sessions add column if not exists speakers   jsonb   default '{}'::jsonb;
alter table public.sessions add column if not exists truncated  boolean default false;
alter table public.sessions add column if not exists act1_mode  text;

-- -----------------------------------------------------------------------------
-- 2. feedback — the {context -> intervention -> outcome} signal
-- -----------------------------------------------------------------------------
create table if not exists public.feedback (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null references auth.users(id) on delete cascade,
  session_id      uuid references public.sessions(id) on delete cascade,
  asked_at        timestamptz not null default now(),
  context         jsonb default '{}'::jsonb,
  top_suggestion  text,
  will_try        text check (will_try in ('yes','maybe','no')),
  outcome         text
);

-- -----------------------------------------------------------------------------
-- 3. consents — the attestation for a recording containing a second person
-- -----------------------------------------------------------------------------
create table if not exists public.consents (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users(id) on delete cascade,
  session_id  uuid references public.sessions(id) on delete set null,
  kind        text not null,
  attested    boolean not null default true,
  created_at  timestamptz not null default now()
);

-- -----------------------------------------------------------------------------
-- 4. nudge_subscriptions — WhatsApp check-in opt-ins, the user's OWN number only
-- -----------------------------------------------------------------------------
create table if not exists public.nudge_subscriptions (
  user_id      uuid primary key references auth.users(id) on delete cascade,
  phone        text not null,
  display_name text,
  cadence      text not null default 'daily' check (cadence in ('daily','weekly','off')),
  consent      boolean not null default true,
  active       boolean not null default true,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

-- -----------------------------------------------------------------------------
-- 5. profiles — per-account status, trial allowance and feature flags
--    Phone is the account key for the trial. A user may READ their own row and
--    never write it, because status/quota/flags are the admin's to set.
-- -----------------------------------------------------------------------------
create table if not exists public.profiles (
  user_id            uuid primary key references auth.users(id) on delete cascade,
  phone              text unique,
  phone_verified     boolean not null default false,
  verify_code        text,
  display_name       text,
  status             text not null default 'active' check (status in ('active','limited','suspended')),
  minutes_quota      numeric not null default 60,
  minutes_used_month numeric not null default 0,
  quota_month        text,
  features           jsonb  not null default '{"self_reflection": false}'::jsonb,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

-- The trial allowance: 3 analyses per account, total.
alter table public.profiles add column if not exists analyses_quota integer not null default 3;
alter table public.profiles add column if not exists analyses_used  integer not null default 0;

-- -----------------------------------------------------------------------------
-- 6. app_settings — the switches the admin console flips, so a non-technical
--    admin never has to touch an env var or wait for a deploy.
-- -----------------------------------------------------------------------------
create table if not exists public.app_settings (
  key        text primary key,
  value      jsonb not null,
  updated_at timestamptz not null default now()
);

insert into public.app_settings (key, value) values
  ('guest_enabled',           'true'::jsonb),
  ('default_minutes_quota',   '60'::jsonb),
  ('default_analyses_quota',  '3'::jsonb),
  ('act1_mode',               '"voiced"'::jsonb),
  ('intro_enabled',           'true'::jsonb),
  ('self_reflection_enabled', 'false'::jsonb)
on conflict (key) do nothing;

-- -----------------------------------------------------------------------------
-- 7. events — product analytics. Small, append-only, and the only way the intro
--    funnel (played / skipped / how far they got) becomes a number you can read.
-- -----------------------------------------------------------------------------
create table if not exists public.events (
  id         bigserial primary key,
  user_id    uuid references auth.users(id) on delete cascade,
  anon_id    text,                                  -- guests and pre-login visitors
  name       text not null,
  props      jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index if not exists events_name_created on public.events (name, created_at desc);
create index if not exists events_user_created on public.events (user_id, created_at desc);

-- -----------------------------------------------------------------------------
-- 8. Row-level security. Every user-facing table is locked to its owner.
--    Policies are dropped first so re-running this file cannot fail on a
--    duplicate-policy error.
-- -----------------------------------------------------------------------------
alter table public.sessions            enable row level security;
alter table public.feedback            enable row level security;
alter table public.consents            enable row level security;
alter table public.nudge_subscriptions enable row level security;
alter table public.profiles            enable row level security;
alter table public.app_settings        enable row level security;
alter table public.events              enable row level security;

drop policy if exists "own_sessions"            on public.sessions;
drop policy if exists "own_feedback"            on public.feedback;
drop policy if exists "own_consents"            on public.consents;
drop policy if exists "own_nudge_subscriptions" on public.nudge_subscriptions;
drop policy if exists "own_profile_read"        on public.profiles;

create policy "own_sessions"            on public.sessions            for all    using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "own_feedback"            on public.feedback            for all    using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "own_consents"            on public.consents            for all    using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "own_nudge_subscriptions" on public.nudge_subscriptions for all    using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "own_profile_read"        on public.profiles            for select using (auth.uid() = user_id);

-- app_settings and events carry NO policy on purpose: RLS is on and nothing is
-- granted, so only the backend's service role can read or write them.

-- -----------------------------------------------------------------------------
-- 9. Indexes the admin console leans on (it reads every session on each load)
-- -----------------------------------------------------------------------------
create index if not exists sessions_user_created on public.sessions (user_id, created_at desc);
create index if not exists profiles_status_idx   on public.profiles (status);

-- -----------------------------------------------------------------------------
-- 10. Backfill: give accounts that pre-date the counter an honest starting
--     point, counting the analyses actually on record rather than handing
--     everyone a clean slate on day one.
-- -----------------------------------------------------------------------------
update public.profiles p
   set analyses_used = coalesce(c.n, 0)
  from (select user_id, count(*)::int as n from public.sessions group by user_id) c
 where c.user_id = p.user_id
   and p.analyses_used = 0;

-- -----------------------------------------------------------------------------
-- 11. Remove what is no longer part of the product. The pre-sell page was a mock
--     and Razorpay is out of scope for the trial.
-- -----------------------------------------------------------------------------
drop table if exists public.founding_members;

-- -----------------------------------------------------------------------------
-- 12. Tell PostgREST to reload. Supabase's API layer caches the schema, so a
--     brand-new table keeps returning "Could not find the table 'public.X' in
--     the schema cache" until it is told to look again. This line is why you do
--     not have to wait or restart anything.
-- -----------------------------------------------------------------------------
notify pgrst, 'reload schema';
