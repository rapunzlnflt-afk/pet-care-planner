-- Pawfolio phone reminders schema.
--
-- This is designed to live ALONGSIDE the MedRecords tables in the SAME Supabase
-- project. Every object is namespaced with a `pawfolio_` prefix so it can never
-- collide with MedRecords' `devices` / `reminders` tables.
--
-- Two tables: `pawfolio_devices` holds Web Push subscriptions,
-- `pawfolio_reminders` holds the upcoming reminder occurrences the client has
-- synced. Both are scoped to the authenticated Supabase user (anonymous users
-- included). No pet record data is stored here — only the short strings shown
-- in the notification.

create extension if not exists "pgcrypto";

-- Shared updated_at helper (created if MedRecords hasn't already made one;
-- using a uniquely-named function avoids clashing with any existing one).
create or replace function public.pawfolio_set_updated_at() returns trigger
language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end$$;

-- =====================================================================
-- pawfolio_devices: one row per device + browser. The client uses a UUID
-- stored in localStorage (pawfolio-device-id) as the natural key so a
-- re-subscribe replaces the row instead of creating a duplicate.
-- =====================================================================
create table if not exists public.pawfolio_devices (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null references auth.users(id) on delete cascade,
  device_id       text not null,
  endpoint        text not null,
  p256dh          text,
  auth            text,
  user_agent      text,
  timezone        text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (user_id, device_id)
);

create index if not exists pawfolio_devices_endpoint_idx on public.pawfolio_devices(endpoint);

drop trigger if exists pawfolio_devices_set_updated_at on public.pawfolio_devices;
create trigger pawfolio_devices_set_updated_at
  before update on public.pawfolio_devices
  for each row execute function public.pawfolio_set_updated_at();

-- Auto-fill user_id from auth.uid() on insert so the client doesn't have to
-- send it (and can't spoof someone else's id).
create or replace function public.pawfolio_devices_set_user_id() returns trigger
language plpgsql as $$
begin
  if new.user_id is null then
    new.user_id := auth.uid();
  end if;
  return new;
end$$;

drop trigger if exists pawfolio_devices_set_user_id on public.pawfolio_devices;
create trigger pawfolio_devices_set_user_id
  before insert on public.pawfolio_devices
  for each row execute function public.pawfolio_devices_set_user_id();

alter table public.pawfolio_devices enable row level security;

drop policy if exists pawfolio_devices_owner_select on public.pawfolio_devices;
create policy pawfolio_devices_owner_select on public.pawfolio_devices
  for select using (user_id = auth.uid());
drop policy if exists pawfolio_devices_owner_insert on public.pawfolio_devices;
create policy pawfolio_devices_owner_insert on public.pawfolio_devices
  for insert with check (user_id is null or user_id = auth.uid());
drop policy if exists pawfolio_devices_owner_update on public.pawfolio_devices;
create policy pawfolio_devices_owner_update on public.pawfolio_devices
  for update using (user_id = auth.uid());
drop policy if exists pawfolio_devices_owner_delete on public.pawfolio_devices;
create policy pawfolio_devices_owner_delete on public.pawfolio_devices
  for delete using (user_id = auth.uid());

-- =====================================================================
-- pawfolio_reminders: one row per upcoming reminder occurrence
-- (event x lead time). The Edge Function finds rows where fire_at <= now()
-- and delivered_at is null, sends a push, and stamps delivered_at.
--   source: which Pawfolio list the reminder came from.
--   source_id: the __id of the originating record (bigint; Date.now()-based).
-- =====================================================================
create table if not exists public.pawfolio_reminders (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null references auth.users(id) on delete cascade,
  device_id       text not null,
  source          text not null check (source in ('vet-visit','medication','vaccination')),
  source_id       bigint not null,
  pet_name        text,
  title           text not null,
  body            text,
  fire_at         timestamptz not null,
  delivered_at    timestamptz,
  delivery_error  text,
  created_at      timestamptz not null default now()
);

create index if not exists pawfolio_reminders_due_idx
  on public.pawfolio_reminders (fire_at)
  where delivered_at is null;
create index if not exists pawfolio_reminders_user_idx on public.pawfolio_reminders(user_id);
create index if not exists pawfolio_reminders_device_idx on public.pawfolio_reminders(device_id);

create or replace function public.pawfolio_reminders_set_user_id() returns trigger
language plpgsql as $$
begin
  if new.user_id is null then
    new.user_id := auth.uid();
  end if;
  return new;
end$$;

drop trigger if exists pawfolio_reminders_set_user_id on public.pawfolio_reminders;
create trigger pawfolio_reminders_set_user_id
  before insert on public.pawfolio_reminders
  for each row execute function public.pawfolio_reminders_set_user_id();

alter table public.pawfolio_reminders enable row level security;

drop policy if exists pawfolio_reminders_owner_select on public.pawfolio_reminders;
create policy pawfolio_reminders_owner_select on public.pawfolio_reminders
  for select using (user_id = auth.uid());
drop policy if exists pawfolio_reminders_owner_insert on public.pawfolio_reminders;
create policy pawfolio_reminders_owner_insert on public.pawfolio_reminders
  for insert with check (user_id is null or user_id = auth.uid());
drop policy if exists pawfolio_reminders_owner_update on public.pawfolio_reminders;
create policy pawfolio_reminders_owner_update on public.pawfolio_reminders
  for update using (user_id = auth.uid());
drop policy if exists pawfolio_reminders_owner_delete on public.pawfolio_reminders;
create policy pawfolio_reminders_owner_delete on public.pawfolio_reminders
  for delete using (user_id = auth.uid());

-- The Edge Function uses the service-role key, which bypasses RLS, so no
-- additional policy is needed for the delivery worker.
