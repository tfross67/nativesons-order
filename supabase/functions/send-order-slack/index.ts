// Supabase Edge Function: send-order-slack
// Invoked from admin.html when the office clicks "Send to Slack".
//
// Posts the order to a Slack channel via an incoming webhook URL.
//
// Required secrets (set via `supabase secrets set`):
//   SLACK_WEBHOOK_URL=https://hooks.slack.com/services/...
//
// Deploy:
//   supabase functions deploy send-order-slack --no-verify-jwt
//   supabase secrets set SLACK_WEBHOOK_URL=https://hooks.slack.com/services/T.../B.../...

interface OrderItem {
  plant_key: string;
  plant_name: string;
  plant_size: string | null;
  unit_price: number;
  qty: number;
  line_total: number;
  retail_unit_price: number | null;
  retail_price: number | null;
  retail_line_total: number | null;
  item_code: string | null;
  upc: string | null;
  special_order?: boolean;
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
  record?: OrderRecord;
  items?: OrderItem[];
  // True when this order was entered through office.html (the internal
  // portal). Slack messages for internal orders suppress retail totals —
  // staff don't need to see retail math for orders they entered on the
  // phone or in person.
  internal_order?: boolean;
}

const SLACK_WEBHOOK_URL = Deno.env.get("SLACK_WEBHOOK_URL") || "";
const SUPABASE_URL = Deno.env.get("SUPABASE_URL") || "https://ruwyfesblmaurfuiaofw.supabase.co";
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
const ADMIN_URL = Deno.env.get("ADMIN_URL") || "https://tfross67.github.io/nativesons-order/admin.html";
// Where the function appends each send. Used to detect duplicates from double-clicks.
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY") || "";

const fmt = (n: number) => (typeof n === "number" ? n.toFixed(2) : "0.00");

function buildSlackBlocks(o: OrderRecord, items: OrderItem[], internalOrder = false) {
  // Only count retail toward totals when there's an actual markup on that line.
  // (Some lines have retail_unit_price set equal to wholesale — no markup — and
  // those should NOT inflate the retail total.)
  const hasMarkup = (i: OrderItem) => {
    const ru = i.retail_unit_price ?? i.retail_price;
    return ru != null && Number(ru) > Number(i.unit_price);
  };
  // Internal orders entered via office.html suppress ALL retail math —
  // staff don't need retail totals for orders they take on the phone.
  const showRetail = !internalOrder;
  const totalWholesale = items.reduce((s, i) => s + Number(i.line_total || 0), 0);
  const totalRetail = items.reduce(
    (s, i) => s + (hasMarkup(i) ? Number(i.retail_line_total || 0) : 0),
    0
  );
  const hasAnyMarkup = items.some(hasMarkup);
  const totalUnits = items.reduce((s, i) => s + (i.qty || 0), 0);
  const specialCount = items.filter(i => i.special_order).length;

  // Build a Slack-flavored text version of the order (used as fallback when
  // the channel doesn't render blocks — e.g. notifications, classic Slack).
  const text = [
    `*New order ${o.order_number}* — ${o.customer_name}`,
    `Items: ${items.length} plants, ${totalUnits} units` +
      (hasAnyMarkup ? `, retail $${fmt(totalRetail)}` : `, wholesale $${fmt(totalWholesale)}`),
    o.notes ? `Notes: ${o.notes}` : null,
  ].filter(Boolean).join("\n");

  // Compact layout — every section uses small plain_text to render ~25% smaller
  // than the default mrkdwn blocks. mrkdwn text is rendered at body size by
  // default and there's no way to shrink it; plain_text blocks support
  // size: "small". Drop the bold-header emoji line and bake the customer info
  // into a single one-line summary.

  // Line 1: order # + customer (bold, default size — important to spot)
  const headerSection = {
    type: "section",
    text: {
      type: "mrkdwn",
      text: `*${o.order_number}* — ${o.customer_name}${o.customer_company ? ` (${o.customer_company})` : ""}`,
    },
  };

  // Line 2: contact info, small
  const contactLine = [
    o.customer_email || null,
    o.customer_phone || null,
  ].filter(Boolean).join(" · ") || "—";
  const contactSection = {
    type: "section",
    text: { type: "plain_text", text: contactLine, emoji: true, size: "small" as const },
  };

  // Item lines — small plain_text, one plant per line, no fancy formatting
  const itemLines = items.map((i, idx) => {
    const soFlag = i.special_order ? " • SPECIAL" : "";
    const sz = i.plant_size ? ` (${i.plant_size})` : "";
    const wholesale = `$${fmt(i.unit_price)} ea = $${fmt(i.line_total)}`;
    const retailUnit = i.retail_unit_price ?? i.retail_price;
    const lineHasMarkup = retailUnit != null && Number(retailUnit) > Number(i.unit_price);
    const retail = (showRetail && lineHasMarkup) ? ` (retail $${fmt(Number(retailUnit))})` : "";
    return `${idx + 1}. ${i.plant_name}${sz} ×${i.qty} — ${wholesale}${retail}${soFlag}`;
  }).join("\n");

  // If the order has more than 25 items, split sections (Slack limit).
  const itemsSectionBlocks = [];
  const MAX_FIELD_LEN = 2900;
  let buffer = "";
  const chunks = [];
  for (const line of itemLines.split("\n")) {
    if (buffer.length + line.length + 2 > MAX_FIELD_LEN && buffer) {
      chunks.push(buffer);
      buffer = "";
    }
    buffer += (buffer ? "\n" : "") + line;
  }
  if (buffer) chunks.push(buffer);

  for (const chunk of chunks) {
    itemsSectionBlocks.push({
      type: "section",
      text: { type: "plain_text", text: chunk, emoji: true, size: "small" as const },
    });
  }

  // Totals footer — small
  const totalLines = [
    `${items.length} plants · ${totalUnits} units · $${fmt(totalWholesale)}` + (showRetail && hasAnyMarkup ? ` (retail $${fmt(totalRetail)})` : ""),
    specialCount > 0 ? `★ ${specialCount} special` : null,
  ].filter(Boolean).join(" · ");

  const totalsSection = {
    type: "section",
    text: { type: "plain_text", text: totalLines, emoji: true, size: "small" as const },
  };

  // Notes section (if any) — small
  const notesSection = o.notes ? {
    type: "section",
    text: { type: "plain_text", text: `Notes: ${o.notes}`, emoji: true, size: "small" as const },
  } : null;

  const blocks: any[] = [headerSection, contactSection];
  if (notesSection) blocks.push(notesSection);
  blocks.push(...itemsSectionBlocks, totalsSection);

  return { text, blocks };
}

