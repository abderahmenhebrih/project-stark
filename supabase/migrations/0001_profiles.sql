-- STARK Stage 29 — minimal cloud profile foundation.
--
-- Optional Supabase table only. No Workspace, file, session, message,
-- transaction, change-set, tool, runtime, or usage tables exist here
-- by design: signing in uploads no project data.
--
-- Clients use the anon/publishable key only. Never a service_role key.

create table if not exists public.profiles (
  user_id uuid primary key references auth.users(id) on delete cascade,
  display_name text,
  avatar_url text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.profiles enable row level security;

-- Authenticated users may read only their own profile.
drop policy if exists "profiles_select_own" on public.profiles;
create policy "profiles_select_own"
  on public.profiles
  for select
  to authenticated
  using (auth.uid() = user_id);

-- Authenticated users may insert only their own profile.
drop policy if exists "profiles_insert_own" on public.profiles;
create policy "profiles_insert_own"
  on public.profiles
  for insert
  to authenticated
  with check (auth.uid() = user_id);

-- Authenticated users may update only their own profile.
drop policy if exists "profiles_update_own" on public.profiles;
create policy "profiles_update_own"
  on public.profiles
  for update
  to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);
