// Pawfolio — sitter dose sharing (Supabase Edge Function, Deno runtime).
//
// The ONLY way a sitter's phone touches dose data. It holds the service-role
// key, checks the share token from the link, and allows a short list of
// actions. Sitters get no table access and need no account.
//
//   join      { token, device_id, label, timezone? }      -> member + state
//   state     { token, device_id }                        -> shared doses
//   log       { token, device_id, event_id, taken, force? }
//   subscribe { token, device_id, subscription, timezone? }
//   undo      { token, device_id, event_id }  (own doses, 5 minutes)
//   leave     { token, device_id }
//
// Every call slides the link's expiry 30 days forward. Stopping sharing (the
// owner sets revoked_at) makes every call fail at once.
//
// Deploy: supabase functions deploy pawfolio-dose-share --no-verify-jwt
// (token-checked here; there is no user JWT on a sitter's phone).

// deno-lint-ignore-file no-explicit-any
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  { auth: { persistSession: false } },
);

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "authorization, x-client-info, apikey, content-type",
  "access-control-allow-methods": "POST, OPTIONS",
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...CORS, "content-type": "application/json" } });
}

async function sha256Hex(s: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function cleanLabel(s: unknown): string {
  return String(s ?? "").replace(/\s+/g, " ").trim().slice(0, 40);
}

async function findGroup(token: unknown) {
  if (typeof token !== "string" || token.length < 20 || token.length > 200) return null;
  const { data } = await supabase
    .from("pawfolio_dose_groups")
    .select("id, owner_user, owner_label, expires_at, revoked_at")
    .eq("token_hash", await sha256Hex(token))
    .maybeSingle();
  if (!data || data.revoked_at || new Date(data.expires_at).getTime() < Date.now()) return null;
  return data as { id: string; owner_user: string; owner_label: string | null };
}

async function findMember(groupId: string, deviceId: unknown) {
  if (typeof deviceId !== "string" || deviceId.length < 8 || deviceId.length > 100) return null;
  const { data } = await supabase
    .from("pawfolio_dose_members")
    .select("id, label, removed_at")
    .eq("group_id", groupId)
    .eq("device_id", deviceId)
    .maybeSingle();
  if (!data || data.removed_at) return null;
  return data as { id: string; label: string };
}

async function touch(groupId: string, memberId?: string) {
  const exp = new Date(Date.now() + 30 * 86400000).toISOString();
  await supabase.from("pawfolio_dose_groups").update({ expires_at: exp }).eq("id", groupId);
  if (memberId) await supabase.from("pawfolio_dose_members").update({ last_seen_at: new Date().toISOString() }).eq("id", memberId);
}

// Shared medications only: label, pet, dose times, the pending dose and
// recent history with who logged each one.
const UNDO_MS = 5 * 60000;
// "Change time" stays this long after Given (matches pawfolio_set_dose_time).
const CHANGE_MS = 30 * 60000;

// The owner's missed-dose instruction, as the sentence the sitter sees.
const MISSED_TEXT: Record<string, string> = {
  asap: "Give it as soon as you remember.",
  skip: "Skip it and give the next one as usual.",
  double: "Give a double dose at the next dose time.",
};
function missedText(s: any): string | null {
  if (s.missed_rule === "note") return (s.missed_note || "").trim() || null;
  return MISSED_TEXT[s.missed_rule] ?? null;
}

async function buildState(group: { id: string; owner_user: string; owner_label: string | null }, memberId: string | null = null) {
  const { data: schedules } = await supabase
    .from("pawfolio_dose_schedules")
    .select("id, label, subject_name, fixed_times, timezone, enabled, anchor, interval_min, missed_rule, missed_note")
    .eq("user_id", group.owner_user)
    .eq("shared", true)
    .eq("enabled", true)
    .order("label");
  const list = (schedules ?? []) as any[];
  const ids = list.map((s) => s.id);
  let events: any[] = [];
  if (ids.length) {
    const { data } = await supabase
      .from("pawfolio_dose_events")
      .select("id, schedule_id, due_at, status, taken_at, logged_at, actor_label, actor_member")
      .in("schedule_id", ids)
      .order("due_at", { ascending: false })
      .limit(40 * ids.length);
    // Member ids stay on the server; the page only learns "you can undo this".
    events = ((data ?? []) as any[]).map(({ actor_member, ...e }) => ({
      ...e,
      can_undo: !!memberId && actor_member === memberId && e.status !== "pending" && e.status !== "missed" &&
        !!e.logged_at && Date.now() - new Date(e.logged_at).getTime() < UNDO_MS,
      can_change: !!memberId && actor_member === memberId && e.status === "taken" &&
        !!e.logged_at && Date.now() - new Date(e.logged_at).getTime() < CHANGE_MS,
    }));
  }
  return {
    owner: group.owner_label || null,
    meds: list.map((s) => {
      const mine = events.filter((e) => e.schedule_id === s.id);
      return {
        schedule_id: s.id,
        label: s.label,
        pet: s.subject_name,
        times: s.anchor === "from_last_dose" ? null : s.fixed_times,
        every_hours: s.anchor === "from_last_dose" ? Math.round(s.interval_min / 60) : null,
        missed: missedText(s),
        pending: mine.find((e) => e.status === "pending") ?? null,
        history: mine.filter((e) => e.status !== "pending").slice(0, 10),
      };
    }),
  };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  if (req.method !== "POST") return json({ error: "method" }, 405);

  let body: any;
  try { body = await req.json(); } catch { return json({ error: "bad_request" }, 400); }
  const action = body?.action;

  const group = await findGroup(body?.token);
  if (!group) return json({ error: "link_inactive" }, 403);

  if (action === "join") {
    const label = cleanLabel(body.label);
    if (!label) return json({ error: "name_required" }, 400);
    if (typeof body.device_id !== "string" || body.device_id.length < 8 || body.device_id.length > 100) {
      return json({ error: "bad_device" }, 400);
    }
    const { data, error } = await supabase
      .from("pawfolio_dose_members")
      .upsert({
        group_id: group.id, device_id: body.device_id, label,
        timezone: typeof body.timezone === "string" ? body.timezone.slice(0, 64) : null,
        removed_at: null, last_seen_at: new Date().toISOString(),
      }, { onConflict: "group_id,device_id" })
      .select("id, label")
      .single();
    if (error) return json({ error: "join_failed" }, 500);
    await touch(group.id);
    return json({ member: data, state: await buildState(group, data.id) });
  }

  const member = await findMember(group.id, body?.device_id);
  if (!member) return json({ error: "not_joined" }, 403);

  if (action === "state") {
    await touch(group.id, member.id);
    return json({ member, state: await buildState(group, member.id) });
  }

  if (action === "log") {
    if (typeof body.event_id !== "string") return json({ error: "bad_request" }, 400);
    const { data, error } = await supabase.rpc("pawfolio_log_dose_as_member", {
      p_member_id: member.id, p_event_id: body.event_id, p_taken: !!body.taken, p_force: !!body.force,
    });
    if (error) return json({ error: "log_failed", message: error.message }, 400);
    await touch(group.id, member.id);
    return json({ result: data, state: await buildState(group, member.id) });
  }

  if (action === "undo") {
    if (typeof body.event_id !== "string") return json({ error: "bad_request" }, 400);
    const { data, error } = await supabase.rpc("pawfolio_undo_dose_as_member", {
      p_member_id: member.id, p_event_id: body.event_id,
    });
    if (error) return json({ error: "undo_failed", message: error.message }, 400);
    await touch(group.id, member.id);
    return json({ result: data, state: await buildState(group, member.id) });
  }

  if (action === "settime") {
    if (typeof body.event_id !== "string" || typeof body.taken_at !== "string" || isNaN(Date.parse(body.taken_at))) {
      return json({ error: "bad_request" }, 400);
    }
    const { data, error } = await supabase.rpc("pawfolio_set_dose_time_as_member", {
      p_member_id: member.id, p_event_id: body.event_id, p_taken_at: new Date(body.taken_at).toISOString(),
    });
    if (error) return json({ error: "settime_failed", message: error.message }, 400);
    await touch(group.id, member.id);
    return json({ result: data, state: await buildState(group, member.id) });
  }

  if (action === "subscribe") {
    const sub = body.subscription;
    const endpoint = sub?.endpoint, p256dh = sub?.keys?.p256dh, auth = sub?.keys?.auth;
    const update = (typeof endpoint === "string" && endpoint.startsWith("https://") && p256dh && auth)
      ? { endpoint, p256dh, auth }
      : { endpoint: null, p256dh: null, auth: null };
    const { error } = await supabase.from("pawfolio_dose_members")
      .update({ ...update, timezone: typeof body.timezone === "string" ? body.timezone.slice(0, 64) : undefined })
      .eq("id", member.id);
    if (error) return json({ error: "subscribe_failed" }, 500);
    return json({ ok: true, reminders: !!update.endpoint });
  }

  if (action === "leave") {
    await supabase.from("pawfolio_dose_members")
      .update({ removed_at: new Date().toISOString(), endpoint: null, p256dh: null, auth: null })
      .eq("id", member.id);
    return json({ ok: true });
  }

  return json({ error: "unknown_action" }, 400);
});
