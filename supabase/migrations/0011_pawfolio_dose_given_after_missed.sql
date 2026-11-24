-- =====================================================================
-- 0011 — Given on a dose that has just been marked missed.
--
-- Doses not recorded within the grace time (90 minutes after due) are
-- marked missed by the sweep. A screen opened earlier — the app, the
-- due-doses popup, a reminder's confirm screen or the sitter page — can
-- still show Given for that dose. Until now the tap was refused as
-- 'already_logged' (status 'missed'), the app said "already recorded"
-- and nothing was saved.
--
-- Now a Given tap on a missed dose records it as given at the tap time,
-- exactly as "It was given — record the time" would
-- (pawfolio_record_missed_dose): latest dose only, within 24 hours of
-- due, double-dose check, Undo back to missed, rolling next dose moved.
-- It returns outcome 'logged' (plus recorded_late) so every caller,
-- including pawfolio_log_dose_as_member for sitters, treats it as a
-- normal Given.
--
-- Skip on a missed dose is unchanged: it stays missed.
-- Otherwise unchanged from 0003.
-- =====================================================================

create or replace function public.pawfolio_log_dose(
  p_event_id    uuid,
  p_taken       boolean,
  p_at          timestamptz default null,
  p_actor_label text default null,
  p_note        text default null,
  p_force       boolean default false
) returns jsonb
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_event    public.pawfolio_dose_events;
  v_schedule public.pawfolio_dose_schedules;
  v_at       timestamptz := coalesce(p_at, now());
  v_last     timestamptz;
  v_next     timestamptz;
  v_next_id  uuid;
  v_late     jsonb;
begin
  -- Row lock so a double-tap cannot interleave between the read and the write.
  select * into v_event
  from public.pawfolio_dose_events
  where id = p_event_id
  for update;

  if not found then
    raise exception 'dose event % not found', p_event_id
      using errcode = 'no_data_found';
  end if;

  select * into v_schedule
  from public.pawfolio_dose_schedules
  where id = v_event.schedule_id;

  if not found then
    raise exception 'dose schedule for event % not found', p_event_id
      using errcode = 'no_data_found';
  end if;

  -- 0011: the dose went missed while Given was still on screen. Record it
  -- as given now, through the same rules as recording a missed dose.
  if p_taken and v_event.status = 'missed' then
    v_late := public.pawfolio_record_missed_dose(p_event_id, v_at, p_actor_label, p_force);
    if v_late->>'outcome' = 'recorded' then
      return jsonb_build_object(
        'outcome',       'logged',
        'recorded_late', true,
        'event_id',      v_late->'event_id',
        'status',        v_late->'status',
        'taken_at',      v_late->'taken_at',
        'next_event_id', v_late->'next_event_id',
        'next_due_at',   v_late->'next_due_at'
      );
    end if;
    if v_late->>'outcome' = 'too_soon' then
      return v_late;  -- caller asks, then repeats with p_force
    end if;
    -- Too late, not the latest dose, or a bad time: report it as missed.
    select * into v_event from public.pawfolio_dose_events where id = p_event_id;
    return jsonb_build_object(
      'outcome',     'already_logged',
      'event_id',    v_event.id,
      'status',      v_event.status,
      'taken_at',    v_event.taken_at,
      'actor_label', v_event.actor_label,
      'reason',      v_late->>'outcome'
    );
  end if;

  -- Already resolved. Not an error: the caller shows "already given at ...".
  if v_event.status <> 'pending' then
    return jsonb_build_object(
      'outcome',     'already_logged',
      'event_id',    v_event.id,
      'status',      v_event.status,
      'taken_at',    v_event.taken_at,
      'actor_label', v_event.actor_label
    );
  end if;

  -- A manual time may be corrected backwards but not invented. Small future
  -- slack absorbs clock skew between phone and server.
  if v_at > now() + interval '2 minutes' then
    raise exception 'dose time cannot be in the future'
      using errcode = 'invalid_parameter_value';
  end if;
  if v_at < now() - interval '12 hours' then
    raise exception 'dose time is more than 12 hours ago'
      using errcode = 'invalid_parameter_value';
  end if;

  -- Double-dose guard: only for an actual dose, and overridable after the
  -- caller has shown the user when the previous one was given.
  if p_taken and not p_force then
    select max(taken_at) into v_last
    from public.pawfolio_dose_events
    where schedule_id = v_event.schedule_id and status = 'taken';

    if v_last is not null
       and v_at - v_last < make_interval(mins => greatest(v_schedule.interval_min / 2, 1)) then
      return jsonb_build_object(
        'outcome',        'too_soon',
        'event_id',       v_event.id,
        'last_taken_at',  v_last,
        'minutes_ago',    floor(extract(epoch from (v_at - v_last)) / 60)::int
      );
    end if;
  end if;

  update public.pawfolio_dose_events
  set status      = case when p_taken then 'taken' else 'skipped' end,
      taken_at    = case when p_taken then v_at else null end,
      actor_label = coalesce(p_actor_label, actor_label),
      note        = coalesce(p_note, note)
  where id = v_event.id and status = 'pending'
  returning * into v_event;

  if not found then
    -- Lost the race despite the lock (another transaction committed first).
    select * into v_event from public.pawfolio_dose_events where id = p_event_id;
    return jsonb_build_object(
      'outcome',     'already_logged',
      'event_id',    v_event.id,
      'status',      v_event.status,
      'taken_at',    v_event.taken_at,
      'actor_label', v_event.actor_label
    );
  end if;

  -- Schedule the next dose. A taken dose anchors the next one to the ACTUAL
  -- time; a skip anchors to the original due time, so skipping does not
  -- stretch the day's spacing.
  if v_schedule.enabled then
    v_next := public.pawfolio_dose_next_due(
      v_schedule,
      -- Fixed times count from whichever is later, the due time or the
      -- actual time: a 6:00 dose given at 5:50 must not queue 6:00 again.
      case
        when p_taken and v_schedule.anchor = 'from_last_dose' then v_at
        when p_taken then greatest(v_at, v_event.due_at)
        else v_event.due_at
      end
    );

    if v_next is not null then
      insert into public.pawfolio_dose_events (schedule_id, due_at)
      values (v_schedule.id, v_next)
      on conflict (schedule_id) where status = 'pending'
      do nothing
      returning id into v_next_id;
    end if;
  end if;

  return jsonb_build_object(
    'outcome',       'logged',
    'event_id',      v_event.id,
    'status',        v_event.status,
    'taken_at',      v_event.taken_at,
    'next_event_id', v_next_id,
    'next_due_at',   v_next
  );
end$$;

comment on function public.pawfolio_log_dose(uuid, boolean, timestamptz, text, text, boolean) is
  'Record a dose as taken or skipped and queue the next one in the same transaction. Given on a just-missed dose records it late (0011).';
