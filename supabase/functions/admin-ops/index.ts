// Supabase Edge Function: admin-ops
//
// Privileged reads/writes for the office admin dashboard, authorized by the
// staff token from staff-login. Keeps the service-role key on the server: the
// browser never receives a credential that bypasses Row Level Security.
//
//   POST  Authorization: Bearer <staff token>
//         { "action": "...", ...params }
//     200 { ok: true, ... }  |  400 bad request  |  401 re-run staff-login
//     403 untrusted origin   |  404 unknown action | 500 not configured
//
// Actions:
//   customers_list                       -> { customers: [...] }
//   orders_list                          -> { orders: [...] }
//   order_items        { order_id }      -> { items: [...] }
//   order_status       { order_id, status }
//   emails_list        { customer_id }   -> { emails: [...] }
//   email_add          { customer_id, email, is_primary? }
//   email_delete       { email_id, customer_id }
//   email_set_primary  { email_id, customer_id }
//   email_update       { email_id, email }
//
// The token format and verification mirror staff-customers exactly (12h TTL,
// HMAC-SHA256 over "v1:<exp>").
//
// Required secrets:
//   STAFF_TOKEN_SECRET=<same value as staff-login>
//   NS_SERVICE_KEY=<service-role / secret key>   (optional: falls back to the
//                   built-in SUPABASE_SERVICE_ROLE_KEY)
//
// Deploy:
//   supabase functions deploy admin-ops --no-verify-jwt

const TOKEN_SECRET = Deno.env.get("STAFF_TOKEN_SECRET") || "";
const SUPABASE_URL = Deno.env.get("SUPABASE_URL") || "https://ruwyfesblmaurfuiaofw.supabase.co";
const SERVICE_ROLE = Deno.env.get("NS_SERVICE_KEY") ||
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";

const ORDER_STATUSES = new Set(["new", "confirmed", "fulfilled", "cancelled"]);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const ALLOWED_ORIGINS = (Deno.env.get("ALLOWED_ORIGINS") ||
  "https://tfross67.github.io,https://nativeson.com,https://www.nativeson.com,https://nativesonsnursery.com")
  .split(",").map(s => s.trim()).filter(Boolean);

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...CORS_HEADERS },
  });
}

function originAllowed(req: Request): boolean {
  const origin = (req.headers.get("origin") || "").trim();
  const referer = (req.headers.get("referer") || "").trim();
  if (!origin && !referer) return false;
  return ALLOWED_ORIGINS.some(p => origin.startsWith(p) || referer.startsWith(p));
}

function b64urlDecode(s: string): string {
  const pad = s.length % 4 === 0 ? "" : "=".repeat(4 - (s.length % 4));
  return atob(s.replace(/-/g, "+").replace(/_/g, "/") + pad);
}

function timingSafeEqual(a: string, b: string): boolean {
  const x = new TextEncoder().encode(a);
  const y = new TextEncoder().encode(b);
  let diff = x.length ^ y.length;
  const n = Math.max(x.length, y.length);
  for (let i = 0; i < n; i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}

async function expectedSig(exp: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(TOKEN_SECRET),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`v1:${exp}`));
  return [...new Uint8Array(mac)].map(b => b.toString(16).padStart(2, "0")).join("");
}

async function tokenValid(header: string | null): Promise<boolean> {
  if (!header || !header.startsWith("Bearer ")) return false;
  const token = header.slice(7).trim();
  const dot = token.indexOf(".");
  if (dot < 1) return false;
  const expB64 = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  let exp: string;
  try {
    exp = b64urlDecode(expB64);
  } catch {
    return false;
  }
  if (!/^\d{9,12}$/.test(exp)) return false;
  if (Number(exp) * 1000 <= Date.now()) return false; // expired
  const want = await expectedSig(exp);
  return timingSafeEqual(sig.toLowerCase(), want);
}

// Service-role REST call. Returns Postgres/PostgREST status + parsed body so
// the client can distinguish a unique-violation (409) from a real failure.
async function rest(path: string, init: RequestInit = {}) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...init,
    headers: {
      apikey: SERVICE_ROLE,
      authorization: `Bearer ${SERVICE_ROLE}`,
      "content-type": "application/json",
      prefer: "return=representation",
      ...(init.headers as Record<string, string> | undefined),
    },
  });
  const text = await res.text();
  let body: unknown = null;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
  }
  return { status: res.status, body };
}

function dbError(r: { status: number; body: unknown }) {
  const body = r.body as { message?: string; code?: string } | null;
  return json({
    ok: false,
    error: body?.message || (typeof r.body === "string" ? r.body : "database error"),
    code: body?.code || String(r.status),
    status: r.status,
  }, r.status === 409 ? 409 : 502);
}

