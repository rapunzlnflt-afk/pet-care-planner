-- =====================================================================
-- 0006 — The owner's missed-dose instruction, stored with the schedule so
-- the sitter page can show it. Text only: nothing here changes amounts or
-- timing. (Rolling "every N hours from the last dose" timing already exists
-- as anchor = 'from_last_dose' in 0003.)
-- =====================================================================

alter table public.pawfolio_dose_schedules
  add column if not exists missed_rule text,
  add column if not exists missed_note text;

alter table public.pawfolio_dose_schedules
  drop constraint if exists pawfolio_dose_schedules_missed_rule;
alter table public.pawfolio_dose_schedules
  add constraint pawfolio_dose_schedules_missed_rule check (
    (missed_rule is null or missed_rule in ('asap', 'skip', 'double', 'note')) and
    (missed_note is null or char_length(missed_note) <= 300)
  );

comment on column public.pawfolio_dose_schedules.missed_rule is
  'Owner instruction if a dose is missed: asap | skip | double | note (see missed_note). Display only.';
