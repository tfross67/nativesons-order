// Supabase project configuration
// Publishable key — public by design (it is the new-key-system replacement for
// the legacy anon JWT) and grants nothing on its own: RLS denies every table.
// Order writes go through the send-order-email / send-order-slack Edge
// Functions, staff reads through staff-customers, and the admin dashboard
// through admin-ops — the service-role key stays in those functions' env.
window.SUPABASE_CONFIG = {
  url: 'https://ruwyfesblmaurfuiaofw.supabase.co',
  anonKey: 'sb_publishable_AdJy4KbVJzeYM6TGjXv-YA_ZXKQps15',
};
