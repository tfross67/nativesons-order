// ux-review.js
// Tiny CLI wrapper around the jev-ux-review Edge Function.
// Usage: node ux-review.js "<description>" [page] [focus]

const fetchFn = globalThis.fetch;
const url = process.env.SUPABASE_URL || "https://ruwyfesblmaurfuiaofw.supabase.co";
const anonKey = process.env.SUPABASE_ANON_KEY;

const description = process.argv[2];
const page = process.argv[3] || "availability.html";
const focus = process.argv[4] || "search";

if (!description) {
  console.error("Usage: node ux-review.js \"<description>\" [page] [focus]");
  process.exit(1);
}

if (description.length < 50) {
  console.error("Description too short — write 3-6 sentences describing the screenshot.");
  process.exit(1);
}

(async () => {
  const headers = { "Content-Type": "application/json" };
  if (anonKey) headers["apikey"] = anonKey;

  const res = await fetchFn(`${url}/functions/v1/jev-ux-review`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      screenshot_description: description,
      page,
      focus,
      notes: "Wholesale plant order portal, trade customers, mobile-friendly desired.",
    }),
  });

  const data = await res.json();
  if (!res.ok) {
    console.error("Error:", data.error || res.statusText);
    process.exit(1);
  }

  console.log("\n=== UX Review Scorecard ===\n");
  for (const id of Object.keys(data.scores)) {
    const score = data.scores[id];
    const conf = data.confidence[id];
    const probs = data.probabilities[id] || {};
    const sorted = Object.entries(probs).sort((a, b) => b[1] - a[1]).slice(0, 2);
    const topStr = sorted.map(([k, v]) => `${k}:${(v * 100).toFixed(0)}%`).join(", ");
    console.log(`  ${id.padEnd(16)} ${score.toFixed(2)}  (conf ${conf.toFixed(2)} \u2014 ${topStr})`);
  }
  console.log("\nRaw response saved to /tmp/ux-review-result.json");
  require("fs").writeFileSync("/tmp/ux-review-result.json", JSON.stringify(data, null, 2));
})().catch(e => {
  console.error("Network/error:", e);
  process.exit(1);
});
