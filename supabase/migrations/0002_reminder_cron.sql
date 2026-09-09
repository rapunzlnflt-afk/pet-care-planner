-- 0002_reminder_cron.sql
--
-- Schedules Pawfolio's Web Push delivery worker.
--
-- This assumes the shared MedRecords Supabase project (see 0001, which puts
-- Pawfolio's tables alongside MedRecords' in the same project). Enable the
-- `pg_cron` and `pg_net` extensions from Database -> Extensions, replace
-- <project-ref> with your project ref, and run this in the SQL editor.
--
-- cron.schedule() upserts by job name, so re-running this file is safe.
--
-- ---------------------------------------------------------------------------
-- Why odd minutes
-- ---------------------------------------------------------------------------
--
-- MedRecords' `send-reminders` job runs on the EVEN minutes (`*/2`). This job
-- runs on the ODD minutes so the two never fire together.
--
-- That matters because a small Supabase compute instance has very few
-- background worker slots (max_worker_processes = 6 on the smallest tiers).
-- Two pg_cron jobs starting in the same second can exhaust them, and pg_cron
-- then records the run as "job startup timeout" -- which looks like nothing at
-- all from the app's side, but means a push notification was silently never
-- sent.
--
-- Reminders fire on `fire_at <= now()`, so a 2-minute tick delays delivery
-- slightly but never drops a reminder.
--
-- ---------------------------------------------------------------------------
-- Why timeout_milliseconds is mandatory
-- ---------------------------------------------------------------------------
--
-- pg_net's background worker holds an open transaction while a request is in
-- flight. An open transaction stops autovacuum from reclaiming dead rows
-- ANYWHERE in the database. One Edge Function call that never returns is
-- enough to wedge the worker, after which the rows pg_net and pg_cron delete
-- from their own log tables are never actually freed.
--
-- Without this timeout, the shared project bloated to 370 MB against roughly
-- 1 MB of real data and tripped a Disk IO Budget warning. Individual job runs
-- were also taking ~10 seconds, because the unbounded HTTP call was blocking.

select cron.schedule(
  'send-pet-reminders-every-minute',
  '1-59/2 * * * *',
  $job$
  select net.http_post(
    url := 'https://<project-ref>.supabase.co/functions/v1/send-pet-reminders',
    headers := jsonb_build_object('Content-Type', 'application/json'),
    body := '{}'::jsonb,
    timeout_milliseconds := 10000
  );
  $job$
);

-- The job name is kept as 'send-pet-reminders-every-minute' for continuity
-- with deployments created before this migration existed. The schedule above
-- is the source of truth, not the name.

-- ---------------------------------------------------------------------------
-- Log retention lives with MedRecords
-- ---------------------------------------------------------------------------
--
-- `cron.job_run_details` and `net._http_response` are project-wide, not
-- per-app, so the retention jobs are defined once in the MedRecords repo:
--
--   medical-records-keeper/supabase/migrations/
--     0003_reminder_cron_and_maintenance.sql
--
-- That file schedules `purge-cron-history` (daily) and `db-maintenance`
-- (every 15 minutes, which also restarts a wedged pg_net worker). Run it too
-- if you are setting up a fresh project -- otherwise these logs grow without
-- bound and the Disk IO warning comes back.

-- ---------------------------------------------------------------------------
-- Verify
-- ---------------------------------------------------------------------------
--
--   select jobid, jobname, schedule, active from cron.job order by jobid;
--
-- Expect send-reminders on '*/2 * * * *' and send-pet-reminders on
-- '1-59/2 * * * *'.
--
--   select jobid, status, count(*),
--          round(avg(extract(epoch from end_time - start_time))::numeric, 2) as avg_secs
--   from cron.job_run_details
--   where start_time > now() - interval '15 minutes'
--   group by 1, 2;
--
-- Expect no rows with status = 'failed', and avg_secs in the hundredths.
-- Multi-second runs mean the HTTP call is blocking and the timeout is missing.
