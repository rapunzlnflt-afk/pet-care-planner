-- 0010_pawfolio_sitter_inbox_limits.sql
--
-- Rate limits and a strict 100-form cap for the sitter inbox (0009).
-- Changes nothing in 0009's tables or in the dose tables (0003..0008).
--
--   * pawfolio_sitter_rate: hit counters in fixed time windows, keyed by a
--     bucket such as "lookup:ip:<hash>" or "submit:inbox:<inbox>". IPs are
--     stored only as a truncated sha256, and rows are deleted after 2 days.
--   * pawfolio_sitter_rate_hit(bucket, window_secs, limit): counts one hit and
--     returns true while the bucket is within its limit. Atomic, so parallel
--     requests on different Edge Function instances can't slip past it.
--   * A trigger makes the 100-waiting-forms cap strict. The function's own
--     count-then-insert could overshoot when two forms arrived together.
--
-- Same rules as 0009: RLS on with no policies, no grants to anon or
-- authenticated. Only the pawfolio-sitter-inbox Edge Function (service role)
-- uses any of this. No pg_cron job (see 0002 for why cron jobs are kept few).

-- =====================================================================
-- 1. Rate counters.
-- =====================================================================
create table if not exists public.pawfolio_sitter_rate (
  bucket       text not null check (char_length(bucket) <= 120),
  window_start timestamptz not null,
  hits         integer not null default 0,
  primary key (bucket, window_start)
);

create index if not exists pawfolio_sitter_rate_window_idx
  on public.pawfolio_sitter_rate (window_start);

alter table public.pawfolio_sitter_rate enable row level security;
revoke all on table public.pawfolio_sitter_rate from anon, authenticated;

comment on table public.pawfolio_sitter_rate is
  'Edge Function only (pawfolio-sitter-inbox): rate-limit counters. IPs are hashed; rows older than 2 days are removed.';

create or replace function public.pawfolio_sitter_rate_hit(
  p_bucket text, p_window_secs integer, p_limit integer
) returns boolean
language plpgsql
set search_path = ''
as $$
declare
  w timestamptz;
  n integer;
begin
  if p_window_secs is null or p_window_secs < 1 or p_limit is null or p_limit < 1 then
    raise exception 'bad rate args';
  end if;
  w := to_timestamp(floor(extract(epoch from now()) / p_window_secs) * p_window_secs);
  insert into public.pawfolio_sitter_rate as r (bucket, window_start, hits)
  values (p_bucket, w, 1)
  on conflict (bucket, window_start) do update set hits = r.hits + 1
  returning hits into n;
  -- Housekeeping without a cron job: about 1 call in 100 clears old windows.
  if random() < 0.01 then
    delete from public.pawfolio_sitter_rate where window_start < now() - interval '2 days';
  end if;
  return n <= p_limit;
end;
$$;

revoke all on function public.pawfolio_sitter_rate_hit(text, integer, integer) from public, anon, authenticated;
grant execute on function public.pawfolio_sitter_rate_hit(text, integer, integer) to service_role;

-- =====================================================================
-- 2. Strict cap: at most 100 forms waiting per inbox.
-- =====================================================================
create or replace function public.pawfolio_sitter_submissions_cap()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  n integer;
begin
  -- Lock the inbox row so submits to the same inbox take turns here.
  perform 1 from public.pawfolio_sitter_inboxes where inbox = new.inbox for update;
  select count(*) into n from public.pawfolio_sitter_submissions where inbox = new.inbox;
  if n >= 100 then
    raise exception 'inbox_full' using errcode = 'P0001';
  end if;
  return new;
end;
$$;

revoke all on function public.pawfolio_sitter_submissions_cap() from public, anon, authenticated;

drop trigger if exists pawfolio_sitter_submissions_cap on public.pawfolio_sitter_submissions;
create trigger pawfolio_sitter_submissions_cap
  before insert on public.pawfolio_sitter_submissions
  for each row execute function public.pawfolio_sitter_submissions_cap();
