// ── Seed script: creates the first owner staff account ───────
// Usage:  ADMIN_USER=admin ADMIN_PASS=yourpassword npm run seed
require('dotenv').config();
const argon2 = require('argon2');
const { pool } = require('./db');

async function seed() {
  const username = (process.env.ADMIN_USER || 'admin').toLowerCase().trim();
  const password = process.env.ADMIN_PASS || 'changeme123';

  if (password.length < 8) {
    console.error('Password must be at least 8 characters');
    process.exit(1);
  }

  const hash = await argon2.hash(password, {
    type: argon2.argon2id,
    memoryCost: 65536,
    timeCost: 3,
    parallelism: 4
  });

  const { rows } = await pool.query(
    `INSERT INTO staff (username, password_hash, display_name, role, permissions)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (username) DO UPDATE SET
       password_hash = EXCLUDED.password_hash,
       display_name = EXCLUDED.display_name,
       role = EXCLUDED.role,
       permissions = EXCLUDED.permissions
     RETURNING id, username, role`,
    [username, hash, 'Owner', 'owner', JSON.stringify(['feature_servers', 'ban_servers', 'ban_users', 'manage_ads', 'view_audit'])]
  );

  const data = rows[0];
  console.log(`\n  ✓ Staff account ready`);
  console.log(`    Username: ${data.username}`);
  console.log(`    Role:     ${data.role}`);
  console.log(`    Login at: ${process.env.BASE_URL || 'http://localhost:3000'}/admin/login\n`);

  await pool.end();
}

seed().catch(err => {
  console.error('Seed failed:', err.message);
  process.exit(1);
});
