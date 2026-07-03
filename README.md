# Native Sons — Order Portal

A customer-facing ordering portal for Native Sons Wholesale Nursery.
Built on top of the existing `nativesons-retail` availability data, with a Supabase backend for order storage and email confirmations.

**Live URL (after deploy):** `https://tfross67.github.io/nativesons-order/`
**Admin URL:** `https://tfross67.github.io/nativesons-order/admin.html`

## By the numbers

- 264 unique plants from the weekly availability list
- 282 orderable rows (some plants come in multiple container sizes — e.g. 1gal AND 5gal)
- 17 rows in bloom, 15 budding
- Search, filter by bloom/bud, mobile-friendly cart, guest checkout, no accounts

## What's in here

```
nativesons-order/
├── index.html                       # Customer portal (browse + cart + order)
├── styles.css                       # Custom CSS — earthy, hand-tuned
├── app.js                           # Plant grid, search/filter, cart UI
├── cart.js                          # localStorage cart
├── availability_data.js             # Copied from nativesons-retail (with bloom/bud)
├── confirmation.html                # Post-submit success page
├── admin.html                       # Admin dashboard (password-gated)
├── admin-config.js                  # Admin password
├── supabase-config.js               # Public anon key (paste here)
├── supabase/
│   ├── schema.sql                   # Tables + RLS + RPC function
│   └── functions/send-order-email/  # Email confirmation Edge Function
│       └── index.ts
├── setup.sh                         # One-shot deploy script
└── README.md                        # This file
```

## Quick start (10 minutes)

### 1. Supabase project

Already done — project ID is `ruwyfesblmaurfuiaofw`. Get your API keys from:
https://supabase.com/dashboard/project/ruwyfesblmaurfuiaofw/settings/api

You'll need:
- **`anon` `public` key** — goes in `supabase-config.js`
- **`service_role` `secret` key** — goes in `admin.html` (server-side only!)

### 2. Apply the schema

Open the Supabase SQL editor:
https://supabase.com/dashboard/project/ruwyfesblmaurfuiaofw/sql

Paste the entire contents of `supabase/schema.sql` and click **Run**.

This creates:
- `orders` table (id, order_number, customer info, status, totals)
- `order_items` table (line items linked to orders)
- Row-level security (anon can INSERT, cannot SELECT; service role bypasses)
- `submit_order()` RPC for atomic inserts

### 3. Get AgentMail API key

