// Supabase Edge Function: jev-ux-review
// Scores a text description of a UI screenshot against a fixed rubric.
// Returns 3 Score answers (discoverability, hierarchy, friction) and
// a short Noul on whether the description contains enough detail to score.
//
// The Edge Function holds the Typesafe API key — the browser never sees it.
//
// Required secrets:
//   TYPESAFE_API_KEY=ts_xxx     — from your TypeSafe console
//
// Deploy:
//   supabase functions deploy jev-ux-review --project-ref ruwyfesblmaurfuiaofw --no-verify-jwt
//
// Usage (from your terminal or a script):
//   curl -X POST .../functions/v1/jev-ux-review \
//     -H "Content-Type: application/json" \
//     -d '{"screenshot_description":"...","page":"availability.html","focus":"search"}'
//
// Expected screenshot_description shape (3-6 sentences):
//   "Search input is centered at top with placeholder text 'Search by color,
//    size, water needs...'. Below it is a row of 'Try' suggestion chips
//    showing size shortcuts. Underneath that is a 'Filter by type' row with
//    6 category chips. Sort dropdown is on the right side at the same
//    vertical position as the filter chips. Results table starts below."

const TYPESAFE_API_KEY = Deno.env.get("TYPESAFE_API_KEY") || "";
const TYPESAFE_MODEL = Deno.env.get("TYPESAFE_MODEL") || "jev-latest";
const TYPESAFE_URL = "https://api.typesafe.ai/v1/systemone";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

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

interface ReviewRequest {
  screenshot_description?: string;
  page?: string;
  focus?: string;          // e.g. "search", "checkout", "cart"
  notes?: string;          // optional context (target audience, goal of change)
}

interface ReviewResponse {
  ok: boolean;
  scores: Record<string, number>;          // {discoverability: 2.1, hierarchy: 1.5, friction: 0.8}
  confidence: Record<string, number>;
  probabilities: Record<string, Record<string, number>>;
  explanation?: string;
  raw?: any;
  error?: string;
}

function buildQuestions() {
  return {
    // 1. Discoverability — can a first-time visitor find the search?
    discoverability: {
      type: "score",
      instructions: "How discoverable is the search input on this page? Consider: visual prominence, contrast, placement, and whether the placeholder teaches the input vocabulary.",
      criteria: [
        { what: "no search visible or hidden behind a button/menu" },
        { what: "search present but visually weak; competes with other UI; user might miss it" },
        { what: "search is visually clear and easy to spot; user notices it within a few seconds but may not know what to type" },
        { what: "search is dominant; placeholder teaches the vocabulary; suggestion chips reinforce the input model" },
      ],
    },
    // 2. Hierarchy — does the visual order lead the eye to the right things?
    hierarchy: {
      type: "score",
      instructions: "How clear is the visual hierarchy of the search-and-filter area? Consider: is there one dominant focal point, or do multiple elements compete for attention? Does the eye know where to land first, second, third?",
      criteria: [
        { what: "multiple elements at the same visual weight; user has no clear starting point" },
        { what: "one element stands out but several secondary elements compete for the eye" },
        { what: "clear primary, clear secondary, tertiary elements recede appropriately" },
        { what: "obvious single focal point; supporting elements reinforce without competing" },
      ],
    },
    // 3. Friction — what's likely to stop or slow a user from completing a search?
    friction: {
      type: "score",
      instructions: "How much friction is there in the search-and-filter area? Consider: confusing labels, hidden affordances, required steps before searching, ambiguous terminology. Score 0 = high friction, 3 = no friction.",
      criteria: [
        { what: "high friction — unclear labels, hidden affordances, multiple steps required to search" },
        { what: "moderate friction — some ambiguity but usable; a few confusing elements" },
        { what: "low friction — mostly clear; minor ambiguities" },
        { what: "no friction — clear labels, obvious affordances, single-step search" },
      ],
    },
    // 4. Input vocabulary clarity — does the page teach users what they can type?
    input_vocabulary: {
      type: "score",
      instructions: "How well does the page teach users the vocabulary they can type into the search? Consider: placeholder text examples, suggestion chips that show valid inputs, and any visible hints about what the search understands (plant names vs. attributes vs. sizes).",
      criteria: [
        { what: "no vocabulary hints; user has no idea what they can type" },
        { what: "placeholder mentions one or two example terms; user must experiment" },
        { what: "placeholder + some suggestion chips show a few valid inputs" },
        { what: "comprehensive teaching: placeholder examples, varied suggestion chips (plant names, attributes, sizes), hints reinforce that natural language works" },
      ],
    },
    // 5. Error state UX — what happens when search returns nothing or fails?
    error_state: {
      type: "score",
      instructions: "How well does the search area handle the empty / error / no-results state? Consider: is there a visible empty state, does it explain why nothing matched, does it offer alternative queries or a way to relax filters? Score 0 = poor / missing, 3 = excellent.",
      criteria: [
        { what: "no empty state; results simply disappear with no explanation" },
        { what: "generic 'no results' message; no guidance on what to try next" },
        { what: "empty state explains no match AND offers a specific next step (relax a filter, try a synonym)" },
        { what: "empty state explains the situation, suggests specific alternatives, and offers an easy way to clear all filters and start over" },
      ],
    },
    // 6. Results feedback quality — after the user searches, do they know what happened?
    results_feedback: {
      type: "score",
      instructions: "How clearly does the page communicate the result of a search? Consider: result count visible, applied filter chips visible and removable, loading state during search, what happens when filters change results in real-time.",
      criteria: [
        { what: "no visible feedback; user can't tell how many results matched or which filters are applied" },
        { what: "result count visible but applied filters are hidden or hard to remove" },
        { what: "result count + applied filter chips visible and individually removable" },
        { what: "result count + removable filter chips + active query echoed back + loading indicator during search" },
      ],
    },
    // 7. Mobile breakpoint behavior — does the layout hold up on a phone screen?
    mobile_breakpoint: {
      type: "score",
      instructions: "How well does the search-and-filter area work on a phone-sized screen (assume 375px wide)? Consider: search input width, suggestion chips wrap or overflow, filter row collapses or stays usable, sort dropdown placement, tap target sizes.",
      criteria: [
        { what: "layout breaks — overflow, hidden elements, unusably small tap targets" },
        { what: "mostly works but cramped; some elements cut off or stacked awkwardly" },
        { what: "works comfortably; chips wrap, inputs full-width, sort accessible" },
        { what: "purpose-built mobile layout — generous tap targets, no horizontal scroll, sort in a thumb-reach position" },
      ],
    },
    // 8. Accessibility — keyboard, focus, semantic markup for the search area
    accessibility: {
      type: "score",
      instructions: "How accessible is the search-and-filter area? Consider: visible focus indicators on the search input, semantic button/label markup for chips and filter rows, screen-reader-friendly result counts, contrast on suggestion chips.",
      criteria: [
        { what: "no visible focus indicators; chips are divs with click handlers; no semantic labels" },
        { what: "some focus indicators but inconsistent; chips partially labeled; result count not announced" },
        { what: "consistent focus indicators; chips are real buttons; result count accessible" },
        { what: "full keyboard nav, focus trap where appropriate, ARIA labels on chips/filter rows, screen-reader announcements for result count changes" },
      ],
    },
  };
}

