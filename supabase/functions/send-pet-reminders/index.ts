// Pawfolio — Web Push delivery worker (Supabase Edge Function, Deno runtime).
//
// Schedule this on a 1-minute cron via Supabase Scheduled Triggers or pg_cron.
// It looks up reminders whose fire_at has passed and have not yet been
// delivered, sends a Web Push to every device the owning user has registered,
// and stamps delivered_at.
//
// Required environment variables (set with `supabase secrets set ...`):
//   SUPABASE_URL                — auto-populated for Edge Functions
//   SUPABASE_SERVICE_ROLE_KEY   — service-role key, bypasses RLS
//   VAPID_PUBLIC_KEY            — same value as the client's VAPID_PUBLIC_KEY
//   VAPID_PRIVATE_KEY           — VAPID private key (keep secret)
//   VAPID_SUBJECT               — mailto:you@example.com
//
// Deploy:   supabase functions deploy send-pet-reminders --no-verify-jwt
// Secrets:  supabase secrets set VAPID_PUBLIC_KEY=... VAPID_PRIVATE_KEY=... VAPID_SUBJECT=mailto:...
// Schedule: add a Scheduled Trigger that POSTs to this function every minute,
//           or use pg_cron + pg_net (see PUSH_SETUP.md).

// deno-lint-ignore-file no-explicit-any
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";
import webpush from "https://esm.sh/web-push@3.6.7";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const VAPID_PUBLIC_KEY = Deno.env.get("VAPID_PUBLIC_KEY")!;
const VAPID_PRIVATE_KEY = Deno.env.get("VAPID_PRIVATE_KEY")!;
const VAPID_SUBJECT = Deno.env.get("VAPID_SUBJECT") ?? "mailto:admin@example.com";

webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

interface ReminderRow {
  id: string;
  user_id: string;
  device_id: string;
  source: "vet-visit" | "medication" | "vaccination";
  source_id: number;
  pet_name: string | null;
  title: string;
  body: string | null;
  fire_at: string;
}

interface DeviceRow {
  device_id: string;
  endpoint: string;
  p256dh: string | null;
  auth: string | null;
}

async function deliverOne(reminder: ReminderRow): Promise<{ ok: boolean; error?: string }> {
  // A user may install the PWA on several phones — deliver to all of them.
  const { data: devices, error: devErr } = await supabase
    .from("pawfolio_devices")
    .select("device_id, endpoint, p256dh, auth")
    .eq("user_id", reminder.user_id);
  if (devErr) return { ok: false, error: `device lookup failed: ${devErr.message}` };
  if (!devices || devices.length === 0) return { ok: false, error: "no devices for user" };

  // Title and body are pre-rendered by the client in the user's local timezone;
  // the worker delivers them as-is and never re-formats dates server-side.
  const payload = JSON.stringify({
    title: reminder.title || "Pawfolio reminder",
    body: reminder.body || "",
    tag: `${reminder.source}-${reminder.source_id}`,
    url: "./index.html",
    source: reminder.source,
    sourceId: reminder.source_id,
  });

  const results = await Promise.allSettled(
    (devices as DeviceRow[]).map(async (d) => {
      if (!d.p256dh || !d.auth) throw new Error("missing keys");
      await webpush.sendNotification(
        { endpoint: d.endpoint, keys: { p256dh: d.p256dh, auth: d.auth } },
        payload,
      );
    }),
  );

  // Drop expired/invalid subscriptions so the client re-subscribes next open.
  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    if (r.status === "rejected") {
      const status = (r.reason && (r.reason as any).statusCode) || 0;
      if (status === 404 || status === 410) {
        await supabase.from("pawfolio_devices").delete().eq("endpoint", devices[i].endpoint);
      }
    }
  }

  const anySent = results.some((r) => r.status === "fulfilled");
  if (anySent) return { ok: true };
  const firstErr = results.find((r) => r.status === "rejected") as PromiseRejectedResult | undefined;
  return { ok: false, error: firstErr?.reason?.message ?? "all sends failed" };
}

Deno.serve(async (_req) => {
  const nowIso = new Date().toISOString();
  const { data: due, error } = await supabase
    .from("pawfolio_reminders")
    .select("id, user_id, device_id, source, source_id, pet_name, title, body, fire_at")
    .is("delivered_at", null)
    .lte("fire_at", nowIso)
    .order("fire_at", { ascending: true })
    .limit(200);
  if (error) {
    return new Response(JSON.stringify({ error: error.message }), { status: 500 });
  }
  if (!due || due.length === 0) {
    return new Response(JSON.stringify({ delivered: 0 }), { status: 200 });
  }

  let delivered = 0;
  let failed = 0;
  for (const reminder of due as ReminderRow[]) {
    const result = await deliverOne(reminder);
    if (result.ok) {
      delivered++;
      await supabase
        .from("pawfolio_reminders")
        .update({ delivered_at: new Date().toISOString(), delivery_error: null })
        .eq("id", reminder.id);
    } else {
      failed++;
      await supabase
        .from("pawfolio_reminders")
        .update({ delivery_error: result.error ?? "unknown" })
        .eq("id", reminder.id);
    }
  }

  return new Response(JSON.stringify({ delivered, failed, considered: due.length }), {
    headers: { "content-type": "application/json" },
    status: 200,
  });
});
