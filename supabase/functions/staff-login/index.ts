// Supabase Edge Function: staff-login
//
// Exchanges the office staff password for a short-lived signed token. The
// password never ships in the client bundle any more — it lives in the
// function's env (STAFF_PASSWORD) and is checked server-side.
//
//   POST { password }  ->  200 { token, exp }   |  401 { error }
//
// Token format: base64url exp . hex HMAC-SHA256("v1:" + exp)
// The customers function verifies it; nothing else is stored server-side.
//
// Required secrets (supabase secrets set ...):
//   STAFF_PASSWORD=<the office staff password>
//   STAFF_TOKEN_SECRET=<openssl rand -hex 32>
//
// Deploy:
//   supabase functions deploy staff-login --no-verify-jwt

const STAFF_PASSWORD = Deno.env.get("STAFF_PASSWORD") || "";
const TOKEN_SECRET = Deno.env.get("STAFF_TOKEN_SECRET") || "";
const TTL_SECONDS = 12 * 60 * 60; // 12h — one office shift

const ALLOWED_ORIGINS = (Deno.env.get("ALLOWED_ORIGINS") ||
  "https://tfross67.github.io,https://nativeson.com,https://www.nativeson.com,https://nativesonsnursery.com")
  .split(",").map(s => s.trim()).filter(Boolean);

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function originAllowed(req: Request): boolean {
  const origin = (req.headers.get("origin") || "").trim();
  const referer = (req.headers.get("referer") || "").trim();
  if (!origin && !referer) return false;
  return ALLOWED_ORIGINS.some(p => origin.startsWith(p) || referer.startsWith(p));
}

function timingSafeEqual(a: string, b: string): boolean {
  const x = new TextEncoder().encode(a);
  const y = new TextEncoder().encode(b);
  // Compare full length regardless of where they diverge.
  let diff = x.length ^ y.length;
  const n = Math.max(x.length, y.length);
  for (let i = 0; i < n; i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}

function b64url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function sign(exp: number): Promise<string> {
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

// Cheap per-instance throttle: an edge instance is short-lived, so this only
// blunts a burst from one address rather than acting as a real lockout.
const attempts = new Map<string, { n: number; reset: number }>();
const WINDOW_MS = 10 * 60 * 1000;
const MAX_ATTEMPTS = 10;

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

// @ts-ignore
Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS_HEADERS });
  if (req.method !== "POST") {
    return new Response("Method not allowed", { status: 405, headers: CORS_HEADERS });
  }
  if (!STAFF_PASSWORD || !TOKEN_SECRET) {
    return new Response(
      JSON.stringify({ ok: false, error: "staff-login is not configured (missing secrets)" }),
      { status: 500, headers: { "Content-Type": "application/json", ...CORS_HEADERS } },
    );
  }
  if (!originAllowed(req)) {
    return new Response(
      JSON.stringify({ ok: false, error: "Forbidden: untrusted origin" }),
      { status: 403, headers: { "Content-Type": "application/json", ...CORS_HEADERS } },
    );
  }

  const ip = (req.headers.get("x-forwarded-for") || "unknown").split(",")[0].trim();
  if (throttled(ip)) {
    return new Response(
      JSON.stringify({ ok: false, error: "Too many attempts; wait a few minutes" }),
      { status: 429, headers: { "Content-Type": "application/json", ...CORS_HEADERS } },
    );
  }

  let password = "";
  try {
    const body = await req.json();
    password = String(body?.password ?? "");
  } catch {
    return new Response(
      JSON.stringify({ ok: false, error: "Invalid JSON" }),
      { status: 400, headers: { "Content-Type": "application/json", ...CORS_HEADERS } },
    );
  }

  if (!timingSafeEqual(password, STAFF_PASSWORD)) {
    return new Response(
      JSON.stringify({ ok: false, error: "Wrong password" }),
      { status: 401, headers: { "Content-Type": "application/json", ...CORS_HEADERS } },
    );
  }

  const exp = Math.floor(Date.now() / 1000) + TTL_SECONDS;
  const token = `${b64url(new TextEncoder().encode(String(exp)))}.${await sign(exp)}`;
  return new Response(
    JSON.stringify({ ok: true, token, exp }),
    { status: 200, headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...CORS_HEADERS } },
  );
});
