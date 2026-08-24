-- Samvaad — the trial allowance.
-- Paste into the Supabase SQL editor and run once, AFTER 002-prelaunch.sql.
-- Safe to re-run: every statement is guarded.
--
-- Every signed-up user gets a fixed number of analyses (3), not a monthly rate. Minutes stay as a
-- second guard against one enormous upload, but this is the limit a tester actually meets.
-- Admin raises it per person on the People tab, or changes the default for everyone in Settings.

alter table public.profiles add column if not exists analyses_quota integer not null default 3;
alter table public.profiles add column if not exists analyses_used  integer not null default 0;

-- Anyone who signed up before this existed keeps whatever they have already run, and gets the
-- same allowance from here. Giving early testers a fresh 3 would be the friendlier read, but it
-- would also make the admin's "exhausted" count a lie on day one.
update public.profiles
   set analyses_quota = 3
 where analyses_quota is null;

insert into public.app_settings (key, value) values
  ('default_analyses_quota', '3'::jsonb)
on conflict (key) do nothing;

-- Backfill analyses_used from the sessions actually on record, so the cap starts out honest for
-- accounts that pre-date the counter rather than handing them a clean slate.
update public.profiles p
   set analyses_used = coalesce(c.n, 0)
  from (select user_id, count(*)::int as n from public.sessions group by user_id) c
 where c.user_id = p.user_id
   and p.analyses_used = 0;
