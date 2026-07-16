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

  // Build per-item plain-text and per-item Block Kit fields.
  const itemTextLines: string[] = [];
  const itemBlocks: any[] = [];
  items.forEach((i, idx) => {
    const soFlag = i.special_order ? " • SPECIAL" : "";
    const sz = i.plant_size ? ` (${i.plant_size})` : "";
    const retailUnit = i.retail_unit_price ?? i.retail_price;
    const lineHasMarkup = retailUnit != null && Number(retailUnit) > Number(i.unit_price);
    const effectiveMultiplier = i.retail_multiplier
      ?? (i.retail_mode === 'markup' && Number(i.unit_price) > 0
          ? Number(retailUnit) / Number(i.unit_price)
          : null);
    // Markup-on-but-zero: retailer set markup mode but applied no actual markup.
    // Flag so staff can spot accidental no-op markups.
    const markupModeButZero = !lineHasMarkup
      && showRetail && !internalOrder
      && i.retail_mode === 'markup'
      && effectiveMultiplier !== null;

    // Plain-text line (used for the fallback `text` field and for SMS / mobile)
    let pricePortion: string;
    if (lineHasMarkup && showRetail && !internalOrder) {
      pricePortion =
        ` — ~~$${fmt(i.unit_price)} ea = $${fmt(i.line_total)}~~` +
        ` → $${fmt(Number(retailUnit))} ea = $${fmt(Number(i.retail_line_total))}` +
        (effectiveMultiplier ? ` (×${fmt(effectiveMultiplier)})` : '');
    } else if (markupModeButZero) {
      pricePortion =
        ` — ~~$${fmt(i.unit_price)} ea = $${fmt(i.line_total)}~~` +
        ` → $${fmt(Number(i.unit_price))} ea = $${fmt(i.line_total)}` +
        ` (×1.00 — no markup applied)`;
    } else {
      pricePortion = ` — $${fmt(i.unit_price)} ea = $${fmt(i.line_total)}`;
    }
    const codeTag = i.item_code ? ` [${i.item_code}]` : "";
    const upcTag = i.upc ? ` · UPC ${i.upc}` : "";
    itemTextLines.push(
      `${idx + 1}. ${i.plant_name}${sz}${codeTag} ×${i.qty}${pricePortion}${upcTag}${soFlag}`
    );

    // Block Kit section: 2-column fields.
    //   Left:  "**Name** (size)" + "qty ×N" subtext
    //   Right: "$X.XX ea / $Y.YY total" + (if markup) "retail $Z.ZZ ea" subtext
    // Numbered prefix shown via emoji "1." "2." to keep the section block
    // free to render side-by-side fields cleanly.
    const numEmoji = `${idx + 1}\u20e3`;  // 1️⃣ 2️⃣ 3️⃣ ...
    const nameLine = `*${i.plant_name}${sz}*${i.special_order ? "  •SPECIAL" : ""}`;
    const qtyLine = `_Qty: ${i.qty}${i.item_code ? `  ·  ${i.item_code}` : ""}${i.upc ? `  ·  UPC ${i.upc}` : ""}_`;
    const fields: { type: string; text: string }[] = [
      { type: "mrkdwn", text: `${numEmoji}  ${nameLine}\n${qtyLine}` },
    ];
    if (lineHasMarkup && showRetail && !internalOrder) {
      fields.push({
        type: "mrkdwn",
        text: `*$${fmt(Number(retailUnit))} ea  →  $${fmt(Number(i.retail_line_total))}*\n_Wholesale: ~~$${fmt(i.unit_price)}~~ → $${fmt(i.line_total)}_`,
      });
    } else if (markupModeButZero) {
      fields.push({
        type: "mrkdwn",
        text: `*$${fmt(i.unit_price)} ea  →  $${fmt(i.line_total)}*\n_⚠️ markup mode ×1.00 — no markup applied_`,
      });
    } else {
      fields.push({
        type: "mrkdwn",
        text: `*$${fmt(i.unit_price)} ea  →  $${fmt(i.line_total)}*\n_${i.qty} units_`,
      });
    }
    itemBlocks.push({ type: "section", fields });
    // Divider between items for visual rhythm (skip after last)
    if (idx < items.length - 1) itemBlocks.push({ type: "divider" });
  });

  // Compact plain-text fallback body — used in notification previews,
  // SMS, and any Slack client that doesn't render blocks.
  const textLines = [
    `${o.order_number} — ${o.customer_name}${o.customer_company ? ` (${o.customer_company})` : ""}`,
    [o.customer_email, o.customer_phone].filter(Boolean).join(" · "),
    ...itemTextLines,
    (showRetail && hasAnyMarkup && !internalOrder)
      ? `${items.length} plants · ${totalUnits} units · $${fmt(totalWholesale)} wholesale → $${fmt(totalRetail)} retail` + (specialCount > 0 ? ` · ★ ${specialCount} special` : "")
      : `${items.length} plants · ${totalUnits} units · $${fmt(totalWholesale)}` + (specialCount > 0 ? ` · ★ ${specialCount} special` : ""),
    o.notes ? `Notes: ${o.notes}` : null,
  ].filter(Boolean) as string[];
  const text = textLines.join("\n");

  // Block Kit assembly
  const headerBlock = {
    type: "header",
    text: {
      type: "plain_text",
      text: `${o.order_number} — ${o.customer_name}`,
      emoji: true,
    },
  };

  const contactLine = [o.customer_email, o.customer_phone].filter(Boolean).join("  ·  ") || "—";

  const blocks: any[] = [headerBlock];

  // Customer block: company (if any) + contact line, two-column fields
  if (o.customer_company) {
    blocks.push({
      type: "section",
      fields: [
        { type: "mrkdwn", text: `*Company*\n${o.customer_company}` },
        { type: "mrkdwn", text: `*Contact*\n${contactLine}` },
      ],
    });
  } else {
    blocks.push({
      type: "section",
      text: { type: "mrkdwn", text: `*Contact:*  ${contactLine}` },
    });
  }

  // Divider before item list
  blocks.push({ type: "divider" });

  // Per-item sections (each is its own block — Slack handles long lists fine
  // as long as the total block count stays under 50, which is a 50-item order
  // max and well above realistic order sizes).
  blocks.push(...itemBlocks);

  // Totals footer — single context block with the summary line.
  // For external orders with markup: split wholesale (struck) and retail.
  // For internal orders or no markup: just wholesale.
  const footerText = (showRetail && hasAnyMarkup && !internalOrder)
    ? `*${items.length} plants*  ·  ${totalUnits} units  ·  ~$${fmt(totalWholesale)}~  →  *$${fmt(totalRetail)} retail*${specialCount > 0 ? `  ·  ★ ${specialCount} special` : ""}`
    : `*${items.length} plants*  ·  ${totalUnits} units  ·  *$${fmt(totalWholesale)}*${specialCount > 0 ? `  ·  ★ ${specialCount} special` : ""}`;
  blocks.push({ type: "divider" });
  blocks.push({
    type: "section",
    text: { type: "mrkdwn", text: footerText },
  });

  if (o.notes) {
    blocks.push({
      type: "context",
      elements: [{ type: "mrkdwn", text: `📝 ${o.notes}` }],
    });
  }

  // Action buttons: link back to the admin panel for this order.
  blocks.push({
    type: "actions",
    elements: [
      {
        type: "button",
        text: { type: "plain_text", text: "Open in Admin Panel", emoji: true },
        url: `${ADMIN_URL}?order=${encodeURIComponent(o.order_number)}`,
        style: "primary",
      },
    ],
  });

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
