-- =====================================================================
-- 0007 — Change the time a dose was given.
--
-- pawfolio_set_dose_time(event, at)            owner, through RLS (security invoker)
-- pawfolio_set_dose_time_as_member(m, e, at)   sitter, server only; own doses only
--
-- For someone who taps Given late. Allowed only on the latest given dose of a
-- medication, for 30 minutes after it was recorded (logged_at). The new time
-- cannot be in the future, more than 12 hours ago, or at/before the previous
-- given dose. The next dose is worked out again from the corrected time the
-- same way logging does it: rolling ("every N hours") schedules move; set
-- times usually stay put.
-- =====================================================================

create or replace function public.pawfolio_set_dose_time(p_event_id uuid, p_taken_at timestamptz)
returns jsonb
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

  if v_event.status <> 'taken' then
    return jsonb_build_object('outcome', 'not_given', 'event_id', v_event.id, 'status', v_event.status);
  end if;

  if v_event.logged_at is null or v_event.logged_at < now() - interval '30 minutes' then
    return jsonb_build_object('outcome', 'too_late', 'event_id', v_event.id);
  end if;

  -- Only the latest recorded dose: once a later one is given or skipped, the
  -- schedule has moved on from this one.
  if exists (
    select 1 from public.pawfolio_dose_events
    where schedule_id = v_event.schedule_id and id <> v_event.id
      and status in ('taken', 'skipped') and due_at > v_event.due_at
  ) then
    return jsonb_build_object('outcome', 'not_latest', 'event_id', v_event.id);
  end if;

  if p_taken_at is null or p_taken_at > now() + interval '2 minutes' then
    return jsonb_build_object('outcome', 'bad_time', 'reason', 'future', 'event_id', v_event.id);
  end if;
  if p_taken_at < now() - interval '12 hours' then
    return jsonb_build_object('outcome', 'bad_time', 'reason', 'too_old', 'event_id', v_event.id);
  end if;

  select max(taken_at) into v_prev
  from public.pawfolio_dose_events
  where schedule_id = v_event.schedule_id and status = 'taken' and id <> v_event.id;
  if v_prev is not null and p_taken_at <= v_prev then
    return jsonb_build_object('outcome', 'bad_time', 'reason', 'before_previous',
                              'previous_taken_at', v_prev, 'event_id', v_event.id);
  end if;

  update public.pawfolio_dose_events
  set taken_at = p_taken_at
  where id = v_event.id
  returning * into v_event;

  -- Work out the next dose again, exactly as pawfolio_log_dose() would have.
  select * into v_schedule from public.pawfolio_dose_schedules where id = v_event.schedule_id;
  select * into v_pending from public.pawfolio_dose_events
  where schedule_id = v_event.schedule_id and status = 'pending'
  for update;

  if v_schedule.enabled then
    v_next := public.pawfolio_dose_next_due(
      v_schedule,
      case when v_schedule.anchor = 'from_last_dose' then p_taken_at
           else greatest(p_taken_at, v_event.due_at) end
    );
  end if;

  if v_pending.id is not null and v_next is not null and v_pending.due_at <> v_next then
    -- Replace rather than move it, so reminders queued for the old time go
    -- with it (on delete cascade) and new ones are made for the new time.
    delete from public.pawfolio_dose_events where id = v_pending.id;
    insert into public.pawfolio_dose_events (schedule_id, due_at)
    values (v_schedule.id, v_next)
    on conflict (schedule_id) where status = 'pending' do nothing
    returning id into v_next_id;
  else
    v_next_id := v_pending.id;
    v_next := coalesce(v_pending.due_at, v_next);
  end if;

  return jsonb_build_object(
    'outcome', 'changed', 'event_id', v_event.id, 'taken_at', v_event.taken_at,
    'next_event_id', v_next_id, 'next_due_at', v_next
  );
end$$;

comment on function public.pawfolio_set_dose_time(uuid, timestamptz) is
  'Within 30 minutes of recording, correct when the latest given dose was given, and re-plan the next dose.';

create or replace function public.pawfolio_set_dose_time_as_member(p_member_id uuid, p_event_id uuid, p_taken_at timestamptz)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_member public.pawfolio_dose_members;
  v_group  public.pawfolio_dose_groups;
  v_ok     boolean;
begin
  select * into v_member from public.pawfolio_dose_members where id = p_member_id;
  if not found or v_member.removed_at is not null then
    raise exception 'not a member' using errcode = 'insufficient_privilege';
  end if;

  select * into v_group from public.pawfolio_dose_groups where id = v_member.group_id;
  if not found or v_group.revoked_at is not null or v_group.expires_at < now() then
    raise exception 'link no longer active' using errcode = 'insufficient_privilege';
  end if;

  -- A sitter can change only a dose they recorded, on a medication still shared.
  select exists (
    select 1 from public.pawfolio_dose_events e
    join public.pawfolio_dose_schedules s on s.id = e.schedule_id
    where e.id = p_event_id and s.user_id = v_group.owner_user and s.shared
      and e.actor_member = v_member.id
  ) into v_ok;
  if not v_ok then
    raise exception 'not your dose' using errcode = 'insufficient_privilege';
  end if;

  return public.pawfolio_set_dose_time(p_event_id, p_taken_at);
end$$;

revoke all on function public.pawfolio_set_dose_time_as_member(uuid, uuid, timestamptz) from public;
revoke all on function public.pawfolio_set_dose_time_as_member(uuid, uuid, timestamptz) from anon, authenticated;
grant execute on function public.pawfolio_set_dose_time_as_member(uuid, uuid, timestamptz) to service_role;

comment on function public.pawfolio_set_dose_time_as_member(uuid, uuid, timestamptz) is
  'Sitter time correction through the pawfolio-dose-share function. Own doses only. Not callable by clients.';
