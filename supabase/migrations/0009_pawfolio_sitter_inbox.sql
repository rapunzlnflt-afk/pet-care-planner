-- 0009_pawfolio_sitter_inbox.sql
--
-- Sitter inbox for Pawfolio Sitter mode (free) and "Send to a sitter"
-- (Pawfolio Free). Independent of the dose tables (0003..0008); changes none
-- of their rules or policies.
--
-- Design (sitter mode + intake send spec, section "Server"):
--   * Forms are encrypted on the client's phone with the sitter's public key
--     (P-256 ECDH + HKDF + AES-GCM, see intake-crypto.js). The server only
--     ever stores the envelope { v, z, epk, iv, ct } and cannot read it.
--   * A sitter inbox is identified by a random inbox id (public, rides in the
--     intake link's #fragment) and protected by an inbox secret that only the
--     sitter's phone knows. Only its sha256 is stored, so a leaked row does
--     not grant access.
--   * The sitter code (XXXX-XXXX, stored without the dash) lets a client who
--     has Pawfolio find the sitter's inbox id + public key.
--   * Nobody gets table access. RLS is on with NO policies; every call goes
--     through the pawfolio-sitter-inbox Edge Function (service role).
--   * Pending forms are deleted when the sitter acks them, and anything left
--     after 60 days is purged by the function.

-- =====================================================================
-- 1. Inboxes (one per sitter).
-- =====================================================================
create table if not exists public.pawfolio_sitter_inboxes (
  inbox        text primary key
               check (inbox ~ '^[A-Za-z0-9_-]{16,40}$'),
  -- sha256 hex of the inbox secret.
  token_hash   text not null
               check (token_hash ~ '^[0-9a-f]{64}$'),
  -- Raw P-256 public key, base64url (65 bytes -> 87 chars).
  public_key   text not null
               check (public_key ~ '^[A-Za-z0-9_-]{80,100}$'),
  -- Sitter code, 8 chars, no look-alikes. Shown as XXXX-XXXX.
  code         text not null unique
               check (code ~ '^[A-Z2-9]{8}$'),
  -- Business name shown to the client, e.g. "Happy Tails Pet Sitting".
  label        text check (label is null or char_length(label) <= 80),
  created_at   timestamptz not null default now(),
  last_seen_at timestamptz
);

alter table public.pawfolio_sitter_inboxes enable row level security;

-- =====================================================================
-- 2. Submissions (encrypted forms waiting for the sitter).
-- =====================================================================
create table if not exists public.pawfolio_sitter_submissions (
  id         uuid primary key default gen_random_uuid(),
  inbox      text not null
             references public.pawfolio_sitter_inboxes(inbox) on delete cascade,
  -- { v, z, epk, iv, ct }, all opaque to the server.
  envelope   jsonb not null
             check (jsonb_typeof(envelope) = 'object'
                    and octet_length(envelope::text) <= 4600000),
  -- Ciphertext length, so list can cap response size without loading rows.
  ct_len     integer generated always as (char_length(envelope->>'ct')) stored
             check (ct_len is not null and ct_len between 1 and 4500000),
  created_at timestamptz not null default now()
);

create index if not exists pawfolio_sitter_submissions_inbox_created_idx
  on public.pawfolio_sitter_submissions (inbox, created_at);

alter table public.pawfolio_sitter_submissions enable row level security;

-- No policies on purpose. Belt and braces: no direct grants either.
revoke all on table public.pawfolio_sitter_inboxes from anon, authenticated;
revoke all on table public.pawfolio_sitter_submissions from anon, authenticated;

comment on table public.pawfolio_sitter_inboxes is
  'Edge Function only (pawfolio-sitter-inbox): sitter inboxes for encrypted intake forms.';
comment on table public.pawfolio_sitter_submissions is
  'Edge Function only (pawfolio-sitter-inbox): encrypted intake forms waiting for the sitter.';
