// ── Self-Hosted PostgreSQL 16 Client ────────────────────────
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 10,
  ssl: process.env.DB_SSL === 'true'
    ? { rejectUnauthorized: false }
    : false
});

// Simple query — no RLS context
async function query(text, params) {
  return pool.query(text, params);
}

// Query with RLS context — sets app.current_user_id per transaction
async function queryAsUser(userId, text, params) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT set_config($1, $2, true)', ['app.current_user_id', userId]);
    const result = await client.query(text, params);
    await client.query('COMMIT');
    return result;
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

// Audit log helper — append-only insert
async function auditLog({ actorType, actorId, action, targetType, targetId, details, ipAddress }) {
  return pool.query(
    `INSERT INTO audit_log (actor_type, actor_id, action, target_type, target_id, details, ip_address)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [actorType, actorId || null, action, targetType || null, targetId || null, details ? JSON.stringify(details) : '{}', ipAddress || null]
  );
}

module.exports = { pool, query, queryAsUser, auditLog };
