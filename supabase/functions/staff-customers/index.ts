// Supabase Edge Function: staff-customers
//
// Returns the office customer master to a signed-in staff browser, and to
// nobody else. Replaces the public office_customers.json: that file was
// fetchable by anyone on nativesonsnursery.com and raw.githubusercontent
// because the repo is public and the portal read it with a plain fetch().
//
//   GET  Authorization: Bearer <exp>.<sig>   ->  200 { customers: [...] }
//                                            |  401 { error }
//
// The token comes from staff-login (12h TTL, HMAC-SHA256 over "v1:<exp>").
// Reads public.customers with the service role; anon/authenticated roles are
// denied by RLS (see 20260710_customers_lockdown.sql), so this function is the
// only path to the data.
//
// Required secrets:
//   STAFF_TOKEN_SECRET=<same value as staff-login>
//   SUPABASE_SERVICE_ROLE_KEY (provided by Supabase automatically)
//
// Deploy:
//   supabase functions deploy staff-customers --no-verify-jwt

const TOKEN_SECRET = Deno.env.get("STAFF_TOKEN_SECRET") || "";
const SUPABASE_URL = Deno.env.get("SUPABASE_URL") || "https://ruwyfesblmaurfuiaofw.supabase.co";
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";

const COLUMNS = [
  "customer_code", "name", "contact_name", "address", "city", "state", "zip",
  "email", "phone", "discount", "default_markup_pct", "routing", "sales_person",
  "sales_tax_pct", "terms", "type", "ship_to_name", "ship_to_address",
  "ship_to_city", "ship_to_state", "ship_to_zip", "ship_via", "search_text",
].join(",");

const ALLOWED_ORIGINS = (Deno.env.get("ALLOWED_ORIGINS") ||
  "https://tfross67.github.io,https://nativeson.com,https://www.nativeson.com,https://nativesonsnursery.com")
  .split(",").map(s => s.trim()).filter(Boolean);

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
};

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

// @ts-ignore
Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS_HEADERS });
  if (req.method !== "GET") {
    return new Response("Method not allowed", { status: 405, headers: CORS_HEADERS });
  }
  if (!TOKEN_SECRET || !SERVICE_ROLE) {
    return new Response(
      JSON.stringify({ ok: false, error: "staff-customers is not configured (missing secrets)" }),
      { status: 500, headers: { "Content-Type": "application/json", ...CORS_HEADERS } },
    );
  }
  if (!originAllowed(req)) {
    return new Response(
      JSON.stringify({ ok: false, error: "Forbidden: untrusted origin" }),
      { status: 403, headers: { "Content-Type": "application/json", ...CORS_HEADERS } },
    );
  }
  if (!(await tokenValid(req.headers.get("authorization")))) {
    // 401 tells the client to re-run staff-login.
    return new Response(
      JSON.stringify({ ok: false, error: "Unauthorized" }),
      { status: 401, headers: { "Content-Type": "application/json", ...CORS_HEADERS } },
    );
  }

  // PostgREST caps a single response at the project's max-rows (1000 here), so
  // page through explicitly — a single fetch silently returned the first 1000
  // of ~2.9k customers, which would have truncated the picker without an error.
  const PAGE = 1000;
  const all: any[] = [];
  for (let offset = 0; ; offset += PAGE) {
    const url = `${SUPABASE_URL}/rest/v1/customers?select=${COLUMNS}` +
      `&active=is.true&order=name.asc,customer_code.asc&limit=${PAGE}&offset=${offset}`;
    const res = await fetch(url, {
      headers: {
        apikey: SERVICE_ROLE,
        authorization: `Bearer ${SERVICE_ROLE}`,
        accept: "application/json",
      },
    });
    if (!res.ok) {
      const detail = await res.text();
      console.error("customers read failed:", res.status, detail);
      return new Response(
        JSON.stringify({ ok: false, error: `customers read failed: ${res.status}` }),
        { status: 502, headers: { "Content-Type": "application/json", ...CORS_HEADERS } },
      );
    }
    const batch = await res.json();
    all.push(...batch);
    if (batch.length < PAGE) break;
    if (offset > 50000) break; // runaway guard
  }

  return new Response(
    JSON.stringify({ ok: true, count: all.length, customers: all }),
    {
      status: 200,
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
        ...CORS_HEADERS,
      },
    },
  );
});
