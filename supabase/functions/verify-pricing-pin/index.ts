// Supabase Edge Function: verify-pricing-pin
// Triggered by the public portal after the customer enters their 6-digit PIN.
//
// Validates the PIN against the pricing_pins table (via the
// verify_pricing_pin RPC). Returns { ok: true } on success, the client
// then sets a localStorage flag for 90 days.
//
// Required secrets: none beyond the service role key (already configured
// for send-order-email).
//
// Deploy:
//   supabase functions deploy verify-pricing-pin --project-ref ruwyfesblmaurfuiaofw --no-verify-jwt

interface VerifyPayload {
  email: string;
  pin: string;
}

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") || "https://ruwyfesblmaurfuiaofw.supabase.co";
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";

const ALLOWED_ORIGINS = (Deno.env.get("ALLOWED_ORIGINS") ||
  "https://tfross67.github.io,https://nativesonsnursery.com,https://www.nativesonsnursery.com")
  .split(",").map(s => s.trim()).filter(Boolean);

function originAllowed(req: Request): boolean {
  const origin = (req.headers.get("origin") || "").trim();
  const referer = (req.headers.get("referer") || "").trim();
  const hasInternalSecret = !!Deno.env.get("INTERNAL_SECRET") &&
    req.headers.get("x-internal-secret") === Deno.env.get("INTERNAL_SECRET");
  if (hasInternalSecret) return true;
  if (!origin && !referer) return false;
  return ALLOWED_ORIGINS.some(prefix =>
    origin.startsWith(prefix) || referer.startsWith(prefix));
}

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

// @ts-ignore
Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }
  if (req.method !== "POST") {
    return new Response("Method not allowed", { status: 405, headers: CORS_HEADERS });
  }
  if (!originAllowed(req)) {
    return new Response(
      JSON.stringify({ ok: false, error: "Forbidden: untrusted origin" }),
      { status: 403, headers: { "Content-Type": "application/json", ...CORS_HEADERS } }
    );
  }

  let payload: VerifyPayload;
  try {
    payload = await req.json();
  } catch {
    return new Response("Invalid JSON", { status: 400, headers: CORS_HEADERS });
  }

  const email = String(payload.email || "").trim().toLowerCase();
  const pin = String(payload.pin || "").trim();

  if (!email || !email.includes("@")) {
    return new Response(
      JSON.stringify({ ok: false, reason: "invalid_email" }),
      { status: 400, headers: { "Content-Type": "application/json", ...CORS_HEADERS } }
    );
  }
  if (!/^\d{6}$/.test(pin)) {
    return new Response(
      JSON.stringify({ ok: false, reason: "invalid_format" }),
      { status: 400, headers: { "Content-Type": "application/json", ...CORS_HEADERS } }
    );
  }

  if (!SUPABASE_SERVICE_ROLE_KEY) {
    return new Response(
      JSON.stringify({ ok: false, error: "Service role key not configured" }),
      { status: 500, headers: { "Content-Type": "application/json", ...CORS_HEADERS } }
    );
  }

  const rpcRes = await fetch(
    `${SUPABASE_URL}/rest/v1/rpc/verify_pricing_pin`,
    {
      method: "POST",
      headers: {
        "apikey": SUPABASE_SERVICE_ROLE_KEY,
        "Authorization": `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ p_email: email, p_pin: pin }),
    }
  );

  if (!rpcRes.ok) {
    const body = await rpcRes.text();
    return new Response(
      JSON.stringify({ ok: false, error: `RPC failed: ${body}` }),
      { status: 500, headers: { "Content-Type": "application/json", ...CORS_HEADERS } }
    );
  }

  const rpcResult = await rpcRes.json();
  const row = Array.isArray(rpcResult) ? rpcResult[0] : rpcResult;

  return new Response(
    JSON.stringify({
      ok: !!(row && row.ok),
      reason: row?.reason || "unknown",
    }),
    { status: 200, headers: { "Content-Type": "application/json", ...CORS_HEADERS } }
  );
});