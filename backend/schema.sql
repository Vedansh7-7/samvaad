-- Samvaad — Supabase schema (Phase 1 backend)
-- Apply in the Supabase SQL editor, or I can apply it for you via the Supabase connector.
-- Auth is handled by Supabase Auth (auth.users). Every table is locked to its owner via RLS.

create extension if not exists "pgcrypto";

-- One row per analysed conversation / introspection session.
create table if not exists public.sessions (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references auth.users(id) on delete cascade,
  mode         text not null check (mode in ('relationship','self')),
  submode      text not null check (submode in ('couple','solo')),
  language     text default 'mixed',
  name_a       text,
  name_b       text,
  scores       jsonb not null default '{}'::jsonb,   -- {connection,empathy,escalation_risk,overall}
  summary      text,
  patterns     jsonb default '[]'::jsonb,
  strengths    jsonb default '[]'::jsonb,
  improvements jsonb default '[]'::jsonb,
  original     jsonb default '[]'::jsonb,             -- the pivotal real turns, verbatim (walk-through act 1)
  improved     jsonb default '[]'::jsonb,             -- the rewritten conversation turns (act 2)
  kpis         jsonb default '{}'::jsonb,             -- acoustic/text KPIs (staged: pitch, rate, pauses)
  speakers     jsonb default '{}'::jsonb,             -- {A:{name,gender},B:{...}} — the replay picks rigs from this
  truncated    boolean default false,                 -- true when a long conversation hit the word ceiling
  act1_mode    text,                                  -- which act-1 delivery was live: voiced|real_audio|silent
  created_at   timestamptz not null default now()
);

-- The feedback-loop signal: what we asked, when, and what they said.
-- This is the {context -> intervention -> outcome} record a recommender will learn from.
create table if not exists public.feedback (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null references auth.users(id) on delete cascade,
  session_id      uuid references public.sessions(id) on delete cascade,
  asked_at        timestamptz not null default now(),
  context         jsonb default '{}'::jsonb,          -- {escalation_risk, time_of_day, ...}
  top_suggestion  text,
  will_try        text check (will_try in ('yes','maybe','no')),
  outcome         text                                -- filled in later: did it actually help?
);

-- Consent ledger. An uploaded couple recording contains a second person — we record the attestation.
create table if not exists public.consents (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users(id) on delete cascade,
  session_id  uuid references public.sessions(id) on delete set null,
  kind        text not null,                          -- 'self_only' | 'both_partners' | 'professional'
  attested    boolean not null default true,
  created_at  timestamptz not null default now()
);

-- Raw audio lives in a private Storage bucket and is deleted right after transcription.
-- Create the bucket named 'audio' (private) in the dashboard; a scheduled function purges objects > 24h.

-- ---- Row-level security: a user can only ever touch their own rows ----
alter table public.sessions  enable row level security;
alter table public.feedback  enable row level security;
alter table public.consents  enable row level security;

create policy "own_sessions"  on public.sessions  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "own_feedback"  on public.feedback  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "own_consents"  on public.consents  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- WhatsApp daily check-in opt-ins (retention). One row per user; the user's OWN number only —
-- partner numbers are never stored (DPDP two-party consent). Sending is wired later via a
-- provider + scheduler; this table is the opt-in ledger the scheduler reads.
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
alter table public.nudge_subscriptions enable row level security;
create policy "own_nudge_subscriptions" on public.nudge_subscriptions for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- One row per signed-in user. Phone is the unique account key for the trial cohort; status,
-- quota and feature flags are set by the admin. Users may read their own row but never write it
-- (the backend uses the service role for updates), so nobody can raise their own limits.
create table if not exists public.profiles (
  user_id            uuid primary key references auth.users(id) on delete cascade,
  phone              text unique,
  phone_verified     boolean not null default false,
  verify_code        text,
  display_name       text,
  status             text not null default 'active' check (status in ('active','limited','suspended')),
  minutes_quota      numeric not null default 60,
  analyses_quota     integer not null default 3,          -- the trial allowance: 3 analyses, total
  analyses_used      integer not null default 0,
  minutes_used_month numeric not null default 0,
  quota_month        text,                                  -- 'YYYY-MM'; usage resets when this rolls
  features           jsonb  not null default '{"self_reflection": false}'::jsonb,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);
alter table public.profiles enable row level security;
create policy "own_profile_read" on public.profiles for select using (auth.uid() = user_id);

-- Switches the (non-technical) admin flips from the panel instead of Render env vars:
-- guest access on/off, global feature flags, the default quota. RLS on with NO policy,
-- so only the backend service key can read or write it.
create table if not exists public.app_settings (
  key        text primary key,
  value      jsonb not null,
  updated_at timestamptz not null default now()
);
alter table public.app_settings enable row level security;
-- (intentionally no policy: service-role only)

insert into public.app_settings (key, value) values
  ('guest_enabled',           'true'::jsonb),
  ('default_minutes_quota',   '60'::jsonb),
  ('default_analyses_quota',  '3'::jsonb),      -- analyses a new account gets, total
  ('act1_mode',               '"voiced"'::jsonb),   -- walk-through act 1: voiced|real_audio|silent
  ('intro_enabled',           'true'::jsonb),       -- animated intro before the login page
  ('self_reflection_enabled', 'false'::jsonb)       -- "Just me" is built but closed for the trial
on conflict (key) do nothing;

create index if not exists sessions_user_created on public.sessions (user_id, created_at desc);
