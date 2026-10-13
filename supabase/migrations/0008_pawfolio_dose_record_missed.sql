-- =====================================================================
-- 0008 — Record a missed dose as given, after the fact.
--
-- pawfolio_record_missed_dose(event, at, label, force)        owner, RLS (security invoker)
-- pawfolio_record_missed_dose_as_member(m, e, at, force)      sitter, server only
--
-- For someone who gave a dose but forgot to tap Given before the 90-minute
-- grace time ran out, so the dose was marked missed ("wasn't recorded").
-- Allowed only on the latest recorded dose of a medication (nothing given or
-- skipped after it), for 24 hours after it was due. The time given cannot be
-- in the future, more than 24 hours ago, at/before the previous given dose,
-- or more than 90 minutes before the dose was due (the earliest Given opens).
--
-- Once recorded it behaves like any other given dose: Undo for 5 minutes
-- (back to missed, see the new undo below), Change time for 30 minutes, the
-- double-dose check, and a "Given by" notice for shared medications.
-- Rolling ("every N hours") schedules move the next dose to match when the
-- new time still lies ahead; set times stay put.
-- =====================================================================

alter table public.pawfolio_dose_events
  add column if not exists recorded_late boolean not null default false;

comment on column public.pawfolio_dose_events.recorded_late is
  'True when a missed dose was later recorded as given; Undo returns it to missed.';

create or replace function public.pawfolio_record_missed_dose(
  p_event_id    uuid,
  p_taken_at    timestamptz,
  p_actor_label text default null,
  p_force       boolean default false
) returns jsonb
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_event    public.pawfolio_dose_events;
  v_schedule public.pawfolio_dose_schedules;
  v_prev     timestamptz;
  v_pending  public.pawfolio_dose_events;
  v_next     timestamptz;
  v_next_id  uuid;
begin
  select * into v_event
  from public.pawfolio_dose_events
  where id = p_event_id
  for update;

  if not found then
    raise exception 'dose event % not found', p_event_id using errcode = 'no_data_found';
  end if;

  if v_event.status <> 'missed' then
    return jsonb_build_object('outcome', 'not_missed', 'event_id', v_event.id,
                              'status', v_event.status, 'taken_at', v_event.taken_at);
  end if;

  if v_event.due_at < now() - interval '24 hours' then
    return jsonb_build_object('outcome', 'too_late', 'event_id', v_event.id);
  end if;

  -- Only the latest recorded dose: once a later one is given or skipped, the
  -- schedule has moved on from this one.
  if exists (
    select 1 from public.pawfolio_dose_events
    where schedule_id = v_event.schedule_id and id <> v_event.id
      and status in ('taken', 'skipped', 'missed') and due_at > v_event.due_at
  ) then
    return jsonb_build_object('outcome', 'not_latest', 'event_id', v_event.id);
  end if;

  if p_taken_at is null or p_taken_at > now() + interval '2 minutes' then
    return jsonb_build_object('outcome', 'bad_time', 'reason', 'future', 'event_id', v_event.id);
  end if;
  if p_taken_at < now() - interval '24 hours' then
    return jsonb_build_object('outcome', 'bad_time', 'reason', 'too_old', 'event_id', v_event.id);
  end if;
  if p_taken_at < v_event.due_at - interval '90 minutes' then
    return jsonb_build_object('outcome', 'bad_time', 'reason', 'before_due', 'due_at', v_event.due_at, 'event_id', v_event.id);
  end if;

  select * into v_schedule from public.pawfolio_dose_schedules where id = v_event.schedule_id;

  select max(taken_at) into v_prev
  from public.pawfolio_dose_events
  where schedule_id = v_event.schedule_id and status = 'taken' and id <> v_event.id;
  if v_prev is not null and p_taken_at <= v_prev then
    return jsonb_build_object('outcome', 'bad_time', 'reason', 'before_previous',
                              'previous_taken_at', v_prev, 'event_id', v_event.id);
  end if;
  -- Same double-dose check as logging, overridable once the user has seen it.
  if not p_force and v_prev is not null
     and p_taken_at - v_prev < make_interval(mins => greatest(v_schedule.interval_min / 2, 1)) then
    return jsonb_build_object('outcome', 'too_soon', 'event_id', v_event.id, 'last_taken_at', v_prev,
                              'minutes_ago', floor(extract(epoch from (p_taken_at - v_prev)) / 60)::int);
  end if;

  update public.pawfolio_dose_events
  set status           = 'taken',
      taken_at         = p_taken_at,
      logged_at        = now(),
      recorded_late    = true,
      actor_label      = coalesce(p_actor_label, actor_label),
      followup_sent_at = null
  where id = v_event.id and status = 'missed'
  returning * into v_event;

  if not found then
    select * into v_event from public.pawfolio_dose_events where id = p_event_id;
    return jsonb_build_object('outcome', 'not_missed', 'event_id', v_event.id,
                              'status', v_event.status, 'taken_at', v_event.taken_at);
  end if;

  -- Rolling schedules count the next dose from the real time it was given,
  -- as long as that is still ahead. Set times are left alone.
  select * into v_pending from public.pawfolio_dose_events
  where schedule_id = v_event.schedule_id and status = 'pending'
  for update;

  if v_schedule.enabled and v_schedule.anchor = 'from_last_dose' then
    v_next := public.pawfolio_dose_next_due(v_schedule, p_taken_at);
  end if;

  if v_pending.id is not null and v_next is not null and v_next > now() and v_pending.due_at <> v_next then
    delete from public.pawfolio_dose_events where id = v_pending.id;
    insert into public.pawfolio_dose_events (schedule_id, due_at)
    values (v_schedule.id, v_next)
    on conflict (schedule_id) where status = 'pending' do nothing
    returning id into v_next_id;
  else
    v_next_id := v_pending.id;
    v_next := v_pending.due_at;
  end if;

  return jsonb_build_object(
    'outcome', 'recorded', 'event_id', v_event.id, 'status', v_event.status, 'taken_at', v_event.taken_at,
    'next_event_id', v_next_id, 'next_due_at', v_next
  );