// @ts-ignore
Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS_HEADERS });
  if (req.method !== "POST") {
    return new Response("Method not allowed", { status: 405, headers: CORS_HEADERS });
  }
  if (!TOKEN_SECRET || !SERVICE_ROLE) {
    return json({ ok: false, error: "admin-ops is not configured (missing secrets)" }, 500);
  }
  if (!originAllowed(req)) {
    return json({ ok: false, error: "Forbidden: untrusted origin" }, 403);
  }
  if (!(await tokenValid(req.headers.get("authorization")))) {
    // 401 tells the client to re-run staff-login.
    return json({ ok: false, error: "Unauthorized" }, 401);
  }

  let payload: Record<string, unknown> = {};
  try {
    payload = await req.json();
  } catch {
    return json({ ok: false, error: "Invalid JSON" }, 400);
  }
  const action = String(payload.action ?? "");
  const str = (k: string) => String(payload[k] ?? "").trim();

  switch (action) {
    case "customers_list": {
      // Page through explicitly: PostgREST caps one response at max-rows
      // (1000 here) and a single fetch would silently truncate the picker.
      const PAGE = 1000;
      const all: any[] = [];
      for (let offset = 0; ; offset += PAGE) {
        const r = await rest(
          `customers?select=*&active=eq.true&order=name.asc&limit=${PAGE}&offset=${offset}`,
        );
        if (r.status !== 200) return dbError(r);
        const batch = (r.body as any[]) || [];
        all.push(...batch);
        if (batch.length < PAGE) break;
        if (offset > 50000) break; // runaway guard
      }
      return json({ ok: true, count: all.length, customers: all });
    }

    case "orders_list": {
      const r = await rest("orders?select=*&order=created_at.desc&limit=500");
      if (r.status !== 200) return dbError(r);
      return json({ ok: true, orders: r.body });
    }

    case "order_items": {
      const id = str("order_id");
      if (!UUID_RE.test(id)) return json({ ok: false, error: "bad order_id" }, 400);
      const r = await rest(`order_items?select=*&order_id=eq.${id}`);
      if (r.status !== 200) return dbError(r);
      return json({ ok: true, items: r.body });
    }

    case "order_status": {
      const id = str("order_id");
      const status = str("status");
      if (!UUID_RE.test(id)) return json({ ok: false, error: "bad order_id" }, 400);
      if (!ORDER_STATUSES.has(status)) return json({ ok: false, error: "bad status" }, 400);
      const r = await rest(`orders?id=eq.${id}`, {
        method: "PATCH",
        body: JSON.stringify({ status, updated_at: new Date().toISOString() }),
      });
      if (r.status !== 200 && r.status !== 204) return dbError(r);
      return json({ ok: true });
    }

    case "emails_list": {
      const cid = str("customer_id");
      if (!UUID_RE.test(cid)) return json({ ok: false, error: "bad customer_id" }, 400);
      const r = await rest(
        `customer_emails?select=id,email,is_primary&customer_id=eq.${cid}&order=is_primary.desc`,
      );
      if (r.status !== 200) return dbError(r);
      return json({ ok: true, emails: r.body });
    }

    case "email_add": {
      const cid = str("customer_id");
      const email = str("email").toLowerCase();
      if (!UUID_RE.test(cid)) return json({ ok: false, error: "bad customer_id" }, 400);
      if (!EMAIL_RE.test(email)) return json({ ok: false, error: "bad email" }, 400);
      const r = await rest("customer_emails", {
        method: "POST",
        body: JSON.stringify({
          customer_id: cid,
          email,
          is_primary: payload.is_primary === true,
        }),
      });
      if (r.status !== 201 && r.status !== 200) return dbError(r);
      return json({ ok: true });
    }

    case "email_delete": {
      const id = str("email_id");
      const cid = str("customer_id");
      if (!UUID_RE.test(id)) return json({ ok: false, error: "bad email_id" }, 400);
      // Look at the row first: if it was primary, promote the oldest survivor.
      const before = await rest(`customer_emails?select=id,is_primary&id=eq.${id}`);
      if (before.status !== 200) return dbError(before);
      const row = Array.isArray(before.body) ? before.body[0] : null;
      const r = await rest(`customer_emails?id=eq.${id}`, { method: "DELETE" });
      if (r.status !== 200 && r.status !== 204) return dbError(r);
      if (row?.is_primary && UUID_RE.test(cid)) {
        const remaining = await rest(
          `customer_emails?select=id&customer_id=eq.${cid}&order=id.asc&limit=1`,
        );
        const next = Array.isArray(remaining.body) ? remaining.body[0] : null;
        if (next?.id) {
          await rest(`customer_emails?id=eq.${next.id}`, {
            method: "PATCH",
            body: JSON.stringify({ is_primary: true }),
          });
        }
      }
      return json({ ok: true });
    }

    case "email_set_primary": {
      const id = str("email_id");
      const cid = str("customer_id");
      if (!UUID_RE.test(id) || !UUID_RE.test(cid)) {
        return json({ ok: false, error: "bad id" }, 400);
      }
      const clear = await rest(`customer_emails?customer_id=eq.${cid}&is_primary=eq.true`, {
        method: "PATCH",
        body: JSON.stringify({ is_primary: false }),
      });
      if (clear.status !== 200 && clear.status !== 204) return dbError(clear);
      const set = await rest(`customer_emails?id=eq.${id}`, {
        method: "PATCH",
        body: JSON.stringify({ is_primary: true }),
      });
      if (set.status !== 200 && set.status !== 204) return dbError(set);
      return json({ ok: true });
    }

    case "email_update": {
      const id = str("email_id");
      const email = str("email").toLowerCase();
      if (!UUID_RE.test(id)) return json({ ok: false, error: "bad email_id" }, 400);
      if (!EMAIL_RE.test(email)) return json({ ok: false, error: "bad email" }, 400);
      const r = await rest(`customer_emails?id=eq.${id}`, {
        method: "PATCH",
        body: JSON.stringify({ email }),
      });
      if (r.status !== 200 && r.status !== 204) return dbError(r);
      return json({ ok: true });
    }

    default:
      return json({ ok: false, error: `unknown action: ${action}` }, 404);
  }
});