async function sendToSlack(webhookUrl: string, body: { text: string; blocks: any[] }): Promise<void> {
  const res = await fetch(webhookUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const errBody = await res.text();
    throw new Error(`Slack API error ${res.status}: ${errBody}`);
  }
}

async function logSend(orderId: string, orderNumber: string, ok: boolean, error?: string) {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) return;
  try {
    await fetch(`${SUPABASE_URL}/rest/v1/slack_log`, {
      method: "POST",
      headers: {
        "apikey": SUPABASE_SERVICE_ROLE_KEY,
        "authorization": `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        order_id: orderId,
        order_number: orderNumber,
        ok,
        error_message: error || null,
        sent_at: new Date().toISOString(),
      }),
    });
  } catch (e) {
    console.error("Failed to write slack_log row:", String(e));
  }
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

  if (!SLACK_WEBHOOK_URL) {
    return new Response(
      JSON.stringify({ ok: false, error: "SLACK_WEBHOOK_URL secret is not set" }),
      { status: 500, headers: { "Content-Type": "application/json", ...CORS_HEADERS } }
    );
  }

  let payload: OrderPayload;
  try {
    payload = await req.json();
  } catch (e) {
    return new Response("Invalid JSON", { status: 400, headers: CORS_HEADERS });
  }

  const order = payload.record;
  if (!order) {
    return new Response(
      JSON.stringify({ ok: false, error: "Missing record in payload" }),
      { status: 400, headers: { "Content-Type": "application/json", ...CORS_HEADERS } }
    );
  }

  let items = payload.items;
  if (!items) {
    if (!SUPABASE_SERVICE_ROLE_KEY) {
      return new Response(
        JSON.stringify({ ok: false, error: "Missing items and SUPABASE_SERVICE_ROLE_KEY" }),
        { status: 500, headers: { "Content-Type": "application/json", ...CORS_HEADERS } }
      );
    }
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/order_items?order_id=eq.${order.id}`,
      { headers: { apikey: SUPABASE_SERVICE_ROLE_KEY, authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}` } }
    );
    if (!res.ok) {
      return new Response(
        JSON.stringify({ ok: false, error: `Failed to fetch items: ${res.status}` }),
        { status: 500, headers: { "Content-Type": "application/json", ...CORS_HEADERS } }
      );
    }
    items = await res.json();
  }

  try {
    const msg = buildSlackBlocks(order, items, !!payload.internal_order);
    await sendToSlack(SLACK_WEBHOOK_URL, msg);
    await logSend(order.id, order.order_number, true);
    return new Response(
      JSON.stringify({ ok: true, channel: "slack" }),
      { status: 200, headers: { "Content-Type": "application/json", ...CORS_HEADERS } }
    );
  } catch (err) {
    const msg = String(err);
    console.error("Slack send failed:", msg);
    await logSend(order.id, order.order_number, false, msg);
    return new Response(
      JSON.stringify({ ok: false, error: msg }),
      { status: 502, headers: { "Content-Type": "application/json", ...CORS_HEADERS } }
    );
  }
});
