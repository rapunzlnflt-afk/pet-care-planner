-- 0004_pawfolio_dose_sharing.sql
--
-- Sharing doses with a sitter (Pawfolio Complete). Builds on 0003 and changes
-- none of its rules or policies.
--
-- Design (shared dose scheduling spec, section 4):
--   * The sitter never gets table access. Every sitter call goes through the
--     pawfolio-dose-share Edge Function, which checks a share token and does a
--     short list of things: join, read state, log a dose, leave.
--   * The share secret lives only in the link's #fragment. Only its sha256 is
--     stored, so a leaked row does not grant access.
--   * Sharing is per medication (pawfolio_dose_schedules.shared). A sitter
--     sees only shared medications: label, pet name, dose times and dose
--     history. No records, vets, notes or other app data.
--   * One active group per owner: one sitter link covers every shared
--     medication. Stopping sharing revokes it; a new link is a new group.

-- =====================================================================
-- 1. Groups (one sitter link) and members (each sitter phone).
-- =====================================================================
create table if not exists public.pawfolio_dose_groups (
  id          uuid primary key default gen_random_uuid(),
  owner_user  uuid not null references auth.users(id) on delete cascade,
  -- Shown to the sitter, e.g. "Shauna". Optional.
  owner_label text,
  token_hash  text not null unique,
  -- Slides forward 30 days whenever the link is used.
  expires_at  timestamptz not null default (now() + interval '30 days'),
  revoked_at  timestamptz,
  created_at  timestamptz not null default now()
);

create unique index if not exists pawfolio_dose_groups_one_active
  on public.pawfolio_dose_groups (owner_user) where revoked_at is null;

create or replace function public.pawfolio_dose_groups_set_owner() returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if new.owner_user is null then
    new.owner_user := auth.uid();
  end if;
  return new;
end$$;

drop trigger if exists pawfolio_dose_groups_set_owner on public.pawfolio_dose_groups;
create trigger pawfolio_dose_groups_set_owner
  before insert on public.pawfolio_dose_groups
  for each row execute function public.pawfolio_dose_groups_set_owner();

alter table public.pawfolio_dose_groups enable row level security;

drop policy if exists pawfolio_dose_groups_owner_select on public.pawfolio_dose_groups;
create policy pawfolio_dose_groups_owner_select on public.pawfolio_dose_groups
  for select using (owner_user = auth.uid());
drop policy if exists pawfolio_dose_groups_owner_insert on public.pawfolio_dose_groups;
create policy pawfolio_dose_groups_owner_insert on public.pawfolio_dose_groups
  for insert with check (owner_user is null or owner_user = auth.uid());
drop policy if exists pawfolio_dose_groups_owner_update on public.pawfolio_dose_groups;
create policy pawfolio_dose_groups_owner_update on public.pawfolio_dose_groups
  for update using (owner_user = auth.uid());
drop policy if exists pawfolio_dose_groups_owner_delete on public.pawfolio_dose_groups;
create policy pawfolio_dose_groups_owner_delete on public.pawfolio_dose_groups
  for delete using (owner_user = auth.uid());

create table if not exists public.pawfolio_dose_members (
  id          uuid primary key default gen_random_uuid(),
  group_id    uuid not null references public.pawfolio_dose_groups(id) on delete cascade,
  label       text not null check (char_length(label) between 1 and 40),
  role        text not null default 'helper' check (role in ('helper')),
  device_id   text not null,
  endpoint    text,
  p256dh      text,
  auth        text,
  timezone    text,
  joined_at   timestamptz not null default now(),
  last_seen_at timestamptz,
  removed_at  timestamptz,
  unique (group_id, device_id)
);

create index if not exists pawfolio_dose_members_group_idx
  on public.pawfolio_dose_members (group_id) where removed_at is null;

alter table public.pawfolio_dose_members enable row level security;

