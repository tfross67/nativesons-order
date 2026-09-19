// ux-review-baseline.js
// Captures the current state of availability.html before changes.
// Run this NOW (before any UX work) to establish a baseline score.
//
// Usage: node ux-review-baseline.js

const { execSync } = require('child_process');

const description = [
  "The page has a hero block at top with the title 'Smart Plant Search' and a subtitle 'This week's availability, Week of September 21st, 2026'. Below that is a search input centered horizontally with placeholder text 'Search by color, size, water needs, or describe what you're looking for.' The input has a thin border and a small × clear button on the right edge.",
  "Directly below the search input is a row labeled 'Try' followed by 11 suggestion chips: 4\u2033, 1g, 2g, 5g, 15g, \u00b7 ca native, shade, succulent, in bloom, pollinators. The chips are small, pill-shaped, and use a neutral background. Some chips show container sizes (4\u2033, 1g, 2g, 5g, 15g), others show attributes (ca native, shade, succulent, in bloom, pollinators).",
  "Below the suggestions is a 'Filter by type' row with category chips: All, Perennials (168), Shrubs (142), Grasses (24), Succulents (14), Trees (12). The counts are shown in parentheses after each label. To the right is a 'Sort by' dropdown with options: Relevance, Name A\u2013Z, Name Z\u2013A, Price low\u2192high, Price high\u2192low, In bloom first.",
  "Above the search input is a '68 plants in bloom this week' headline and three stat cards in a row: total (825), in bloom (175), CA native (137). The stats use large bold numbers with small labels below. The stats row is now muted (opacity 0.7) and uses smaller font sizes below 480px, so it visually defers to the search input. The search input is the dominant focal point above the fold.",
  "When the search returns no results, a small gray message appears saying 'No plants match your search. Try fewer words or different terms.' During search, the filterSummary area shows removable chips for each active filter (e.g. 'Color: red ×', 'Type: shrub ×', 'In bloom ×', 'Clear all') along with the result count, e.g. '12 results — Color: red Type: shrub × Clear all'. These chips have working × buttons and a 'Clear all' button. The whole filterSummary div is aria-live='polite' so screen readers announce changes. Loading during search is not visible because the client-side filter runs synchronously.",
  "On a 375px-wide phone screen, the search input takes the full width and the suggestion chips wrap to a second row. The 'Filter by type' row of 6 category chips has a horizontal snap-scroll with a fade-out gradient on the right edge to hint there's more to scroll; the sort dropdown stays accessible below. Each chip has a 32px minimum tap target. The stats row above is reduced to small muted numbers on phones. Focus indicators on the search input show a thin outline when tabbed to.",
  "Filter chips across the page are real button or anchor elements, not divs with click handlers. The result count is shown in the filterSummary area near the table. aria-live='polite' on the filterSummary means screen readers announce result count changes as filters are applied or removed. ARIA labels are present on major controls (search input, view toggle, sort tabs). The focus order moves naturally from input → suggestions → filter row → sort → table."
].join(' ');

console.log("Running UX baseline review...");
console.log("\nDescription being scored:");
console.log("---\n" + description + "\n---");

require('fs').writeFileSync('/tmp/ux-baseline-description.txt', description);

// Spawn the ux-review.js with the description
try {
  const out = execSync(`node ux-review.js "${description.replace(/"/g, '\\"')}" availability.html search`, {
    cwd: __dirname,
    encoding: 'utf-8',
    stdio: 'inherit',
  });
  console.log("\n=== Baseline captured. Save the scorecard for comparison after UX changes. ===");
} catch (e) {
  console.error("Failed:", e.message);
  process.exit(1);
}
