# Pawfolio Reminders — How they work & how to go further

## What ships in v3.6.0: Local (on-device) reminders

Pawfolio now sends **local notifications** for upcoming vet appointments. These are
scheduled and fired by the device itself — no server, no account, fully offline-friendly,
and they cost nothing to run on GitHub Pages.

**Behavior**
- The user opts in once via **Vet Visits → Appointment Reminders → Enable**.
- For every *future* appointment (a scheduled visit or a follow-up date), Pawfolio fires:
  - a reminder **~24 hours before**, and
  - a reminder **~1 hour before**.
- Reminders are de-duplicated in `localStorage` (`pawfolioFiredReminders`) so they never repeat.
- Notifications are shown through the **service worker** (`registration.showNotification`), so the
  banner can appear even when the page is in the background. Tapping it focuses/opens the app.

**How firing is triggered**
1. **Precise in-session timers** — while the app is open, exact `setTimeout` timers fire on time
   (armed only for the next 24h, where `setTimeout` is reliable).
2. **Due-check on open/focus/visibility** — every time the app is opened or brought to the
   foreground, Pawfolio checks for any reminder whose window has arrived and fires it. This is the
   reliable catch-up path.
3. **Periodic Background Sync** (best-effort) — on installed PWAs that support it (Chrome/Android),
   the service worker wakes ~hourly and pings the page to run a due-check.

### Honest limitations
- A purely static site **cannot** push to a device that has been fully closed for a long stretch.
  Local notifications fire reliably while the PWA/browser is alive or when the app is reopened.
- **iOS**: notifications require the app to be **installed to the Home Screen** (Add to Home Screen
  in Safari). Background timing is more constrained than Android.
- **Periodic Background Sync** is Chromium-only and requires the PWA to be installed.

For appointment reminders this covers the overwhelming majority of real cases, because the
appointment date/time is known the moment it's scheduled.

---

## Future upgrade: true Web Push via Supabase

To deliver reminders even when the app has been closed for days (server-initiated), add **Web Push**.
You already use Supabase, so the cleanest path is a Supabase Edge Function + a scheduled trigger.

### 1. Generate VAPID keys (once)
```bash
npx web-push generate-vapid-keys
# -> Public Key (goes in the client) and Private Key (stays server-side)
```

### 2. Client: subscribe the device
```js
const reg = await navigator.serviceWorker.ready;
const sub = await reg.pushManager.subscribe({
  userVisibleOnly: true,
  applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY)
});
// Save sub.toJSON() to a Supabase table: push_subscriptions(user_id, endpoint, p256dh, auth)
await supabase.from('push_subscriptions').upsert({ /* ...sub fields... */ });
```

### 3. Service worker: handle incoming pushes
Add to `sw.js`:
```js
self.addEventListener('push', event => {
  const data = event.data ? event.data.json() : {};
  event.waitUntil(
    self.registration.showNotification(data.title || '🐾 Pawfolio', {
      body: data.body || '',
      icon: './icon-192.png',
      badge: './icon-192.png',
      data: { url: data.url || './index.html' }
    })
  );
});
```
(The `notificationclick` handler is already in `sw.js`.)

### 4. Supabase Edge Function: send the pushes
Create a function that runs on a schedule (Supabase Cron) and uses the `web-push` library:
```ts
import webpush from "npm:web-push";
webpush.setVapidDetails("mailto:you@example.com", VAPID_PUBLIC, VAPID_PRIVATE);

// 1. Query appointments due within the lead window.
// 2. For each, load the user's push_subscriptions rows.
// 3. webpush.sendNotification(sub, JSON.stringify({ title, body, url }))
// 4. Delete subscriptions that return 404/410 (expired).
```

### 5. Schedule it
Use Supabase's `pg_cron` / scheduled Edge Functions to run the sender every ~15–60 minutes.

### Data-model note
Because Pawfolio is currently **offline-first and local-only** (records live on the device, not in
Supabase), server-sent push would require syncing appointment dates to Supabase so the server knows
what to remind about. That's a larger architectural change — keep it in mind before committing to
full Web Push. Until then, local notifications need no backend and no data leaves the device.
