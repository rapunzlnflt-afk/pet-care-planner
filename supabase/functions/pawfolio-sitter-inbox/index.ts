// Pawfolio — sitter inbox (Supabase Edge Function, Deno runtime).
//
// The ONLY way a phone or the web intake form touches the sitter inbox
// tables. It holds the service-role key and allows a short list of actions.
// Forms are encrypted on the client's phone with the sitter's public key
// (intake-crypto.js), so everything stored here is opaque ciphertext.
//
//   register { inbox, token_hash, public_key, code, label }   -> { ok, code }
//   lookup   { code }                                         -> { inbox, public_key, label }
//   submit   { inbox, envelope: { v, z, epk, iv, ct } }        -> { ok, id }
//   list     { inbox, token }                                 -> { items: [{ id, created_at, envelope }], more }
//   ack      { inbox, token, ids: [uuid] }                    -> { ok, deleted }
//
// register/lookup/submit need no secret (the client has no account). list and
// ack need the inbox secret; only its sha256 is stored. Errors are always
// { error } with a proper status.
//
// Rate limits (migration 0010): register, lookup and submit are limited per
// connection (hashed IP), and submit is also limited per inbox. Over a limit
// -> 429 { error: "rate_limited" } with Retry-After. A full inbox is still
// 429 { error: "inbox_full" }; clients tell the two apart by the error code.
//
// Deploy: supabase functions deploy pawfolio-sitter-inbox --no-verify-jwt
// (token-checked here; there is no user JWT on a sitter's or client's phone).

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
  "access-control-expose-headers": "retry-after",
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...CORS, "content-type": "application/json" } });
}

