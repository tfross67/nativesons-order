// Supabase Edge Function: search-analytics-summary
// Returns aggregated search analytics for the admin dashboard.
// Reads from search_analytics table using the service role key
// (anon can't SELECT due to RLS).
//
// Required secrets:
//   SUPABASE_URL (auto-set by Supabase)
//   SUPABASE_SERVICE_ROLE_KEY (auto-set by Supabase)
//
// Deploy:
//   supabase functions deploy search-analytics-summary --project-ref ruwyfesblmaurfuiaofw --no-verify-jwt

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") || "https://ruwyfesblmaurfuiaofw.supabase.co";
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

// Admin gate — only callable from admin.html (which has its own auth check).
// The service role key is sufficient on its own; we don't add a separate
// password because the admin page is already behind the password gate.
const ALLOWED_ORIGINS = (Deno.env.get("ALLOWED_ORIGINS") ||
  "https://tfross67.github.io,https://nativeson.com,https://www.nativeson.com")
  .split(",").map(s => s.trim()).filter(Boolean);

function originAllowed(req: Request): boolean {
  const origin = (req.headers.get("origin") || "").trim();
  const referer = (req.headers.get("referer") || "").trim();
  if (!origin && !referer) return false;
  return ALLOWED_ORIGINS.some(prefix =>
    origin.startsWith(prefix) || referer.startsWith(prefix));
}

interface AnalyticsRequest {
  range_days?: number;       // default 7
  include_queries?: boolean; // default false (top queries can leak customer intent)
}

async function queryView(view: string, rangeDays: number): Promise<any[]> {
  const since = new Date(Date.now() - rangeDays * 24 * 60 * 60 * 1000).toISOString();
  const url = `${SUPABASE_URL}/rest/v1/${view}?select=*&day=gte.${since}&order=day.desc&limit=${rangeDays}`;
  const res = await fetch(url, {
    headers: {
      "apikey": SUPABASE_SERVICE_ROLE_KEY,
      "Authorization": `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
    },
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Rest query failed for ${view}: ${res.status} ${body.slice(0, 200)}`);
  }
  return await res.json();
}

async function queryTable(table: string, select: string, rangeDays: number, limit: number, dateColumn: string = 'ts'): Promise<any[]> {
  const since = new Date(Date.now() - rangeDays * 24 * 60 * 60 * 1000).toISOString();
  const url = `${SUPABASE_URL}/rest/v1/${table}?select=${select}&${dateColumn}=gte.${since}&order=${dateColumn}.desc&limit=${limit}`;
  const res = await fetch(url, {
    headers: {
      "apikey": SUPABASE_SERVICE_ROLE_KEY,
      "Authorization": `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
    },
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Rest query failed for ${table}: ${res.status} ${body.slice(0, 200)}`);
  }
  return await res.json();
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
  if (!SUPABASE_SERVICE_ROLE_KEY) {
    return new Response(
      JSON.stringify({ ok: false, error: "SUPABASE_SERVICE_ROLE_KEY secret is not set" }),
      { status: 500, headers: { "Content-Type": "application/json", ...CORS_HEADERS } }
    );
  }

  let payload: AnalyticsRequest = {};
  try {
    payload = await req.json();
  } catch (e) {
    // Empty body is OK — use defaults
  }

  const rangeDays = Math.min(Math.max(payload.range_days ?? 7, 1), 90);
  const includeQueries = payload.include_queries ?? false;

  try {
    const daily = await queryView("search_analytics_daily", rangeDays);
    const result: any = {
      ok: true,
      range_days: rangeDays,
      daily,
    };

    if (includeQueries) {
      const topQueries = await queryTable(
        "search_analytics_top_queries",
        "query,search_count,avg_results,last_seen",
        rangeDays, 100, "last_seen"
      );
      const failedQueries = await queryTable(
        "search_analytics_failed_queries",
        "query,failure_count,last_seen",
        rangeDays, 50, "last_seen"
      );
      result.top_queries = topQueries;
      result.failed_queries = failedQueries;
    }

    return new Response(JSON.stringify(result), {
      status: 200,
      headers: { "Content-Type": "application/json", ...CORS_HEADERS },
    });
  } catch (e) {
    return new Response(
      JSON.stringify({ ok: false, error: String(e) }),
      { status: 502, headers: { "Content-Type": "application/json", ...CORS_HEADERS } }
    );
  }
});
