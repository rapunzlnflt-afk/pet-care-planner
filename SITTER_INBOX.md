# Sitter inbox backend

Server side of Pawfolio Sitter mode (free) and "Send to a sitter" (Pawfolio Free).
Clients encrypt an intake form on their phone with the sitter's public key
(`intake-crypto.js`, shared with the sitter intake web form). The server only
stores the encrypted envelope `{ v, z, epk, iv, ct }` until the sitter's phone
picks it up, and it can't read it.

| File | Purpose |
|------|---------|
| `supabase/migrations/0009_pawfolio_sitter_inbox.sql` | `pawfolio_sitter_inboxes`, `pawfolio_sitter_submissions`. RLS on, no policies. |
| `supabase/migrations/0010_pawfolio_sitter_inbox_limits.sql` | Rate-limit counters (`pawfolio_sitter_rate`, `pawfolio_sitter_rate_hit`) and a trigger that makes the 100-form cap strict. RLS on, no policies. |
| `supabase/functions/pawfolio-sitter-inbox/index.ts` | The only way in: `register`, `lookup`, `submit`, `list`, `ack`. |
| `supabase/tests/pawfolio-sitter-inbox/` | Local contract test (no live project). |

## Actions (POST JSON)

| Action | Body | Reply |
|--------|------|-------|
| `register` | `{inbox, token_hash, public_key, code, label}` | `{ok, code}`; 403 `forbidden` if the inbox exists with another secret; 409 `code_taken` |
| `lookup` | `{code}` (dash optional) | `{inbox, public_key, label}`; 404 `not_found` |
| `submit` | `{inbox, envelope}` | `{ok, id}`; 404 `not_found`, 400 `bad_envelope`, 413 `too_large` (ct over 1,500,000 chars), 429 `inbox_full` (100 waiting) |
| `list` | `{inbox, token}` | `{items:[{id, created_at, envelope}], more}` oldest first, at most 50 and about 12M ciphertext chars per call; 403 `forbidden`. Purges that inbox's forms older than 60 days and sets `last_seen_at`. |
| `ack` | `{inbox, token, ids}` (up to 50 uuids) | `{ok, deleted}`; 403 `forbidden`, 400 `bad_request` |

Errors are always `{error}` with a matching status. When `more` is true, the
sitter app should ack what it saved and call `list` again.

## Rate limits (v3.43.3, migration 0010)

`register`, `lookup` and `submit` need no secret, so they are limited. Over a
limit the reply is 429 `{error: "rate_limited"}` with a `Retry-After` header
(seconds). A full inbox is still 429 `inbox_full`; clients check the code.

| Action | Per connection (hashed IP) | Per inbox |
|--------|---------------------------|-----------|
| `register` | 10 an hour | |
| `lookup` | 30 per 10 minutes, 200 a day (malformed codes count too); 2,000 an hour for everyone together | |
| `submit` | 20 an hour, 60 a day | 30 an hour |
| `list`, `ack` | not limited (need the inbox secret) | |

- The IP comes from `cf-connecting-ip` (set by Cloudflare, can't be faked), else the first `x-forwarded-for` entry, and is stored only as a 32-character
  sha256 prefix. Counter rows are removed after 2 days (by the rate function
  itself, no cron job). A request with no IP skips the per-IP limits.
- If the counter call fails, the request goes through, so a database hiccup
  never blocks real users.
- The 100-waiting-forms cap is enforced by a trigger that locks the inbox row,
  so two forms at the same moment can't overshoot it.

## Deploy

Not deployed by this PR. When ready:

1. Apply the migrations 0009 and 0010 in order (SQL editor, or `supabase db push`). Both are idempotent.
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
migrations 0009 and 0010 applied) and drives it with `intake-crypto.js` under Node:
register, lookup by code, submit an encrypted form, list, decrypt, ack, plus
every limit and error. With `MOCK` set, the same test runs against the
in-memory mock used by the app builds, so the two stay in step.

## Follow-ups

- Rate limiting and the strict 100-form cap: done in v3.43.3 (see above).
- Inboxes that are never used again are kept forever. Removing old ones would
  also break that sitter's printed cards and saved links, so it is left alone
  for now; an inbox row is tiny.

## Live dose link (v3.41.0)

No server change. A form sent from Pawfolio can carry an optional `doseShare: { url, pets }`
inside the encrypted payload, so the server never sees it.

- Client side (Send to a sitter): included only when the client has Pawfolio Complete, Dose
  reminders are on, this phone holds the live dose link (`pawfolioDoseShare` = `{ groupId, token }`,
  made by "Share doses with a sitter"), the group is still active (`pawfolio_dose_groups` with
  `revoked_at is null`, read-only check) and at least one selected pet has a shared medication.
  `pets` lists those selected pets. Review shows "Live dose sharing: Bella" with a box (default on;
  unticking is remembered per sitter as `doseShareOff` and also applies to Send update). Complete
  with no link for these pets: a "Set up dose sharing" link to the existing card. Pawfolio Free: nothing.
  Nothing ever creates, renews or revokes a dose link from here.
- Dose links are one per owner account (one active `pawfolio_dose_groups` row). The link covers every
  medication switched on in "Share doses with a sitter", for any pet, and any number of sitter
  phones can join it. The token exists only on the phone that made the link (the server keeps a hash),
  so a link made on another phone cannot be sent from this one. If the selected pets are a subset,
  review says the same link also shows doses for the other pets.
- Sitter side: a `doseShare` is kept only for `source: "pawfolio"` and only if the URL is a
  `/doses.html#t=<token>` link on https://cleartrackapps.com or the sitter app's own origin.
  The latest version of the card then shows "Today's doses" (opens the link in a new tab) and
  "Shares live doses: Bella"; the Clients list shows a "Doses" badge. A later form without the field
  (revoked, unticked, downgraded to Pawfolio Free) hides both. Older app versions ignore the field.

## Addresses and directions (v3.41.0)

No server change.

- Pet Sitter Info has a "Home address" field (`sitter-owner-address`, after Email). It is saved in
  `petSitterInfo` (so backups include it), printed on the sitter sheet only when filled in, and sent
  in the shared sitter sheet as `owner.address`. sitter.html shows it as a Home Address map link;
  older links without the field show nothing extra.
- Send to a sitter prefills `client.address` from it. A saved Send-form extra still wins, unless
  that extra is empty, in which case the Pet Sitter Info value is used.
- Sitter mode Clients list shows the client's address on one muted line (ellipsis), and search also
  matches the address. The client card's Contact buttons are Call, Text, Directions. With no address
  it shows "No address yet. Ask the client to send an update." instead of Directions.
- Maps rule (Directions, client/vet/emergency vet address links, sitter.html): iPhone, iPad, and
  iPadOS reporting as a Mac with touch use Apple Maps (`maps.apple.com/?daddr=` for Directions,
  `?q=` for address links); everything else uses Google Maps (`/maps/dir/?api=1&destination=`,
  `/maps/search/?api=1&query=`).
