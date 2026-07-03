// Supabase Edge Function: send-order-email
// Triggered via Supabase database webhook on orders INSERT,
// or invoked directly via supabase.functions.invoke('send-order-email', ...).
//
// Sends two emails via the AgentMail HTTP API (api.agentmail.to):
//   1. To orders@nativeson.com (Tim / the office) — full order details
//   2. To the customer — friendly confirmation with order number
//
// Required secrets (set via `supabase secrets set`):
//   AGENTMAIL_API_KEY=am_us_xxx     — the API key from your AgentMail dashboard
//   AGENTMAIL_INBOX=afterimage@agentmail.to   — the inbox to send from
//   OFFICE_EMAIL=orders@nativeson.com
//
// Deploy:
//   supabase functions deploy send-order-email --project-ref ruwyfesblmaurfuiaofw --no-verify-jwt
//   supabase secrets set AGENTMAIL_API_KEY=am_us_... AGENTMAIL_INBOX=afterimage@agentmail.to OFFICE_EMAIL=orders@nativeson.com

interface OrderItem {
  plant_key: string;
  plant_name: string;
  plant_size: string | null;
  unit_price: number;
  qty: number;
  line_total: number;
}

interface OrderRecord {
  id: string;
  order_number: string;
  customer_name: string;
  customer_email: string;
  customer_phone: string | null;
  customer_company: string | null;
  notes: string | null;
  status: string;
  subtotal: number;
  item_count: number;
  created_at: string;
}

interface OrderPayload {
  type?: "INSERT" | "UPDATE";
  table?: string;
  record?: OrderRecord;
  items?: OrderItem[];
}

const AGENTMAIL_API_KEY = Deno.env.get("AGENTMAIL_API_KEY") || "";
const AGENTMAIL_INBOX = Deno.env.get("AGENTMAIL_INBOX") || "afterimage@agentmail.to";
const OFFICE_EMAIL = Deno.env.get("OFFICE_EMAIL") || "orders@nativeson.com";
const SUPABASE_URL = Deno.env.get("SUPABASE_URL") || "https://ruwyfesblmaurfuiaofw.supabase.co";
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";

const fmt = (n: number) => (typeof n === "number" ? n.toFixed(2) : "0.00");
const esc = (s: string) => String(s == null ? "" : s)
  .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
  .replace(/"/g, "&quot;").replace(/'/g, "&#39;");

function buildEmail(o: OrderRecord, items: OrderItem[], toCustomer: boolean): { subject: string; html: string; text: string } {
  const itemRows = items.map(i =>
    `<tr>
      <td style="padding:8px 12px; border-bottom:1px solid #e3dccb;">${esc(i.plant_name)}</td>
      <td style="padding:8px 12px; border-bottom:1px solid #e3dccb; color:#666;">${esc(i.plant_size || "—")}</td>
      <td style="padding:8px 12px; border-bottom:1px solid #e3dccb; text-align:right;">${i.qty}</td>
      <td style="padding:8px 12px; border-bottom:1px solid #e3dccb; text-align:right;">$${fmt(i.unit_price)}</td>
      <td style="padding:8px 12px; border-bottom:1px solid #e3dccb; text-align:right; font-weight:600;">$${fmt(i.line_total)}</td>
    </tr>`
  ).join("");

  const subject = toCustomer
    ? `Order ${o.order_number} received — Native Sons`
    : `New order ${o.order_number} from ${o.customer_name}`;

  const intro = toCustomer
    ? `<p>Hi ${esc(o.customer_name.split(" ")[0])} — we've received your order request. Our team will review availability and reach out to confirm pricing, pickup/delivery, and timing.</p>`
    : `<p><strong>${esc(o.customer_name)}</strong> just placed an order via the website.</p>`;

  const html = `
    <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; max-width: 640px; margin: 0 auto; color: #1f2a1c;">
      <div style="background: #2d4a2b; color: white; padding: 24px; border-radius: 8px 8px 0 0;">
        <h1 style="margin:0; font-size: 22px; font-weight: 600;">Native Sons Wholesale Nursery</h1>
        <p style="margin: 4px 0 0; opacity: 0.85; font-size: 14px;">Order ${esc(o.order_number)}</p>
      </div>
      <div style="background: #f7f4ec; padding: 24px; border: 1px solid #e3dccb; border-top: 0;">
        ${intro}
        <table style="width:100%; border-collapse:collapse; margin: 20px 0; background: white; border: 1px solid #e3dccb; border-radius: 8px; overflow: hidden;">
          <thead>
            <tr style="background:#efe9da; color: #2d4a2b; font-size: 11px; text-transform: uppercase; letter-spacing: 0.05em;">
              <th style="padding:10px 12px; text-align:left;">Plant</th>
              <th style="padding:10px 12px; text-align:left;">Size</th>
              <th style="padding:10px 12px; text-align:right;">Qty</th>
              <th style="padding:10px 12px; text-align:right;">Unit</th>
              <th style="padding:10px 12px; text-align:right;">Line</th>
            </tr>
          </thead>
          <tbody>${itemRows}</tbody>
          <tfoot>
            <tr style="background: #efe9da;">
              <td colspan="4" style="padding: 12px; text-align: right; font-weight: 600;">Subtotal</td>
              <td style="padding: 12px; text-align: right; font-weight: 700; font-size: 18px; color: #2d4a2b;">$${fmt(o.subtotal)}</td>
            </tr>
          </tfoot>
        </table>
        <table style="width:100%; font-size: 14px; color: #4a5546;">
          <tr><td style="padding:4px 0; width:120px;"><strong>Name</strong></td><td>${esc(o.customer_name)}</td></tr>
          <tr><td style="padding:4px 0;"><strong>Email</strong></td><td><a href="mailto:${esc(o.customer_email)}" style="color:#2d4a2b;">${esc(o.customer_email)}</a></td></tr>
          ${o.customer_phone ? `<tr><td style="padding:4px 0;"><strong>Phone</strong></td><td><a href="tel:${esc(o.customer_phone)}" style="color:#2d4a2b;">${esc(o.customer_phone)}</a></td></tr>` : ""}
          ${o.customer_company ? `<tr><td style="padding:4px 0;"><strong>Company</strong></td><td>${esc(o.customer_company)}</td></tr>` : ""}
          ${o.notes ? `<tr><td style="padding:4px 0; vertical-align: top;"><strong>Notes</strong></td><td style="white-space: pre-wrap;">${esc(o.notes)}</td></tr>` : ""}
        </table>
        ${toCustomer
          ? `<p style="margin-top:24px; font-size:14px; color:#4a5546;">Questions? Call 805.481.5996 or reply to this email.</p>
             <p style="font-size:12px; color:#8a8a7c; margin-top:24px;">Availability is updated weekly. Quantities are not held until confirmed by our office.</p>`
          : `<p style="margin-top:24px;"><a href="${SUPABASE_URL}/editor" style="background:#2d4a2b; color:white; padding:10px 20px; border-radius:6px; text-decoration:none; font-weight:600;">View in admin →</a></p>`
        }
      </div>
    </div>
  `;

  const text = [
    `Order ${o.order_number}`,
    ``,
    toCustomer ? `Hi ${o.customer_name.split(" ")[0]} — we received your order request.` : `New order from ${o.customer_name}.`,
    ``,
    `Items:`,
    ...items.map(i => `  - ${i.plant_name}${i.plant_size ? ` (${i.plant_size})` : ""} × ${i.qty} = $${fmt(i.line_total)}`),
    ``,
    `Subtotal: $${fmt(o.subtotal)}`,
    ``,
    `Name: ${o.customer_name}`,
    `Email: ${o.customer_email}`,
    o.customer_phone ? `Phone: ${o.customer_phone}` : null,
    o.customer_company ? `Company: ${o.customer_company}` : null,
    o.notes ? `Notes: ${o.notes}` : null,
  ].filter(Boolean).join("\n");

  return { subject, html, text };
}

async function sendEmail(to: string, subject: string, html: string, text: string): Promise<void> {
  if (!AGENTMAIL_API_KEY) {
    throw new Error("AGENTMAIL_API_KEY secret is not set");
  }

  const res = await fetch(
    `https://api.agentmail.to/v0/inboxes/${encodeURIComponent(AGENTMAIL_INBOX)}/messages/send`,
    {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${AGENTMAIL_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        to,
        subject,
        html,
        text,
      }),
    }
  );

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`AgentMail API error ${res.status}: ${body}`);
  }
}

