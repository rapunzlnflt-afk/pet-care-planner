-- =====================================================================
-- 0005 — Undo a dose for a few minutes after Given or Skip.
--
-- pawfolio_undo_dose(event)            owner, through RLS (security invoker)
-- pawfolio_undo_dose_as_member(m, e)   sitter, server only; own doses only
--
-- Undo puts the dose back to pending and removes the next dose that logging
-- queued, so the schedule is exactly as it was before the tap. Allowed for
-- 5 minutes after the dose was recorded (logged_at, stamped in 0004).
-- The worker holds "Given by" follow-ups until that window has passed, so
-- an undone tap never reaches anyone else's phone.
-- =====================================================================

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
  'Within 5 minutes of Given/Skip, return the dose to pending and drop the next dose it queued.';

create or replace function public.pawfolio_undo_dose_as_member(p_member_id uuid, p_event_id uuid)
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

  -- A sitter can undo only a dose they recorded, on a medication still shared.
  select exists (
    select 1 from public.pawfolio_dose_events e
    join public.pawfolio_dose_schedules s on s.id = e.schedule_id
    where e.id = p_event_id and s.user_id = v_group.owner_user and s.shared
      and e.actor_member = v_member.id
  ) into v_ok;
  if not v_ok then
    raise exception 'not your dose' using errcode = 'insufficient_privilege';
  end if;

  return public.pawfolio_undo_dose(p_event_id);
end$$;

revoke all on function public.pawfolio_undo_dose_as_member(uuid, uuid) from public;
revoke all on function public.pawfolio_undo_dose_as_member(uuid, uuid) from anon, authenticated;

comment on function public.pawfolio_undo_dose_as_member(uuid, uuid) is
  'Sitter undo through the pawfolio-dose-share function. Own doses only. Not callable by clients.';
