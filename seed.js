// ── Seed script: creates the first owner staff account ───────
// Usage:  ADMIN_USER=admin ADMIN_PASS=yourpassword npm run seed
require('dotenv').config();
const bcrypt = require('bcryptjs');
const supabase = require('./db');

async function seed() {
  const username = (process.env.ADMIN_USER || 'admin').toLowerCase().trim();
  const password = process.env.ADMIN_PASS || 'changeme123';

  if (password.length < 8) {
    console.error('Password must be at least 8 characters');
    process.exit(1);
  }

  const hash = bcrypt.hashSync(password, 12);

  // Upsert owner account
  const { data, error } = await supabase
    .from('staff')
    .upsert({
      username,
      password_hash: hash,
      display_name: 'Owner',
      role: 'owner',
      permissions: ['feature_servers', 'ban_servers', 'ban_users', 'manage_ads', 'view_audit']
    }, { onConflict: 'username' })
    .select('id, username, role')
    .single();

  if (error) {
    console.error('Seed failed:', error.message);
    process.exit(1);
  }

  console.log(`\n  ✓ Staff account ready`);
  console.log(`    Username: ${data.username}`);
  console.log(`    Role:     ${data.role}`);
  console.log(`    Login at: ${process.env.BASE_URL || 'http://localhost:3000'}/admin/login\n`);
}

seed();
