// Supabase Edge Function: jev-classify
// Proxy for the TypeSafe / Jev System One API. The Typesafe API key lives
// ONLY in this function's env (set via `supabase secrets set TYPESAFE_API_KEY=...`)
// — it never reaches the browser. The browser sends a free-text query, this
// function asks Jev to map it to structured filter categories, and returns
// the structured answer.
//
// Required secrets:
//   TYPESAFE_API_KEY=ts_xxx     — the API key from your TypeSafe console
//
// Deploy:
//   supabase functions deploy jev-classify --project-ref ruwyfesblmaurfuiaofw --no-verify-jwt
//   supabase secrets set TYPESAFE_API_KEY=ts_...

const TYPESAFE_API_KEY = Deno.env.get("TYPESAFE_API_KEY") || "";
const TYPESAFE_MODEL = Deno.env.get("TYPESAFE_MODEL") || "jev-latest";
const TYPESAFE_URL = "https://api.typesafe.ai/v1/systemone";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

// Same origin gate as send-order-email/send-order-slack — anon key is public
// in chat-search.html, so curl attackers can fake requests. The origin/referer
// must match a known Native Sons domain.
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

function buildState(rawQuery: string) {
  return {
    query: rawQuery,
    catalog: {
      colors:    ['red', 'pink', 'white', 'yellow', 'blue', 'purple', 'orange', 'green'],
      exposures: ['full sun', 'partial shade', 'shade'],
      water:     ['low', 'moderate', 'high'],
      types:     ['shrub', 'grass', 'fern', 'palm', 'succulent', 'perennial', 'tree'],
      containers:['1gal', '5gal', '15gal', '4in', '2gal', '7gal', '20inch'],
      height_bands: ['under 1 foot', '1 to 2 feet', '2 to 4 feet', 'over 4 feet'],
      boolean_flags: ['in bloom now', 'budding', 'pollinator friendly'],
      origins:   ['California native', 'Oregon native', 'regional native'],
    },
  };
}

function buildQuestions() {
  // One Choice question per category. Each has a 'none' fallback so Jev can
  // say "no filter expressed" rather than guessing. JSON criteria help Jev
  // tell similar options apart (yellow=color vs. yellow=highlight).
  return {
    // Noul first: gates whether to attempt plant-name matching at all.
    is_plant_name: {
      type: 'noul',
      instructions: 'Does this query name a specific plant (genus, species, cultivar, or common name)?',
      criteria: {
        true: 'Query names a plant the user is looking for',
        false: 'Query describes attributes (color, size, water) without naming a plant',
      },
    },
    colors: {
      type: 'choice',
      instructions: 'Which flower color (if any) does the user ask about?',
      criteria: {
        red:    { what: 'red, scarlet, crimson, burgundy, rose, magenta', not_for: 'pink or orange' },
        pink:   { what: 'pink, rose-pink, blush', not_for: 'red or magenta' },
        white:  { what: 'white, cream, ivory, pale' },
        yellow: { what: 'yellow, gold, golden', not_for: 'orange' },
        blue:   { what: 'blue, sky blue, powder blue, cobalt, violet' },
        purple: { what: 'purple, lavender, lilac' },
        orange: { what: 'orange, tangerine, apricot' },
        green:  { what: 'green, chartreuse' },
        none:   { what: 'no color filter expressed' },
      },
    },
    exposures: {
      type: 'choice',
      instructions: 'Which sun exposure (if any) does the user ask about?',
      criteria: {
        'full sun':      { what: 'full sun, sun, sunny spots' },
        'partial shade': { what: 'partial shade, part shade, part sun, dappled' },
        'shade':         { what: 'full shade, deep shade' },
        none:            { what: 'no exposure filter expressed' },
      },
    },
    water: {
      type: 'choice',
      instructions: 'Which water need (if any) does the user express?',
      criteria: {
        low:      { what: 'low water, drought tolerant, xeric, dry, low irrigation' },
        moderate: { what: 'moderate water, regular water, medium irrigation' },
        high:     { what: 'high water, moist, wet, boggy' },
        none:     { what: 'no water filter expressed' },
      },
    },
    types: {
      type: 'choice',
      instructions: 'Which plant type (if any) does the user ask about?',
      criteria: {
        shrub:      { what: 'shrub, bush' },
        grass:      { what: 'grass, sedge, ornamental grass' },
        fern:       { what: 'fern' },
        palm:       { what: 'palm' },
        succulent:  { what: 'succulent, agave, yucca' },
        perennial:  { what: 'perennial, flower' },
        tree:       { what: 'tree' },
        none:       { what: 'no plant-type filter expressed' },
      },
    },
    container: {
      type: 'choice',
      instructions: 'Which pot/container size (if any) does the user ask about?',
      criteria: {
        '1gal':  { what: 'one gallon pot' },
        '5gal':  { what: 'five gallon pot' },
        '15gal': { what: 'fifteen gallon pot' },
        '4in':   { what: 'four inch pot, 4 inch pot' },
        '2gal':  { what: 'two gallon pot' },
        '7gal':  { what: 'seven gallon pot' },
        '20inch':{ what: '20 inch box' },
        none:    { what: 'no container filter expressed' },
      },
    },
    height_band: {
      type: 'choice',
      instructions: 'Which mature height band (if any) does the user express?',
      criteria: {
        under1: { what: 'under 1 foot tall' },
        '1to2': { what: '1 to 2 feet tall' },
        '2to4': { what: '2 to 4 feet tall' },
        over4:  { what: 'over 4 feet tall' },
        none:   { what: 'no height filter expressed' },
      },
    },
    in_bloom: {
      type: 'choice',
      instructions: 'Does the user ask for plants currently in bloom?',
      criteria: {
        yes: { what: 'user asks for blooming or flowering plants now' },
        no:  { what: 'user does not ask about current bloom status' },
      },
    },
    budding: {
      type: 'choice',
      instructions: 'Does the user ask for plants with buds forming?',
      criteria: {
        yes: { what: 'user asks for plants with buds or budding' },
        no:  { what: 'user does not ask about buds' },
      },
    },
    pollinator: {
      type: 'choice',
      instructions: 'Does the user ask for pollinator-friendly plants?',
      criteria: {
        yes: { what: 'user mentions pollinators, bees, butterflies, hummingbirds' },
        no:  { what: 'user does not ask about pollinators' },
      },
    },
    origin: {
      type: 'choice',
      instructions: 'Which geographic origin (if any) does the user ask about?',
      criteria: {
        california: { what: 'California native plants' },
        oregon:     { what: 'Oregon native plants' },
        regional:   { what: 'regional or West Coast native plants' },
        none:       { what: 'no origin filter expressed' },
      },
    },
  };
}

