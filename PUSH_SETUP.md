# Pawfolio Phone Reminders — One-Time Setup (reusing the MedRecords project)

Pawfolio is an offline-first app: your pet records always stay in your browser.
Phone reminders add **real push notifications** (vet visits, medication refills,
and vaccinations) that arrive even when the app is fully closed and the screen
is locked. Only the short reminder text — title, body, and the time it should
fire — ever leaves your device. No pet records are uploaded.

This setup **reuses your existing MedRecords Supabase project** instead of
creating a new one (the free plan only allows 2 active projects). Pawfolio's
tables are namespaced with a `pawfolio_` prefix, so they live safely alongside
the MedRecords `devices` / `reminders` tables and never collide. Anonymous
sign-ins are already enabled on that project, so there's nothing to change in
Auth.

When you finish, you'll have **three public values** to paste into the app, plus
the same private secrets your MedRecords function already uses.

---

## What you'll end up with

Paste these three **public** values into `index.html` (search for the
`v3.8.0` push block, near the bottom):

```js
var SUPABASE_URL      = 'https://<your-medrecords-project>.supabase.co';
var SUPABASE_ANON_KEY = '<anon public key>';
var VAPID_PUBLIC_KEY  = '<VAPID public key>';
```

These are safe to ship publicly. The **private** VAPID key and the
**service-role** key never go in the app — they live only in Supabase secrets.

---

## 1. Add Pawfolio's tables to the MedRecords project

1. Open your **MedRecords** project at https://supabase.com.
2. Open the **SQL Editor**, paste the entire contents of
   `supabase/migrations/0001_phone_reminders.sql`, and click **Run**.
   This creates `pawfolio_devices` and `pawfolio_reminders` (with row-level
   security) right next to your existing MedRecords tables. Your MedRecords
   data is untouched.

Anonymous sign-ins are already on from MedRecords, so no Auth change is needed.

## 2. Grab the project's public values

In **Project Settings → API** of the MedRecords project:

- **Project URL** → this is `SUPABASE_URL` (same one MedRecords uses).
- **Project API keys → `anon` `public`** → this is `SUPABASE_ANON_KEY`
  (same one MedRecords uses).

## 3. VAPID public key

You have two choices:

- **Reuse MedRecords' VAPID public key** — simplest. Use the same
  `VAPID_PUBLIC_KEY` MedRecords already uses. Pawfolio's Edge Function will then
  use the same VAPID private key too (step 4).
- **Use a fresh pair** — I generated a Pawfolio-specific pair for you. If you
  use it, set its private half as a secret on the Pawfolio function in step 4.

Send me whichever public key you want to use (plus the URL and anon key from
step 2) and I'll drop all three into the app and merge it live.

> Until these three values are filled in, the app stays in a friendly
> "Phone reminders — coming soon" state and makes no network calls. Everything
> else keeps working.

## 4. Deploy the delivery Edge Function

The function in `supabase/functions/send-pet-reminders/` finds due Pawfolio
reminders, sends the push, and marks them delivered. It is a **separate**
function from MedRecords' `send-reminders`, so deploying it won't affect
MedRecords.

```bash
# install the CLI: https://supabase.com/docs/guides/cli
supabase login
supabase link --project-ref <your-medrecords-project-ref>

# private secrets (these never go in the app)
# If you reuse MedRecords' VAPID keys, these are already set — skip this line.
supabase secrets set \
  VAPID_PUBLIC_KEY=<your VAPID public key> \
  VAPID_PRIVATE_KEY=<your VAPID private key> \
  VAPID_SUBJECT=mailto:you@example.com

supabase functions deploy send-pet-reminders --no-verify-jwt
```

`SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are provided automatically for
deployed functions.

> Note: secrets are shared across all functions in the project. Since MedRecords
> already set `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` / `VAPID_SUBJECT`,
> reusing those keys means Pawfolio works with no secret changes at all. Only
> set new secrets if you deliberately want a separate VAPID pair — but that
> would change the keys for BOTH functions, so reuse is recommended here.

## 5. Schedule the function (every minute)

In the Supabase dashboard, **Database → Cron / Scheduled Triggers**, add a job
that POSTs to the Pawfolio function every minute (in addition to the existing
MedRecords schedule). Equivalent SQL:

```sql
select cron.schedule(
  'send-pet-reminders-every-minute',
  '* * * * *',
  $$ select net.http_post(
       url := 'https://<your-project>.functions.supabase.co/send-pet-reminders',
       headers := jsonb_build_object(
         'Content-Type', 'application/json',
         'Authorization', 'Bearer <anon or service-role key>'
       )
     ) $$
);
```

Reminders fire on `fire_at <= now()`, so once-a-minute is plenty.

## 6. Try it

1. Open the deployed app on your phone.
2. Add it to your Home Screen
   (iPhone: Share → **Add to Home Screen** — required for iOS push).
3. Open Pawfolio **from the Home Screen icon**.
4. Go to the **Vet Visits** tab → **Phone reminders** card → tap the toggle and
   accept the permission prompt.
5. Add a vet visit (or medication refill / vaccination) due a few minutes from
   now, with a short lead time selected. Background the app or lock the phone.
6. The push should arrive within about a minute of the fire time.

## What gets stored where

| Data                                                   | Where                        |
| ------------------------------------------------------ | ---------------------------- |
| Pets, vet visits, medications, vaccinations, documents | **Local only** (your browser) |
| Reminder fire time, title, body                        | Supabase `pawfolio_reminders` |
| Browser push endpoint + keys                           | Supabase `pawfolio_devices`   |

The Edge Function never touches your pet records — it only sees the short
strings shown in the notification. Pawfolio's tables and MedRecords' tables
stay completely separate even though they share one project.

## Reminder coverage & lead times

Phone reminders mirror your in-app reminder settings:

- **Vet visits / follow-ups** — at the appointment date & time.
- **Medication refills** — on the refill date (9:00 AM local).
- **Vaccinations** — on the next-due date (9:00 AM local).

Each one fires at every lead time you've selected on the **Appointment
reminders** card (e.g. "1 day before", "1 hour before").

## Limitations

- **iPhone**: push works only when Pawfolio has been added to the Home Screen
  and opened from there at least once (iOS 16.4+). Reminders set in a regular
  Safari tab won't survive.
- **Timing**: Web Push is best-effort. Android usually delivers within seconds;
  iOS may delay a few minutes in low-power mode.
- **Free-tier pause**: a Supabase free project pauses after ~7 days with no
  database activity. Since MedRecords is in active use, this project should stay
  awake — but if reminders ever stop, open the dashboard to confirm the project
  is running.

## Turning it off

Use the **toggle on the Phone reminders card** to turn it off on a device. That
unsubscribes that phone and deletes its `pawfolio_devices` row and pending
`pawfolio_reminders` from Supabase. Other phones (and MedRecords) are unaffected.