end$$;

comment on function public.pawfolio_record_missed_dose(uuid, timestamptz, text, boolean) is
  'Within 24 hours, record the latest missed dose as given at the time it was actually given.';

create or replace function public.pawfolio_record_missed_dose_as_member(
  p_member_id uuid,
  p_event_id  uuid,
  p_taken_at  timestamptz,
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

  -- A missed dose belongs to nobody yet, so any sitter on a shared medication may record it.
  select exists (
    select 1 from public.pawfolio_dose_events e
    join public.pawfolio_dose_schedules s on s.id = e.schedule_id
    where e.id = p_event_id and s.user_id = v_group.owner_user and s.shared
  ) into v_ok;
  if not v_ok then
    raise exception 'dose not shared' using errcode = 'insufficient_privilege';
  end if;

  v_res := public.pawfolio_record_missed_dose(p_event_id, p_taken_at, v_member.label, p_force);

  if v_res->>'outcome' = 'recorded' then
    update public.pawfolio_dose_events set actor_member = v_member.id where id = p_event_id;
  end if;

  return v_res;
end$$;

revoke all on function public.pawfolio_record_missed_dose_as_member(uuid, uuid, timestamptz, boolean) from public;
revoke all on function public.pawfolio_record_missed_dose_as_member(uuid, uuid, timestamptz, boolean) from anon, authenticated;
grant execute on function public.pawfolio_record_missed_dose_as_member(uuid, uuid, timestamptz, boolean) to service_role;

comment on function public.pawfolio_record_missed_dose_as_member(uuid, uuid, timestamptz, boolean) is
  'Sitter late recording through the pawfolio-dose-share function. Not callable by clients.';

-- ---------------------------------------------------------------------
-- Undo: a late-recorded dose goes back to missed (not pending, which the
-- sweep would only mark missed again), and the next dose stays queued.
-- Otherwise unchanged from 0005.
-- ---------------------------------------------------------------------
create or replace function public.pawfolio_undo_dose(p_event_id uuid)
returns jsonb
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_event public.pawfolio_dose_events;
begin
  select * into v_event
  from public.pawfolio_dose_events
  where id = p_event_id
  for update;

  if not found then
    raise exception 'dose event % not found', p_event_id
      using errcode = 'no_data_found';
  end if;

  if v_event.status not in ('taken', 'skipped') then
    return jsonb_build_object('outcome', 'not_undoable', 'event_id', v_event.id, 'status', v_event.status);
  end if;

  if v_event.logged_at is null or v_event.logged_at < now() - interval '5 minutes' then
    return jsonb_build_object('outcome', 'too_late', 'event_id', v_event.id);
  end if;

  if v_event.recorded_late then
    update public.pawfolio_dose_events
    set status           = 'missed',
        taken_at         = null,
        actor_label      = null,
        actor_member     = null,
        logged_at        = null,
        followup_sent_at = null,
        recorded_late    = false
    where id = v_event.id
    returning * into v_event;
    return jsonb_build_object('outcome', 'undone', 'event_id', v_event.id, 'due_at', v_event.due_at);
  end if;

  -- The next dose queued by this log. Only one pending dose exists per
  -- schedule, so this is it; its reminder rows go with it (on delete cascade).
  delete from public.pawfolio_dose_events
  where schedule_id = v_event.schedule_id
    and status = 'pending'
    and id <> v_event.id;

  update public.pawfolio_dose_events
  set status           = 'pending',
      taken_at         = null,
      actor_label      = null,
      actor_member     = null,
      logged_at        = null,
      followup_sent_at = null
  where id = v_event.id
  returning * into v_event;

  return jsonb_build_object('outcome', 'undone', 'event_id', v_event.id, 'due_at', v_event.due_at);
end$$;

comment on function public.pawfolio_undo_dose(uuid) is
  'Within 5 minutes of Given/Skip, return the dose to pending (or to missed, if it was recorded late) and drop the next dose it queued.';
