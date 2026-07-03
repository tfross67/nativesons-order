// Supabase project configuration
// Anon key — safe to expose in browser. Only has INSERT permission on orders/order_items (per RLS).
// Order emails are sent via the send-order-email Edge Function (deployed on Supabase),
// which runs server-side and calls AgentMail from there. The AgentMail key never
// reaches the browser.
window.SUPABASE_CONFIG = {
  url: 'https://ruwyfesblmaurfuiaofw.supabase.co',
  anonKey: '***REMOVED-CREDENTIAL***',
};