// Map Jev's answer shape to the parseQuery() filter shape, exactly mirroring
// the client-side answersToFilters() in typesafe-client.js. Keep these in
// sync if you add or rename categories.
function answersToFilters(answers: Record<string, any>): Record<string, any> | null {
  const out: Record<string, any> = {
    colors: [], exposures: [], water: [], types: [], container: [],
    origin: [], heightBand: null, inBloom: false, budding: false, pollinator: false,
    isPlantName: false,
  };
  let anySignal = false;
  for (const [id, ans] of Object.entries(answers || {})) {
    if (!ans) continue;
    const v = ans.choice !== undefined ? ans.choice : (ans.noul !== undefined ? ans.noul : null);
    if (v === null) continue;
    switch (id) {
      case 'is_plant_name': if (v === true || v === 'true' || v >= 0.7) { out.isPlantName = true; anySignal = true; } break;
      case 'colors':     if (v !== 'none') { out.colors.push(v); anySignal = true; } break;
      case 'exposures':  if (v !== 'none') { out.exposures.push(v); anySignal = true; } break;
      case 'water':      if (v !== 'none') { out.water.push(v); anySignal = true; } break;
      case 'types':      if (v !== 'none') { out.types.push(v); anySignal = true; } break;
      case 'container':  if (v !== 'none') { out.container.push(v); anySignal = true; } break;
      case 'origin':     if (v !== 'none') { out.origin.push(v); anySignal = true; } break;
      case 'height_band':if (v !== 'none') { out.heightBand = v; anySignal = true; } break;
      case 'in_bloom':   if (v === 'yes') { out.inBloom = true; anySignal = true; } break;
      case 'budding':    if (v === 'yes') { out.budding = true; anySignal = true; } break;
      case 'pollinator': if (v === 'yes') { out.pollinator = true; anySignal = true; } break;
    }
  }
  return anySignal ? out : null;
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
  if (!TYPESAFE_API_KEY) {
    return new Response(
      JSON.stringify({ ok: false, error: "TYPESAFE_API_KEY secret is not set" }),
      { status: 500, headers: { "Content-Type": "application/json", ...CORS_HEADERS } }
    );
  }

  let payload: { query?: string };
  try {
    payload = await req.json();
  } catch (e) {
    return new Response("Invalid JSON", { status: 400, headers: CORS_HEADERS });
  }

  const rawQuery = String(payload.query || "").trim();
  if (!rawQuery) {
    return new Response(
      JSON.stringify({ ok: true, answers: {} }),
      { status: 200, headers: { "Content-Type": "application/json", ...CORS_HEADERS } }
    );
  }
  // Hard cap input length so a curl attacker can't blow up our Jev quota.
  if (rawQuery.length > 500) {
    return new Response(
      JSON.stringify({ ok: false, error: "Query too long" }),
      { status: 400, headers: { "Content-Type": "application/json", ...CORS_HEADERS } }
    );
  }

  let jevRes: Response;
  try {
    jevRes = await fetch(TYPESAFE_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${TYPESAFE_API_KEY}`,
      },
      body: JSON.stringify({
        model: TYPESAFE_MODEL,
        state: buildState(rawQuery),
        questions: buildQuestions(),
      }),
    });
  } catch (e) {
    return new Response(
      JSON.stringify({ ok: false, error: `Jev fetch failed: ${String(e)}` }),
      { status: 502, headers: { "Content-Type": "application/json", ...CORS_HEADERS } }
    );
  }

  if (!jevRes.ok) {
    const body = await jevRes.text();
    return new Response(
      JSON.stringify({ ok: false, error: `Jev HTTP ${jevRes.status}: ${body.slice(0, 200)}` }),
      { status: 502, headers: { "Content-Type": "application/json", ...CORS_HEADERS } }
    );
  }

  let jevData: any;
  try {
    jevData = await jevRes.json();
  } catch (e) {
    return new Response(
      JSON.stringify({ ok: false, error: "Jev returned non-JSON" }),
      { status: 502, headers: { "Content-Type": "application/json", ...CORS_HEADERS } }
    );
  }

  const filters = answersToFilters(jevData.answers || {});
  return new Response(
    JSON.stringify({
      ok: true,
      filters,
      raw: jevData,  // keep full Jev response for debugging when window.__TYPESAFE_DEBUG=true
    }),
    { status: 200, headers: { "Content-Type": "application/json", ...CORS_HEADERS } }
  );
});
