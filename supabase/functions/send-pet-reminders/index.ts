// Pawfolio — Web Push delivery worker (Supabase Edge Function, Deno runtime).
//
// Schedule this on a 2-minute cron via pg_cron, on the ODD minutes (see
// supabase/migrations/0002_reminder_cron.sql -- MedRecords' send-reminders
// takes the even minutes so the two never compete for a worker slot).
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
// Schedule: run supabase/migrations/0002_reminder_cron.sql (see also
//           PUSH_SETUP.md step 5). Always pass timeout_milliseconds to
//           net.http_post -- an unbounded call keeps pg_net's transaction
//           open, which blocks autovacuum project-wide and trips the Disk IO
//           budget.

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
  source: "vet-visit" | "medication" | "vaccination" | "dose";
  source_id: number;
  pet_name: string | null;
  title: string;
  body: string | null;
  fire_at: string;
  dose_event_id: string | null;
}

interface DeviceRow {
  device_id: string;
  endpoint: string;
  p256dh: string | null;
  auth: string | null;
}

// ---------------------------------------------------------------------------
// Dose tracking (0003_pawfolio_dose_schedules.sql). Ported from MedRecords'
// send-reminders, which has run on real devices. Two cheap, idempotent steps
// per tick, and deliberately no new cron job:
//   1. pawfolio_dose_sweep() records overdue doses as missed and makes sure
//      every enabled schedule has exactly one pending dose.
//   2. materializeDoseReminders() turns pending doses that are now due into
//      pawfolio_reminders rows; the unique index on dose_event_id makes the
//      insert safe to attempt every tick.
// Doses notify at dose time only.
// ---------------------------------------------------------------------------
interface DueDoseRow {
  id: string;
  due_at: string;
  pawfolio_dose_schedules: {
    user_id: string;
    source_id: number;
    label: string;
    subject_name: string | null;
    timezone: string | null;
  };
}

function isValidTimeZone(tz: string | null | undefined): tz is string {
  if (!tz) return false;
  try { new Intl.DateTimeFormat("en-US", { timeZone: tz }); return true; } catch { return false; }
}

/** "2:14 PM" in the schedule's own timezone. */
function formatLocalClock(instant: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-US", { timeZone, hour: "numeric", minute: "2-digit" }).format(instant);
}

async function sweepDoses(): Promise<Record<string, unknown>> {
  const { data, error } = await supabase.rpc("pawfolio_dose_sweep", { p_limit: 500 });
  if (error) return { error: error.message };
  return (data ?? {}) as Record<string, unknown>;
}

async function materializeDoseReminders(now: Date): Promise<{ created: number; skipped: number; errors: string[] }> {
  const errors: string[] = [];
  let created = 0;
  let skipped = 0;

  const { data: dueDoses, error: dueErr } = await supabase
    .from("pawfolio_dose_events")
    .select("id, due_at, pawfolio_dose_schedules!inner(user_id, source_id, label, subject_name, timezone)")
    .eq("status", "pending")
    .is("notified_at", null)
    .lte("due_at", now.toISOString())
    .eq("pawfolio_dose_schedules.enabled", true)
    .order("due_at", { ascending: true })
    .limit(200);
  if (dueErr) return { created, skipped, errors: [`due dose lookup: ${dueErr.message}`] };
  if (!dueDoses || dueDoses.length === 0) return { created, skipped, errors };
  const rows = dueDoses as unknown as DueDoseRow[];

  // pawfolio_reminders.device_id is NOT NULL. For a dose it is informational
  // only (delivery fans out to every device the user owns), so the most
  // recently updated device is a valid stamp.
  const userIds = [...new Set(rows.map((r) => r.pawfolio_dose_schedules.user_id))];
  const { data: devices, error: devErr } = await supabase
    .from("pawfolio_devices")
    .select("user_id, device_id, updated_at")
    .in("user_id", userIds)
    .order("updated_at", { ascending: false });
  if (devErr) return { created, skipped, errors: [`device lookup: ${devErr.message}`] };
  const deviceByUser = new Map<string, string>();
  for (const d of (devices ?? []) as Array<{ user_id: string; device_id: string }>) {
    if (!deviceByUser.has(d.user_id)) deviceByUser.set(d.user_id, d.device_id);
  }

  for (const row of rows) {
    const schedule = row.pawfolio_dose_schedules;
    const deviceId = deviceByUser.get(schedule.user_id);
    if (!deviceId) {
      // Phone reminders are off. The dose is still tracked in the app.
      skipped++;
      continue;
    }
    const timeZone = isValidTimeZone(schedule.timezone) ? schedule.timezone : "UTC";
    const { error: insErr } = await supabase.from("pawfolio_reminders").insert({
      user_id: schedule.user_id,
      device_id: deviceId,
      source: "dose",
      source_id: schedule.source_id,
      pet_name: schedule.subject_name,
      title: schedule.label,
      body: `Due ${formatLocalClock(new Date(row.due_at), timeZone)}`,
      fire_at: row.due_at,
      dose_event_id: row.id,
    });
    if (insErr) {
      // 23505 = already queued on an earlier tick; expected.
      if ((insErr as any).code === "23505" || /duplicate key/i.test(insErr.message)) {
        skipped++;
      } else {
        errors.push(`dose ${row.id}: insert failed: ${insErr.message}`);
        continue;
      }
    } else {
      created++;
    }
    const { error: stampErr } = await supabase
      .from("pawfolio_dose_events")
      .update({ notified_at: new Date().toISOString() })
      .eq("id", row.id);
    if (stampErr) errors.push(`dose ${row.id}: notified_at failed: ${stampErr.message}`);
  }
  return { created, skipped, errors };
}

