// Supabase project configuration
// Anon key — safe to expose in browser. Only has INSERT permission on orders/order_items (per RLS).
// Order emails are sent via the send-order-email Edge Function (deployed on Supabase),
// which runs server-side and calls AgentMail from there. The AgentMail key never
// reaches the browser.
window.SUPABASE_CONFIG = {
  url: 'https://ruwyfesblmaurfuiaofw.supabase.co',
  anonKey: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InJ1d3lmZXNibG1hdXJmdWlhb2Z3Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODMwMzYyNjksImV4cCI6MjA5ODYxMjI2OX0.bAnSbs3NIWQjKzTI-Cr5CFCbCn7nxAn-1XfTSRlBoJE',
};