async function sha256Hex(s: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// Limits (keep in sync with SPEC.md, intake-crypto.js and mock_server.py).
const MAX_CT = 1_500_000;          // ciphertext chars per form -> 413 too_large
const MAX_BODY = 1_800_000;        // whole request, bytes
const MAX_PENDING = 100;           // forms waiting per inbox -> 429 inbox_full
const LIST_MAX = 50;               // forms per list call
const LIST_BUDGET = 12_000_000;    // ciphertext chars per list call (always at least one form)
const ACK_MAX = 50;                // ids per ack call
const KEEP_MS = 60 * 86400000;     // unacked forms are purged after 60 days

// Rate limits: [window seconds, max hits]. Generous for real use (a sitter sets
// up once; a client sends a form or two), tight for scripts. A typed code is
// 1 of 31^8, so 30 lookups per 10 minutes makes guessing hopeless.
type Limit = [number, number];
const RATE: Record<string, Limit[]> = {
  "register:ip": [[3600, 10]],
  "lookup:ip": [[600, 30], [86400, 200]],
  "lookup:all": [[3600, 2000]],       // everyone together: backstop if IPs are spread out
  "submit:ip": [[3600, 20], [86400, 60]],
  "submit:inbox": [[3600, 30]],
};

const RE_INBOX = /^[A-Za-z0-9_-]{16,40}$/;
const RE_PUBKEY = /^[A-Za-z0-9_-]{80,100}$/;
const RE_CODE = /^[A-Z2-9]{8}$/;
const RE_HASH = /^[0-9a-f]{64}$/;
const RE_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const RE_EPK = /^[A-Za-z0-9_-]{87}$/;  // raw P-256 point, 65 bytes
const RE_IV = /^[A-Za-z0-9_-]{16}$/;   // 12 bytes
const RE_B64U = /^[A-Za-z0-9_-]+$/;

const isInbox = (s: unknown): s is string => typeof s === "string" && RE_INBOX.test(s);
const normCode = (s: unknown) => String(s ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");

function cleanLabel(s: unknown): string {
  return String(s ?? "").replace(/\s+/g, " ").trim().slice(0, 80);
}

// The inbox, if the secret matches. Unknown inbox and wrong secret look the same.
async function authInbox(inbox: unknown, token: unknown) {
  if (!isInbox(inbox)) return null;
  if (typeof token !== "string" || token.length < 20 || token.length > 200) return null;
  const { data } = await supabase
    .from("pawfolio_sitter_inboxes")
    .select("inbox, token_hash")
    .eq("inbox", inbox)
    .maybeSingle();
  if (!data || data.token_hash !== await sha256Hex(token)) return null;
  return data as { inbox: string };
}

// Client IP as a short hash (never stored raw). cf-connecting-ip is set by
// Cloudflare in front of Supabase and can't be faked by the caller; the first
// x-forwarded-for entry is the fallback. No IP -> no per-IP limit, rather than
// one shared bucket that could lock everyone out (the global lookup cap and
// the per-inbox submit cap still apply).
async function ipKey(req: Request): Promise<string | null> {
  const ip = (req.headers.get("cf-connecting-ip") ?? "").trim() ||
    (req.headers.get("x-forwarded-for") ?? "").split(",")[0].trim() ||
    (req.headers.get("x-real-ip") ?? "").trim();
  if (!ip) return null;
  return (await sha256Hex("pawfolio-sitter-inbox:" + ip)).slice(0, 32);
}

// Counts one hit on every window for this bucket. Returns the Retry-After
// seconds if any window is over its limit, else 0. A database error lets the
// request through: limits are a guard, and real users shouldn't be blocked by
// a hiccup.
async function overLimit(kind: string, id: string | null): Promise<number> {
  if (!id) return 0;
  let wait = 0;
  for (const [secs, max] of RATE[kind]) {
    const { data, error } = await supabase.rpc("pawfolio_sitter_rate_hit", {
      p_bucket: `${kind}:${id}`, p_window_secs: secs, p_limit: max,
    });
    if (error) { console.error("rate_hit", kind, error.message); continue; }
    if (data === false) {
      const left = secs - (Math.floor(Date.now() / 1000) % secs);
      wait = Math.max(wait, left);
    }
  }
  return wait;
}

function limited(wait: number): Response {
  return new Response(JSON.stringify({ error: "rate_limited" }), {
    status: 429,
    headers: { ...CORS, "content-type": "application/json", "retry-after": String(wait) },
  });
}

async function purgeOld(inbox: string) {
  const cutoff = new Date(Date.now() - KEEP_MS).toISOString();
  await supabase.from("pawfolio_sitter_submissions").delete().eq("inbox", inbox).lt("created_at", cutoff);
}

async function touch(inbox: string) {
  await supabase.from("pawfolio_sitter_inboxes").update({ last_seen_at: new Date().toISOString() }).eq("inbox", inbox);
}

// Returns the cleaned envelope, or an error response.
function checkEnvelope(env: any): { env: Record<string, unknown> } | { res: Response } {
  const bad = { res: json({ error: "bad_envelope" }, 400) };
  if (!env || typeof env !== "object" || Array.isArray(env)) return bad;
  const { v, z, epk, iv, ct } = env;
  if (v !== 1 || (z !== 0 && z !== 1)) return bad;
  if (typeof epk !== "string" || typeof iv !== "string" || typeof ct !== "string") return bad;
  if (ct.length > MAX_CT) return { res: json({ error: "too_large" }, 413) };
  // 16-byte GCM tag at least -> 22 chars.
  if (!RE_EPK.test(epk) || !RE_IV.test(iv) || ct.length < 22 || !RE_B64U.test(ct)) return bad;
  return { env: { v, z, epk, iv, ct } };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  if (req.method !== "POST") return json({ error: "method" }, 405);

  if (Number(req.headers.get("content-length") ?? 0) > MAX_BODY) return json({ error: "too_large" }, 413);
  let body: any;
  try { body = await req.json(); } catch { return json({ error: "bad_request" }, 400); }
  if (!body || typeof body !== "object") return json({ error: "bad_request" }, 400);
  const action = body.action;

  if (action === "register") {
    const { inbox, token_hash, public_key } = body;
    const code = normCode(body.code);
    if (!isInbox(inbox) || typeof token_hash !== "string" || !RE_HASH.test(token_hash) ||
        typeof public_key !== "string" || !RE_PUBKEY.test(public_key) || !RE_CODE.test(code)) {
      return json({ error: "bad_request" }, 400);
    }
    const label = cleanLabel(body.label) || null;
    const waitR = await overLimit("register:ip", await ipKey(req));
    if (waitR) return limited(waitR);

    const { data: existing, error: e1 } = await supabase
      .from("pawfolio_sitter_inboxes").select("token_hash").eq("inbox", inbox).maybeSingle();
    if (e1) return json({ error: "register_failed" }, 500);
    // Only the sitter who made the inbox can change it.
    if (existing && existing.token_hash !== token_hash) return json({ error: "forbidden" }, 403);

    const { data: clash } = await supabase
      .from("pawfolio_sitter_inboxes").select("inbox").eq("code", code).neq("inbox", inbox).limit(1);
    if (clash && clash.length) return json({ error: "code_taken" }, 409);

    const now = new Date().toISOString();
    const { error } = existing
      ? await supabase.from("pawfolio_sitter_inboxes")
        .update({ public_key, code, label, last_seen_at: now }).eq("inbox", inbox).eq("token_hash", token_hash)
      : await supabase.from("pawfolio_sitter_inboxes")
        .insert({ inbox, token_hash, public_key, code, label, last_seen_at: now });
    if (error) {
      // Lost a race: someone took the code (or the inbox id) between the checks.
      if ((error as any).code === "23505") {
        const msg = `${error.message} ${(error as any).details ?? ""}`;
        return /code/.test(msg) ? json({ error: "code_taken" }, 409) : json({ error: "forbidden" }, 403);
      }
      return json({ error: "register_failed" }, 500);
    }
    return json({ ok: true, code });
  }

  if (action === "lookup") {
    const code = normCode(body.code);
    // Counted before the format check, so every guess costs a try.
    const waitL = Math.max(await overLimit("lookup:ip", await ipKey(req)), await overLimit("lookup:all", "all"));
    if (waitL) return limited(waitL);
    // A malformed code can't exist, so it is simply not found.
    if (!RE_CODE.test(code)) return json({ error: "not_found" }, 404);
    const { data } = await supabase
      .from("pawfolio_sitter_inboxes").select("inbox, public_key, label").eq("code", code).maybeSingle();
    if (!data) return json({ error: "not_found" }, 404);
    return json({ inbox: data.inbox, public_key: data.public_key, label: data.label ?? "" });
  }

  if (action === "submit") {
    const inbox = body.inbox;
    if (!isInbox(inbox)) return json({ error: "not_found" }, 404);
    const checked = checkEnvelope(body.envelope);
    if ("res" in checked) return checked.res;
    const waitIp = await overLimit("submit:ip", await ipKey(req));
    if (waitIp) return limited(waitIp);

    const { data: ib } = await supabase
      .from("pawfolio_sitter_inboxes").select("inbox").eq("inbox", inbox).maybeSingle();
    if (!ib) return json({ error: "not_found" }, 404);
    // Per inbox too, so many connections together still can't flood one sitter.
    const waitIb = await overLimit("submit:inbox", inbox);
    if (waitIb) return limited(waitIb);

    // Forms older than 60 days don't count toward the limit.
    await purgeOld(inbox);
    const { count, error: e2 } = await supabase
      .from("pawfolio_sitter_submissions").select("id", { count: "exact", head: true }).eq("inbox", inbox);
    if (e2) return json({ error: "submit_failed" }, 500);
    if ((count ?? 0) >= MAX_PENDING) return json({ error: "inbox_full" }, 429);

    const { data, error } = await supabase
      .from("pawfolio_sitter_submissions").insert({ inbox, envelope: checked.env }).select("id").single();
    // The 0010 trigger enforces the cap strictly when two forms race.
    if (error && /inbox_full/.test(String((error as any).message ?? ""))) return json({ error: "inbox_full" }, 429);
    if (error || !data) return json({ error: "submit_failed" }, 500);
    return json({ ok: true, id: data.id });
  }

  if (action === "list" || action === "ack") {
    const ib = await authInbox(body.inbox, body.token);
    if (!ib) return json({ error: "forbidden" }, 403);

    if (action === "list") {
      await purgeOld(ib.inbox);
      await touch(ib.inbox);
      // Sizes first, so a few big forms (photos) can't blow up one response.
      const { data: heads, error: e3 } = await supabase
        .from("pawfolio_sitter_submissions")
        .select("id, ct_len")
        .eq("inbox", ib.inbox)
        .order("created_at", { ascending: true })
        .order("id", { ascending: true })
        .limit(LIST_MAX + 1);
      if (e3) return json({ error: "list_failed" }, 500);
      const rows = (heads ?? []) as { id: string; ct_len: number }[];
      const pick: string[] = [];
      let used = 0;
      for (const r of rows.slice(0, LIST_MAX)) {
        if (pick.length && used + r.ct_len > LIST_BUDGET) break;
        pick.push(r.id); used += r.ct_len;
      }
      let items: any[] = [];
      if (pick.length) {
        const { data, error } = await supabase
          .from("pawfolio_sitter_submissions")
          .select("id, created_at, envelope")
          .eq("inbox", ib.inbox)
          .in("id", pick)
          .order("created_at", { ascending: true })
          .order("id", { ascending: true });
        if (error) return json({ error: "list_failed" }, 500);
        items = data ?? [];
      }
      return json({ items, more: rows.length > pick.length });
    }

    const ids = body.ids;
    if (!Array.isArray(ids) || ids.length > ACK_MAX || !ids.every((x) => typeof x === "string" && RE_UUID.test(x))) {
      return json({ error: "bad_request" }, 400);
    }
    await touch(ib.inbox);
    if (!ids.length) return json({ ok: true, deleted: 0 });
    const { data, error } = await supabase
      .from("pawfolio_sitter_submissions").delete().eq("inbox", ib.inbox).in("id", ids).select("id");
    if (error) return json({ error: "ack_failed" }, 500);
    return json({ ok: true, deleted: (data ?? []).length });
  }

  return json({ error: "unknown_action" }, 400);
});
