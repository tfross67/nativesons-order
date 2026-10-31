// Supabase Edge Function: prop-entry
//
// Write path for nursery propagation staff entering production rows from
// https://tfross67.github.io/liveinventory/enter.html
//
//   POST { action: "login",  code }           -> { ok, name }
//   POST { action: "submit", code, rows[] }   -> { ok, inserted }
//   GET  ?action=list                          -> { ok, entries[] }   (unreconciled only)
//
// Access model: one access code per person. Only sha256(code) is stored, in
// public.propagators.code_hash. The tables have RLS on with no anon policies,
// so this function's service-role client is the only way in or out.
//
// Deploy: supabase functions deploy prop-entry --no-verify-jwt \
//           --project-ref ruwyfesblmaurfuiaofw
//
// There is no secret to set: SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are
// injected into every Edge Function by the platform.

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") || "";
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";

const MAX_ROWS_PER_SUBMIT = 100;
const TABS = new Set(["liners", "4inch", "1gallon", "5gallon"]);
const SOURCES = new Set(["cuttings", "seed", "division", ""]);

const ALLOWED_ORIGIN_PREFIXES = [
  "https://tfross67.github.io",
  "https://nativesonsnursery.com",
  "https://www.nativesonsnursery.com",
  "https://nativeson.com",
  "https://www.nativeson.com",
];

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...CORS },
  });
}

function originAllowed(req: Request): boolean {
  const origin = (req.headers.get("origin") || "").trim();
  const referer = (req.headers.get("referer") || "").trim();
  const probe = origin || referer;
  if (!probe) return false;
  if (/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?(\/|$)/.test(probe)) return true;
  return ALLOWED_ORIGIN_PREFIXES.some(p => probe.startsWith(p));
}

async function sha256Hex(s: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, "0")).join("");
}

function rest(path: string, init: RequestInit = {}) {
  return fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...init,
    headers: {
      apikey: SERVICE_KEY,
      Authorization: `Bearer ${SERVICE_KEY}`,
      "Content-Type": "application/json",
      ...(init.headers || {}),
    },
  });
}

type Propagator = { id: string; name: string };

async function resolveCode(code: string): Promise<Propagator | null> {
  if (!code) return null;
  const hash = await sha256Hex(code.trim().toLowerCase());
  const res = await rest(
    `propagators?code_hash=eq.${hash}&active=eq.true&select=id,name`,
  );
  if (!res.ok) return null;
  const rows = (await res.json()) as Propagator[];
  return rows.length ? rows[0] : null;
}

// Per-instance throttle on failed attempts, same shape as staff-login.
const attempts = new Map<string, { n: number; reset: number }>();
const WINDOW_MS = 10 * 60 * 1000;
const MAX_ATTEMPTS = 12;

function throttled(ip: string): boolean {
  const now = Date.now();
  const rec = attempts.get(ip);
  if (!rec || now > rec.reset) {
    attempts.set(ip, { n: 1, reset: now + WINDOW_MS });
    return false;
  }
  rec.n += 1;
  return rec.n > MAX_ATTEMPTS;
}

function cleanRow(raw: any) {
  const tab = String(raw?.tab ?? "");
  if (!TABS.has(tab)) throw new Error(`bad tab: ${tab}`);

  const plant_name = String(raw?.plant_name ?? "").trim().slice(0, 240);
  if (!plant_name) throw new Error("plant_name required");

  const qty = Number(raw?.qty);
  if (!Number.isInteger(qty) || qty <= 0 || qty > 1000000) throw new Error(`bad qty for ${plant_name}`);

  const production_date = String(raw?.production_date ?? "");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(production_date)) throw new Error(`bad date for ${plant_name}`);

  const source = String(raw?.source ?? "").trim().toLowerCase();
  if (!SOURCES.has(source)) throw new Error(`bad source for ${plant_name}`);

  const item_code = raw?.item_code ? String(raw.item_code).trim().slice(0, 40) : null;
  const catalog_size = raw?.catalog_size ? String(raw.catalog_size).trim().slice(0, 20) : null;

  return {
    tab,
    plant_name,
    item_code,
    catalog_size,
    row_size: String(raw?.row_size ?? "").slice(0, 40),
    production_date,
    qty,
    source,
    notes: raw?.notes ? String(raw.notes).trim().slice(0, 500) : null,
  };
}

// @ts-ignore Deno global
Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  if (!originAllowed(req)) return json({ ok: false, error: "Forbidden: untrusted origin" }, 403);
  if (!SUPABASE_URL || !SERVICE_KEY) {
    return json({ ok: false, error: "prop-entry is not configured (missing platform env)" }, 500);
  }

  const url = new URL(req.url);

  // ---- public read: unreconciled entries for the tracker ----
  if (req.method === "GET") {
    if (url.searchParams.get("action") !== "list") return json({ ok: false, error: "unknown action" }, 400);
    const res = await rest(
      "production_entries?reconciled=eq.false&select=id,entered_by,tab,plant_name,item_code," +
        "catalog_size,row_size,production_date,qty,source,notes,created_at&order=created_at.desc&limit=1000",
    );
    if (!res.ok) return json({ ok: false, error: `read failed: ${await res.text()}` }, 502);
    return json({ ok: true, entries: await res.json() });
  }

  if (req.method !== "POST") return json({ ok: false, error: "method not allowed" }, 405);

  let body: any;
  try {
    body = await req.json();
  } catch {
    return json({ ok: false, error: "invalid JSON" }, 400);
  }

  const ip = (req.headers.get("x-forwarded-for") || "unknown").split(",")[0].trim();
  const code = String(body?.code ?? "").trim();
  const propagator = await resolveCode(code);
  if (!propagator) {
    if (throttled(ip)) return json({ ok: false, error: "too many attempts; wait a few minutes" }, 429);
    return json({ ok: false, error: "wrong access code" }, 401);
  }

  // best-effort activity stamp
  rest(`propagators?id=eq.${propagator.id}`, {
    method: "PATCH",
    headers: { Prefer: "return=minimal" },
    body: JSON.stringify({ last_seen_at: new Date().toISOString() }),
  }).catch(() => {});

  const action = String(body?.action ?? "login");

  if (action === "login") return json({ ok: true, name: propagator.name });

  if (action !== "submit") return json({ ok: false, error: `unknown action: ${action}` }, 400);

  const rawRows = Array.isArray(body?.rows) ? body.rows : [];
  if (!rawRows.length) return json({ ok: false, error: "no rows" }, 400);
  if (rawRows.length > MAX_ROWS_PER_SUBMIT) {
    return json({ ok: false, error: `too many rows (max ${MAX_ROWS_PER_SUBMIT})` }, 400);
  }

  let rows;
  try {
    rows = rawRows.map(cleanRow);
  } catch (e) {
    return json({ ok: false, error: String((e as Error).message) }, 400);
  }

  const payload = rows.map(r => ({
    ...r,
    propagator_id: propagator.id,
    entered_by: propagator.name,
  }));

  const res = await rest("production_entries?select=id", {
    method: "POST",
    headers: { Prefer: "return=representation" },
    body: JSON.stringify(payload),
  });
  if (!res.ok) return json({ ok: false, error: `insert failed: ${await res.text()}` }, 502);

  const inserted = (await res.json()) as { id: string }[];
  return json({ ok: true, inserted: inserted.length, ids: inserted.map(r => r.id) }, 201);
});
