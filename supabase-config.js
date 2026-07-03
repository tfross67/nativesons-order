// Supabase project configuration
// Anon key — safe to expose in browser. Only has INSERT permission on orders/order_items (per RLS).
// AgentMail key — also safe to expose; it's a single-inbox scoped key from a public service.
// The key only authorizes sending FROM afterimage@agentmail.to — it can't read inbox or send
// from arbitrary addresses. Anyone scraping it would only be able to impersonate that inbox.
window.SUPABASE_CONFIG = {
  url: 'https://ruwyfesblmaurfuiaofw.supabase.co',
  anonKey: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InJ1d3lmZXNibG1hdXJmdWlhb2Z3Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODMwMzYyNjksImV4cCI6MjA5ODYxMjI2OX0.bAnSbs3NIWQjKzTI-Cr5CFCbCn7nxAn-1XfTSRlBoJE',
  agentmailApiKey: 'am_us_5e75f18da34789c9184f082057429dd5b630fb81ddfca1312101c150def4980e',
  agentmailInbox: 'afterimage@agentmail.to',
  officeEmail: 'orders@nativeson.com',
};