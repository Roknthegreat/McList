// ── Supabase Client ──────────────────────────────────────────
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY  // service role key for server-side
);

module.exports = supabase;
