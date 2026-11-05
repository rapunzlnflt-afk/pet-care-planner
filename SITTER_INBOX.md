# Sitter inbox backend

Server side of Pawfolio Sitter mode (free) and "Send to a sitter" (Pawfolio Free).
Clients encrypt an intake form on their phone with the sitter's public key
(`intake-crypto.js`, shared with the sitter intake web form). The server only
stores the encrypted envelope `{ v, z, epk, iv, ct }` until the sitter's phone
picks it up, and it can't read it.

| File | Purpose |
|------|---------|
| `supabase/migrations/0009_pawfolio_sitter_inbox.sql` | `pawfolio_sitter_inboxes`, `pawfolio_sitter_submissions`. RLS on, no policies. |
| `supabase/functions/pawfolio-sitter-inbox/index.ts` | The only way in: `register`, `lookup`, `submit`, `list`, `ack`. |
| `supabase/tests/pawfolio-sitter-inbox/` | Local contract test (no live project). |

## Actions (POST JSON)

| Action | Body | Reply |
|--------|------|-------|
| `register` | `{inbox, token_hash, public_key, code, label}` | `{ok, code}`; 403 `forbidden` if the inbox exists with another secret; 409 `code_taken` |
| `lookup` | `{code}` (dash optional) | `{inbox, public_key, label}`; 404 `not_found` |
| `submit` | `{inbox, envelope}` | `{ok, id}`; 404 `not_found`, 400 `bad_envelope`, 413 `too_large` (ct over 4,500,000 chars), 429 `inbox_full` (200 waiting) |
| `list` | `{inbox, token}` | `{items:[{id, created_at, envelope}], more}` oldest first, at most 50 and about 12M ciphertext chars per call; 403 `forbidden`. Purges that inbox's forms older than 60 days and sets `last_seen_at`. |
| `ack` | `{inbox, token, ids}` (up to 50 uuids) | `{ok, deleted}`; 403 `forbidden`, 400 `bad_request` |

Errors are always `{error}` with a matching status. When `more` is true, the
sitter app should ack what it saved and call `list` again.

## Deploy

Not deployed by this PR. When ready:

1. Apply the migration (SQL editor, or `supabase db push`). It is idempotent.
2. `supabase functions deploy pawfolio-sitter-inbox --no-verify-jwt`
   (token-checked inside; there is no user JWT on a sitter's or client's phone).
   `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are provided by Supabase.
3. Smoke test: `curl -X POST <project>/functions/v1/pawfolio-sitter-inbox -d '{"action":"lookup","code":"ZZZZ-ZZZZ"}'`
   should return 404 `{"error":"not_found"}`.

## Local test

```
INTAKE_CRYPTO=/path/to/intake-crypto.js MOCK=/path/to/mock_server.py \
  supabase/tests/pawfolio-sitter-inbox/run.sh
```

Runs the real `index.ts` under Deno against Postgres in WASM (PGlite, with
migration 0009 applied) and drives it with `intake-crypto.js` under Node:
register, lookup by code, submit an encrypted form, list, decrypt, ack, plus
every limit and error. With `MOCK` set, the same test runs against the
in-memory mock used by the app builds, so the two stay in step.