-- The owner can see and remove sitters. Sitters themselves have no table
-- access at all; they go through the Edge Function.
drop policy if exists pawfolio_dose_members_owner_select on public.pawfolio_dose_members;
create policy pawfolio_dose_members_owner_select on public.pawfolio_dose_members
  for select using (
    exists (select 1 from public.pawfolio_dose_groups g
            where g.id = pawfolio_dose_members.group_id and g.owner_user = auth.uid())
  );
drop policy if exists pawfolio_dose_members_owner_update on public.pawfolio_dose_members;
create policy pawfolio_dose_members_owner_update on public.pawfolio_dose_members
  for update using (
    exists (select 1 from public.pawfolio_dose_groups g
            where g.id = pawfolio_dose_members.group_id and g.owner_user = auth.uid())
  );

-- =====================================================================
-- 2. Per-medication opt-in, and who logged each dose.
-- =====================================================================
alter table public.pawfolio_dose_schedules
  add column if not exists shared boolean not null default false;

alter table public.pawfolio_dose_events
  add column if not exists actor_member uuid
    references public.pawfolio_dose_members(id) on delete set null;

-- When a dose was given or skipped. Drives the "Given by Dana" follow-up.
alter table public.pawfolio_dose_events
  add column if not exists logged_at timestamptz;

-- When the follow-up push went out (null = not yet, or not shared).
alter table public.pawfolio_dose_events
  add column if not exists followup_sent_at timestamptz;

create index if not exists pawfolio_dose_events_followup_idx
  on public.pawfolio_dose_events (logged_at)
  where followup_sent_at is null and logged_at is not null;

create or replace function public.pawfolio_dose_events_stamp_logged() returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if old.status = 'pending' and new.status in ('taken', 'skipped') and new.logged_at is null then
    new.logged_at := now();
  end if;
  return new;
end$$;

drop trigger if exists pawfolio_dose_events_stamp_logged on public.pawfolio_dose_events;
create trigger pawfolio_dose_events_stamp_logged
  before update on public.pawfolio_dose_events
  for each row execute function public.pawfolio_dose_events_stamp_logged();

-- =====================================================================
-- 3. Logging on a sitter's behalf (Edge Function only).
--
-- Wraps pawfolio_log_dose() so the dose, its attribution and the next dose
-- are recorded in one transaction. Checks that the dose belongs to a SHARED
-- medication of the group's owner, so a sitter can never log anything else.
-- =====================================================================
create or replace function public.pawfolio_log_dose_as_member(
  p_member_id uuid,
  p_event_id  uuid,
  p_taken     boolean,
  p_force     boolean default false
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_member public.pawfolio_dose_members;
  v_group  public.pawfolio_dose_groups;
  v_ok     boolean;
  v_res    jsonb;
begin
  select * into v_member from public.pawfolio_dose_members where id = p_member_id;
  if not found or v_member.removed_at is not null then
    raise exception 'not a member' using errcode = 'insufficient_privilege';
  end if;

  select * into v_group from public.pawfolio_dose_groups where id = v_member.group_id;
  if not found or v_group.revoked_at is not null or v_group.expires_at < now() then
    raise exception 'link no longer active' using errcode = 'insufficient_privilege';
  end if;

  select exists (
    select 1 from public.pawfolio_dose_events e
    join public.pawfolio_dose_schedules s on s.id = e.schedule_id
    where e.id = p_event_id and s.user_id = v_group.owner_user and s.shared
  ) into v_ok;
  if not v_ok then
    raise exception 'dose not shared' using errcode = 'insufficient_privilege';
  end if;

  v_res := public.pawfolio_log_dose(p_event_id, p_taken, null, v_member.label, null, p_force);

  if v_res->>'outcome' = 'logged' then
    update public.pawfolio_dose_events set actor_member = v_member.id where id = p_event_id;
  end if;

  return v_res;
end$$;

revoke all on function public.pawfolio_log_dose_as_member(uuid, uuid, boolean, boolean) from public;
revoke all on function public.pawfolio_log_dose_as_member(uuid, uuid, boolean, boolean) from anon, authenticated;

comment on function public.pawfolio_log_dose_as_member(uuid, uuid, boolean, boolean) is
  'Edge Function only: a sitter records a dose of a shared medication.';