// CORS — allow the GitHub Pages origin to call this function.
// The preflight (OPTIONS) and the actual POST both need these headers,
// otherwise the browser silently rejects the request.
const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

// @ts-ignore
Deno.serve(async (req: Request) => {
  // Handle preflight
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }
  if (req.method !== "POST") {
    return new Response("Method not allowed", { status: 405, headers: CORS_HEADERS });
  }

  let payload: OrderPayload;
  try {
    payload = await req.json();
  } catch (e) {
    return new Response("Invalid JSON", { status: 400 });
  }

  const order = payload.record;
  if (!order) {
    return new Response("Missing record in payload", { status: 400 });
  }

  // If items weren't passed in, fetch them via service role
  let items = payload.items;
  if (!items) {
    if (!SUPABASE_SERVICE_ROLE_KEY) {
      return new Response("Missing items and SUPABASE_SERVICE_ROLE_KEY", { status: 500 });
    }
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/order_items?order_id=eq.${order.id}`,
      { headers: { apikey: SUPABASE_SERVICE_ROLE_KEY, authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}` } }
    );
    if (!res.ok) {
      return new Response(`Failed to fetch items: ${res.status}`, { status: 500 });
    }
    items = await res.json();
  }

  const results: { to: string; ok: boolean; error?: string }[] = [];

  // TEMPORARY: allow browser to override office email for deliverability debug.
  const officeRecipient = payload.debugOfficeEmail || OFFICE_EMAIL;

  // 1. Office email
  try {
    const office = buildEmail(order, items, false);
    await sendEmail(officeRecipient, office.subject, office.html, office.text);
    results.push({ to: officeRecipient, ok: true });
  } catch (err) {
    const msg = String(err);
    console.error(`Office email failed:`, msg);
    results.push({ to: officeRecipient, ok: false, error: msg });
  }

  // 2. Customer email
  try {
    const customer = buildEmail(order, items, true);
    await sendEmail(order.customer_email, customer.subject, customer.html, customer.text);
    results.push({ to: order.customer_email, ok: true });
  } catch (err) {
    const msg = String(err);
    console.error(`Customer email failed:`, msg);
    results.push({ to: order.customer_email, ok: false, error: msg });
  }

  const allOk = results.every(r => r.ok);
  return new Response(
    JSON.stringify({ ok: allOk, results }),
    {
      status: allOk ? 200 : 207, // 207 Multi-Status if one failed
      headers: { "Content-Type": "application/json", ...CORS_HEADERS },
    }
  );
});
