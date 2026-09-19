# UX Review (Jev-powered)

Score a screenshot description of the portal against a fixed rubric. Designed to give you a consistent, repeatable UX score over time so you can tell whether a change actually helped.

## How it works

1. Take a screenshot of the page (Cmd+Shift+4 on macOS)
2. Describe it in 3-6 plain sentences — placement, hierarchy, what stands out, what competes for attention
3. Run `node ux-review.js "<description>" availability.html search`
4. Get back a scorecard with 3 dimensions on a 0-3 scale

## The rubric

8 dimensions, each scored 0-3. Goal: get every dimension to 2-3.

| Dimension | What it measures |
|---|---|
| discoverability | Can a first-time visitor find the search? |
| hierarchy | Does the visual order lead the eye to the right things? |
| friction | What's likely to stop or slow a user from completing a search? |
| input_vocabulary | Does the page teach users what they can type? |
| error_state | What happens when search returns nothing or fails? |
| results_feedback | After searching, do users know what happened? |
| mobile_breakpoint | Does the layout hold up on a phone (375px)? |
| accessibility | Keyboard, focus, semantic markup, screen-reader friendly? |

Each dimension has 4 levels (0-3) with concrete descriptions of what each level looks like. The rubric is the constant; descriptions and screenshots are the variable.

**Goal:** get every dimension to 2-3. Run the baseline before any changes so you have a number to compare against.

## Files

- `supabase/functions/jev-ux-review/index.ts` — Edge Function holding the Typesafe key
- `ux-review.js` — CLI wrapper
- `ux-review-baseline.js` — captures the current availability.html state

## Commands

```bash
# Deploy the function (one time)
supabase functions deploy jev-ux-review --project-ref ruwyfesblmaurfuiaofw --no-verify-jwt

# Capture the baseline (one time, before any UX changes)
node ux-review-baseline.js

# After any UX change: take a fresh screenshot, describe it, score it
node ux-review.js "Your 3-6 sentence description here" availability.html search

# Compare scores over time
ls -la /tmp/ux-review-result.json
```

## Honest limits

- Jev is text-only — you describe the screenshot, Jev scores the description
- The score is only as good as your description — be specific about placement, weight, hierarchy
- Don't change the rubric mid-project or scores stop being comparable