function buildState(description: string, page: string, focus: string, notes?: string): any {
  return {
    page,
    focus,
    notes: notes || "",
    description,
    evaluation_context: {
      audience: "Trade customers (landscapers, contractors) looking up specific plants to order wholesale. They know plant terminology. Many are on phones in a greenhouse.",
      page_purpose: "Search and filter the weekly plant availability, then add plants to a cart for ordering.",
      what_we_want_to_know: "Does this search/filter area make it obvious how to find plants quickly, without confusing the user or hiding the main action?",
    },
  };
}

async function callJev(body: any): Promise<any> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000); // 15s for UX calls — bigger rubric
  try {
    const res = await fetch(TYPESAFE_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${TYPESAFE_API_KEY}`,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!res.ok) {
      const errBody = await res.text();
      throw new Error(`Jev HTTP ${res.status}: ${errBody.slice(0, 200)}`);
    }
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

function explainScores(answers: any): string {
  const lines: string[] = [];
  for (const [id, ans] of Object.entries(answers)) {
    const score = (ans as any).score;
    const confidence = (ans as any).confidence;
    const probs = (ans as any).probabilities || {};
    const top = Object.entries(probs)
      .sort((a: any, b: any) => b[1] - a[1])
      .slice(0, 2)
      .map(([k, v]) => `${k}:${(v * 100).toFixed(0)}%`)
      .join(", ");
    lines.push(`${id}: score=${score?.toFixed(2)} conf=${confidence?.toFixed(2)} (${top})`);
  }
  return lines.join("\n  ");
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

  let payload: ReviewRequest;
  try {
    payload = await req.json();
  } catch (e) {
    return new Response("Invalid JSON", { status: 400, headers: CORS_HEADERS });
  }

  const description = String(payload.screenshot_description || "").trim();
  if (!description) {
    return new Response(
      JSON.stringify({ ok: false, error: "screenshot_description is required" }),
      { status: 400, headers: { "Content-Type": "application/json", ...CORS_HEADERS } }
    );
  }
  if (description.length < 50) {
    return new Response(
      JSON.stringify({ ok: false, error: "screenshot_description too short (min 50 chars) — describe the screenshot in 3-6 sentences" }),
      { status: 400, headers: { "Content-Type": "application/json", ...CORS_HEADERS } }
    );
  }
  if (description.length > 3000) {
    return new Response(
      JSON.stringify({ ok: false, error: "screenshot_description too long (max 3000 chars)" }),
      { status: 400, headers: { "Content-Type": "application/json", ...CORS_HEADERS } }
    );
  }

  const page = String(payload.page || "unknown");
  const focus = String(payload.focus || "general");
  const notes = payload.notes ? String(payload.notes).slice(0, 500) : undefined;

  let jevData: any;
  try {
    jevData = await callJev({
      model: TYPESAFE_MODEL,
      state: buildState(description, page, focus, notes),
      questions: buildQuestions(),
    });
  } catch (e) {
    return new Response(
      JSON.stringify({ ok: false, error: `Jev call failed: ${String(e)}` }),
      { status: 502, headers: { "Content-Type": "application/json", ...CORS_HEADERS } }
    );
  }

  const answers = jevData.answers || {};
  const scores: Record<string, number> = {};
  const confidence: Record<string, number> = {};
  const probabilities: Record<string, Record<string, number>> = {};
  for (const [id, ans] of Object.entries(answers)) {
    scores[id] = (ans as any).score ?? null;
    confidence[id] = (ans as any).confidence ?? null;
    probabilities[id] = (ans as any).probabilities ?? {};
  }

  const response: ReviewResponse = {
    ok: true,
    scores,
    confidence,
    probabilities,
    explanation: explainScores(answers),
    raw: jevData,
  };
  return new Response(
    JSON.stringify(response),
    { status: 200, headers: { "Content-Type": "application/json", ...CORS_HEADERS } }
  );
});