From your AgentMail console, grab the **API key** (not the SMTP password — the API is what we'll use). The key starts with `am_us_…`.

> **Why the API, not SMTP?** Edge Functions on Supabase run on Deno, and Deno's SMTP support is awkward. AgentMail's HTTP API is one POST call and works perfectly in Deno.

### 4. Install the Supabase CLI

```bash
brew install supabase/tap/supabase
```

### 5. Run the deploy script

```bash
cd ~/.hermes/nativesons-order
bash setup.sh
```

The script will:
1. Push the schema (or show you the manual SQL if CLI isn't ready)
2. Deploy the `send-order-email` Edge Function
3. Set the AgentMail secrets
4. Create the GitHub repo and push
5. Enable GitHub Pages

### 6. Paste your keys

After `setup.sh` runs, edit these three files and commit:

**`supabase-config.js`** — replace `YOUR_SUPABASE_ANON_KEY_HERE` with the anon key.

**`admin.html`** — find the line:
```js
const SERVICE_KEY = 'YOUR_SUPABASE_SERVICE_ROLE_KEY_HERE';
```
Replace with the service role key.

**`admin-config.js`** — change the password from `nativesons2026` to something you'll remember.

```bash
git add -A && git commit -m "Configure keys" && git push
```

GitHub Pages will rebuild in ~30 seconds.

### 7. Test

1. Visit `https://tfross67.github.io/nativesons-order/`
2. Add a few plants to the cart
3. Click the floating cart bar → "Place Order Request"
4. Fill in the form, submit
5. Check `orders@nativeson.com` for the office email
6. Check the customer email for confirmation
7. Visit `https://tfross67.github.io/nativesons-order/admin.html`
8. Log in with your admin password
9. The order should be there — click to see details, change status, export CSV

## How it works

### Customer flow

```
Browse availability → add to cart (localStorage) → slide-out cart panel
  → checkout modal (name/email/phone/notes)
  → INSERT into orders + INSERT into order_items (atomic via RPC)
  → Edge Function fires via DB webhook
  → Sends 2 emails via AgentMail SMTP (office + customer)
  → Redirect to confirmation.html with order number
```

### Admin flow

```
Visit /admin.html → password gate → loads all orders via service role
  → filter by status, search by name/email/order#
  → click order to see line items + customer info
  → mark confirmed/fulfilled/cancelled
  → export all orders to CSV
```

### Data model

```
orders
  id              uuid PK
  order_number    NS-2026-XXXX (unique)
  customer_name
  customer_email
  customer_phone  (nullable)
  customer_company (nullable)
  notes           (nullable)
  status          new | confirmed | fulfilled | cancelled
  subtotal        numeric
  item_count      int
  created_at      timestamptz
  updated_at      timestamptz

order_items
  id              uuid PK
  order_id        uuid FK → orders.id
  plant_key       text  (canonical name from availability_data.js)
  plant_name      text  (display name as shown to customer)
  plant_size      text  (e.g. "1 gal")
  unit_price      numeric
  qty             int
  line_total      numeric
```

## Security

- **Anon key in browser** — can only INSERT into orders, cannot SELECT. No one can enumerate other people's orders.
- **Service role key in admin.html** — full access, but admin.html is password-gated. The key is in plain JS for simplicity; for higher security, move admin to a server-rendered page or use Supabase Auth with email magic links. (Easy upgrade path: switch `admin.html` to use `supabase.auth.signInWithOtp` and replace the password gate.)
- **No customer accounts** — guest checkout only. Confirmation emails serve as the receipt.
- **Rate limiting** — Supabase has built-in rate limits. For higher traffic, add a Cloudflare Turnstile to the form.

## Customization

- **Colors** — edit the `:root` block in `styles.css` (`--c-sage`, `--c-clay`, `--c-bloom`, etc.)
- **Branding** — change the SVG mark in the header, or replace with an `<img>` pointing to your logo
- **Email content** — edit `buildOrderEmail()` in `supabase/functions/send-order-email/index.ts`
- **Order number format** — edit `generateOrderNumber()` in `app.js`

## Updating availability data

When the weekly list updates:

```bash
# 1. Update availability_data.js from nativesons-retail
cp ~/.hermes/nativesons-retail/availability_data.js ~/.hermes/nativesons-order/

# 2. Commit and push
cd ~/.hermes/nativesons-order
git add availability_data.js
git commit -m "Update availability for week of $(date +%-m/%-d/%Y)"
git push
```

## Troubleshooting

**"Supabase is not configured"** — `supabase-config.js` still has the placeholder. Edit and commit.

**Orders submit but no email** — check Edge Function logs: https://supabase.com/dashboard/project/ruwyfesblmaurfuiaofw/functions/send-order-email/logs
Most common: wrong API key. Re-run:
```bash
supabase secrets set AGENTMAIL_API_KEY=am_us_your-key-here --project-ref ruwyfesblmaurfuiaofw
```

To send a test email directly:
```bash
curl -X POST https://api.agentmail.to/v0/inboxes/afterimage@agentmail.to/messages/send \
  -H "Authorization: Bearer am_us_your-key" \
  -H "Content-Type: application/json" \
  -d '{"to":"you@example.com","subject":"Test","text":"Hello from the order portal"}'
```

**Admin page is blank** — `admin.html` still has the placeholder service role key.

**Customers can see other people's orders** — should not be possible; RLS prevents SELECT for anon. If you see this, check policies in the Supabase dashboard.

## Next steps (when you want them)

- [ ] Real Supabase Auth for the admin page (replace the password gate)
- [ ] Stripe Checkout for deposits / full payment
- [ ] SMS notifications via Twilio for urgent orders
- [ ] Inventory sync — decrement on confirmed orders, alert on low stock
- [ ] Recurring orders — let repeat customers reorder with one click
- [ ] Custom domain (orders.nativeson.com via Cloudflare)