/** What a phone shows for a dose. iOS ignores notification action buttons,
 *  so the tap target is the one-tap confirm screen. */
function dosePayload(reminder: ReminderRow): string {
  const label = reminder.title?.trim() || "medication";
  const pet = reminder.pet_name?.trim() ?? "";
  return JSON.stringify({
    title: `💊 Dose due: ${label}`,
    body: (pet ? `${pet} — ` : "") + (reminder.body?.trim() || "Tap to record this dose."),
    tag: `dose-${reminder.dose_event_id ?? reminder.source_id}`,
    url: reminder.dose_event_id ? `./index.html#dose=${reminder.dose_event_id}` : "./index.html",
    source: reminder.source,
    sourceId: reminder.source_id,
    doseEventId: reminder.dose_event_id,
  });
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
  const payload = reminder.source === "dose" ? dosePayload(reminder) : JSON.stringify({
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
  const now = new Date();
  // Doses first: retire overdue ones, then queue pushes for the ones now due,
  // so the delivery pass below sends them like any other reminder.
  const sweep = await sweepDoses();
  const doses = await materializeDoseReminders(now);

  const nowIso = now.toISOString();
  const { data: due, error } = await supabase
    .from("pawfolio_reminders")
    .select("id, user_id, device_id, source, source_id, pet_name, title, body, fire_at, dose_event_id")
    .is("delivered_at", null)
    .lte("fire_at", nowIso)
    .order("fire_at", { ascending: true })
    .limit(200);
  if (error) {
    return new Response(JSON.stringify({ error: error.message }), { status: 500 });
  }
  if (!due || due.length === 0) {
    return new Response(JSON.stringify({ delivered: 0, sweep, doses }), { status: 200 });
  }

  let delivered = 0;
  let failed = 0;
  let superseded = 0;
  for (const reminder of due as ReminderRow[]) {
    // A queued dose push is only valid while the dose is still pending. If it
    // was given, skipped or missed between ticks, don't tell anyone to give it.
    if (reminder.source === "dose" && reminder.dose_event_id) {
      const { data: event } = await supabase
        .from("pawfolio_dose_events")
        .select("status")
        .eq("id", reminder.dose_event_id)
        .maybeSingle();
      const status = (event as { status: string } | null)?.status;
      if (status !== "pending") {
        superseded++;
        await supabase
          .from("pawfolio_reminders")
          .update({ delivered_at: new Date().toISOString(), delivery_error: `superseded: dose ${status ?? "deleted"}` })
          .eq("id", reminder.id);
        continue;
      }
    }
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

  return new Response(JSON.stringify({ delivered, failed, superseded, considered: due.length, sweep, doses }), {
    headers: { "content-type": "application/json" },
    status: 200,
  });
});
