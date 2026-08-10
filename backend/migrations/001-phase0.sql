-- Samvaad — Phase 0 migration (lock the doors).
-- Paste into the Supabase SQL editor and run once. Safe to re-run: every statement is guarded.
--
-- Adds:  profiles (per-user status, quota, feature flags, phone)
--        app_settings (things the non-technical admin flips, so they never touch env vars)
--        sessions.speakers + sessions.truncated
-- Drops: founding_members (the pre-sell mock is gone)

create extension if not exists "pgcrypto";

-- ---------------------------------------------------------------------------
-- profiles — one row per signed-in user. Phone is the unique account key.
-- ---------------------------------------------------------------------------
create table if not exists public.profiles (
  user_id            uuid primary key references auth.users(id) on delete cascade,
  phone              text unique,
  phone_verified     boolean not null default false,
  verify_code        text,
  display_name       text,
  status             text not null default 'active' check (status in ('active','limited','suspended')),
  minutes_quota      numeric not null default 60,
  minutes_used_month numeric not null default 0,
  quota_month        text,                                  -- 'YYYY-MM'; used resets when this rolls
  features           jsonb  not null default '{"self_reflection": false}'::jsonb,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

alter table public.profiles enable row level security;

-- A user may read their own profile. They may NOT write it: status, quota and feature flags are
-- admin-controlled, and the backend uses the service role (which bypasses RLS) to update them.
drop policy if exists "own_profile_read" on public.profiles;
create policy "own_profile_read" on public.profiles for select using (auth.uid() = user_id);

-- ---------------------------------------------------------------------------
-- app_settings — admin-flippable switches (guest access, global feature flags,
-- default quota). RLS on with NO policy: service role only, exactly like the
-- pattern founding_members used.
-- ---------------------------------------------------------------------------
create table if not exists public.app_settings (
  key        text primary key,
  value      jsonb not null,
  updated_at timestamptz not null default now()
);

alter table public.app_settings enable row level security;

insert into public.app_settings (key, value) values
  ('guest_enabled',        'true'::jsonb),
  ('default_minutes_quota','60'::jsonb)
on conflict (key) do nothing;

-- ---------------------------------------------------------------------------
-- sessions — keep the speaker map (the replay needs it to pick the right rig)
-- and record when a long conversation was trimmed to the word ceiling.
-- ---------------------------------------------------------------------------
alter table public.sessions add column if not exists speakers  jsonb   default '{}'::jsonb;
alter table public.sessions add column if not exists truncated boolean default false;

-- ---------------------------------------------------------------------------
-- founding_members — the pre-sell page was a mock and is deleted. Razorpay is
-- not part of the trial. Drop the table and its data.
-- ---------------------------------------------------------------------------
drop table if exists public.founding_members;
