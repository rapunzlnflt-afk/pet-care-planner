# Pawfolio Phone Reminders — One-Time Setup

Pawfolio is an offline-first app: your pet records always stay in your browser.
Phone reminders add **real push notifications** (vet visits, medication refills,
and vaccinations) that arrive even when the app is fully closed and the screen
is locked. Only the short reminder text — title, body, and the time it should
fire — ever leaves your device. No pet records are uploaded.

The pieces below run **outside the app** and only need to be set up once. This
is a brand-new Supabase project just for Pawfolio (separate from MedRecords).

When you finish, you'll have **three public values** to paste into the app, plus
a couple of private secrets that live only on the server.

---

## What you'll end up with

Paste these three **public** values into `index.html` (search for the
`v3.8.0` push block, near the bottom):

```js
var SUPABASE_URL      = 'https://<your-project>.supabase.co';
var SUPABASE_ANON_KEY = '<anon public key>';
var VAPID_PUBLIC_KEY  = '<VAPID public key>';
```

These are safe to ship publicly. The **private** VAPID key and the
**service-role** key never go in the app — only into Supabase secrets.

---

## 1. Generate a VAPID key pair

On any computer with Node installed:

```bash
npx web-push generate-vapid-keys
```

It prints a **Public Key** and a **Private Key**. Save both. The public key
goes in the app; the private key goes in the Edge Function secrets.

## 2. Create a new Supabase project (for Pawfolio)

1. Go to https://supabase.com → **New project**. Name it e.g. `pawfolio`.
2. Open **Authentication → Providers** (or **Sign In / Up**) and enable
   **Anonymous sign-ins**. Pawfolio signs in anonymously so each install gets a
   stable user id without asking for an email or password.
3. Open the **SQL Editor**, paste the entire contents of
   `supabase/migrations/0001_phone_reminders.sql`, and click **Run**.
   This creates two tables — `devices` and `reminders` — with row-level
   security so each device only sees its own rows.

## 3. Grab your project's public values

In **Project Settings → API**:

- **Project URL** → this is `SUPABASE_URL`.
- **Project API keys → `anon` `public`** → this is `SUPABASE_ANON_KEY`.

Combined with the **VAPID public key** from step 1, that's all three values
you'll paste into the app. (Send them to me and I'll drop them in, or paste
them into the push block yourself.)

> Until these three values are filled in, the app stays in a friendly
> "Phone reminders — coming soon" state and makes no network calls. Everything
> else keeps working.

## 4. Deploy the delivery Edge Function

The function in `supabase/functions/send-pet-reminders/` finds due reminders,
sends the push, and marks them delivered.

```bash
# install the CLI: https://supabase.com/docs/guides/cli
supabase login
supabase link --project-ref <your-project-ref>

# private secrets (these never go in the app)
supabase secrets set \
  VAPID_PUBLIC_KEY=<public key from step 1> \
  VAPID_PRIVATE_KEY=<private key from step 1> \
  VAPID_SUBJECT=mailto:you@example.com

supabase functions deploy send-pet-reminders --no-verify-jwt
```

`SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are provided automatically for
deployed functions.

## 5. Schedule the function (every minute)

In the Supabase dashboard, **Database → Cron / Scheduled Triggers**, add a job
that POSTs to the function every minute. Equivalent SQL:

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

| Data                                                   | Where                |
| ------------------------------------------------------ | -------------------- |
| Pets, vet visits, medications, vaccinations, documents | **Local only** (your browser) |
| Reminder fire time, title, body                        | Supabase `reminders` |
| Browser push endpoint + keys                           | Supabase `devices`   |

The Edge Function never touches your pet records — it only sees the short
strings shown in the notification.

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

## Turning it off

Use the **toggle on the Phone reminders card** to turn it off on a device. That
unsubscribes that phone and deletes its device row and pending reminders from
Supabase. Other phones are unaffected.
