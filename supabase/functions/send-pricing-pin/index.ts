// Supabase Edge Function: send-pricing-pin
// Triggered by the public portal's "Get trade pricing" modal.
//
// Validates the email is on the trade customer list, generates a 6-digit
// PIN, and emails it to the customer via AgentMail. Returns whether the
// email is on the trade list (the PIN itself is never returned in the
// response — it goes only to the customer's email).
//
// Required secrets (set via `supabase secrets set`):
//   AGENTMAIL_API_KEY=am_us_xxx
//   AGENTMAIL_INBOX=afterimage@agentmail.to
//   PRICING_PIN_PEPPER=<random-string>
//
// Deploy:
//   supabase functions deploy send-pricing-pin --project-ref ruwyfesblmaurfuiaofw --no-verify-jwt

interface RequestPayload {
  email: string;
}

const AGENTMAIL_API_KEY = Deno.env.get("AGENTMAIL_API_KEY") || "";
const AGENTMAIL_INBOX = Deno.env.get("AGENTMAIL_INBOX") || "afterimage@agentmail.to";
const SUPABASE_URL = Deno.env.get("SUPABASE_URL") || "https://ruwyfesblmaurfuiaofw.supabase.co";
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";

// Origin allowlist — same pattern as send-order-email.
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

async function sendEmail(to: string, subject: string, html: string, text: string): Promise<void> {
  if (!AGENTMAIL_API_KEY) throw new Error("AGENTMAIL_API_KEY secret is not set");
  const res = await fetch(
    `https://api.agentmail.to/v0/inboxes/${encodeURIComponent(AGENTMAIL_INBOX)}/messages/send`,
    {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${AGENTMAIL_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ to, subject, html, text }),
    }
  );
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`AgentMail API error ${res.status}: ${body}`);
  }
}

function buildPinEmail(pin: string): { subject: string; html: string; text: string } {
  const subject = "Your Native Sons pricing access code";
  const html = `
    <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; max-width: 480px; margin: 0 auto; color: #1f2a1c;">
      <div style="background: #2d4a2b; color: white; padding: 20px 24px; border-radius: 8px 8px 0 0;">
        <h1 style="margin:0; font-size: 20px; font-weight: 600;">Native Sons Wholesale Nursery</h1>
        <p style="margin: 4px 0 0; opacity: 0.85; font-size: 13px;">Trade pricing access</p>
      </div>
      <div style="background: #f7f4ec; padding: 24px; border: 1px solid #e3dccb; border-top: 0; border-radius: 0 0 8px 8px;">
        <p>Here's your one-time access code. Enter it on the portal to unlock wholesale pricing for the next 90 days.</p>
        <div style="background: white; border: 2px dashed #2d4a2b; border-radius: 8px; padding: 24px; margin: 20px 0; text-align: center;">
          <div style="font-family: ui-monospace, Menlo, Consolas, monospace; font-size: 36px; font-weight: 700; letter-spacing: 0.15em; color: #2d4a2b;">${pin}</div>
          <div style="margin-top: 8px; font-size: 12px; color: #6b6256;">Expires in 15 minutes</div>
        </div>
        <p style="font-size: 13px; color: #4a5546;">If you didn't request this, you can ignore the email. The code expires on its own.</p>
        <p style="font-size: 13px; color: #4a5546;">Questions? Call 805.481.5996 or reply to this email.</p>
      </div>
    </div>
  `;
  const text = [
    `Native Sons — Trade pricing access`,
    ``,
    `Here's your one-time access code (expires in 15 minutes):`,
    ``,
    `    ${pin}`,
    ``,
    `Enter it on the portal to unlock wholesale pricing for the next 90 days.`,
    ``,
    `If you didn't request this, you can ignore the email.`,
    `Questions? Call 805.481.5996 or reply to this email.`,
  ].join("\n");
  return { subject, html, text };
}

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

  let payload: RequestPayload;
  try {
    payload = await req.json();
  } catch {
    return new Response("Invalid JSON", { status: 400, headers: CORS_HEADERS });
  }

  const email = String(payload.email || "").trim().toLowerCase();
  if (!email || !email.includes("@")) {
    return new Response(
      JSON.stringify({ ok: false, error: "Invalid email" }),
      { status: 400, headers: { "Content-Type": "application/json", ...CORS_HEADERS } }
    );
  }

  if (!SUPABASE_SERVICE_ROLE_KEY) {
    return new Response(
      JSON.stringify({ ok: false, error: "Service role key not configured" }),
      { status: 500, headers: { "Content-Type": "application/json", ...CORS_HEADERS } }
    );
  }

  // Call the request_pricing_pin RPC. It returns the PIN if the email is
  // on the trade list, or reason='not_trade_customer' otherwise.
  const rpcRes = await fetch(
    `${SUPABASE_URL}/rest/v1/rpc/request_pricing_pin`,
    {
      method: "POST",
      headers: {
        "apikey": SUPABASE_SERVICE_ROLE_KEY,
        "Authorization": `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ p_email: email }),
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
  // The RPC returns a single-row array
  const row = Array.isArray(rpcResult) ? rpcResult[0] : rpcResult;

  if (!row || !row.ok) {
    return new Response(
      JSON.stringify({
        ok: false,
        reason: row?.reason || "unknown",
      }),
      { status: 200, headers: { "Content-Type": "application/json", ...CORS_HEADERS } }
    );
  }

  // Send the PIN email
  try {
    const emailContent = buildPinEmail(row.pin);
    await sendEmail(email, emailContent.subject, emailContent.html, emailContent.text);
  } catch (err) {
    console.error("PIN email failed:", String(err));
    return new Response(
      JSON.stringify({ ok: false, error: "Email send failed" }),
      { status: 500, headers: { "Content-Type": "application/json", ...CORS_HEADERS } }
    );
  }

  return new Response(
    JSON.stringify({ ok: true, reason: "sent" }),
    { status: 200, headers: { "Content-Type": "application/json", ...CORS_HEADERS } }
  );
});