const express = require('express');
const argon2 = require('argon2');
const { pool, auditLog } = require('../db');
const { requireStaff, requireRole, requirePermission } = require('../middleware');
const router = express.Router();

// ── Dashboard page ───────────────────────────────────────────
router.get('/', requireStaff, (req, res) => {
  res.sendFile('admin/dashboard.html', { root: './public' });
});

// ── Login page ───────────────────────────────────────────────
router.get('/login', (req, res) => {
  res.sendFile('admin/login.html', { root: './public' });
});

// ── Dashboard stats ──────────────────────────────────────────
router.get('/stats', requireStaff, async (req, res) => {
  const [servers, users, votes, bans, ads] = await Promise.all([
    pool.query('SELECT COUNT(*) FROM servers'),
    pool.query('SELECT COUNT(*) FROM users'),
    pool.query('SELECT COUNT(*) FROM votes'),
    pool.query('SELECT COUNT(*) FROM bans WHERE is_active = true'),
    pool.query('SELECT COUNT(*) FROM ads WHERE is_active = true'),
  ]);

  const { rows: onlineRows } = await pool.query(
    'SELECT COUNT(*) FROM servers WHERE is_online = true AND is_banned = false'
  );

  const { rows: playerRows } = await pool.query(
    'SELECT COALESCE(SUM(player_count), 0) AS total FROM servers WHERE is_online = true AND is_banned = false'
  );

  const { rows: featuredRows } = await pool.query(
    'SELECT COUNT(*) FROM servers WHERE is_featured = true'
  );

  res.json({
    total_servers: parseInt(servers.rows[0].count),
    online_servers: parseInt(onlineRows[0].count),
    total_users: parseInt(users.rows[0].count),
    total_votes: parseInt(votes.rows[0].count),
    total_players: parseInt(playerRows[0].total),
    active_bans: parseInt(bans.rows[0].count),
    active_ads: parseInt(ads.rows[0].count),
    featured_servers: parseInt(featuredRows[0].count)
  });
});

// ── List all servers (admin view) ────────────────────────────
router.get('/servers', requireStaff, async (req, res) => {
  const page = Math.max(1, parseInt(req.query.page) || 1);
  const limit = 25;
  const offset = (page - 1) * limit;
  const search = req.query.q || '';

  let where = '';
  const params = [];
  let paramIdx = 1;

  if (search) {
    where = `WHERE (name ILIKE $${paramIdx} OR ip ILIKE $${paramIdx})`;
    params.push(`%${search}%`);
    paramIdx++;
  }

  const countQuery = `SELECT COUNT(*) FROM servers ${where}`;
  const dataQuery = `SELECT id, name, ip, owner_id, player_count, total_votes, is_online,
    is_featured, featured_until, is_banned, ban_reason, created_at
    FROM servers ${where} ORDER BY created_at DESC LIMIT $${paramIdx} OFFSET $${paramIdx + 1}`;

  const countParams = [...params];
  const dataParams = [...params, limit, offset];

  const [countResult, dataResult] = await Promise.all([
    pool.query(countQuery, countParams),
    pool.query(dataQuery, dataParams)
  ]);

  const total = parseInt(countResult.rows[0].count);
  res.json({ servers: dataResult.rows, total, page, pages: Math.ceil(total / limit) });
});

// ── Feature a server (30 days) ───────────────────────────────
router.post('/servers/:id/feature', requireStaff, requirePermission('feature_servers'), async (req, res) => {
  const featuredUntil = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();

  const { rowCount } = await pool.query(
    'UPDATE servers SET is_featured = true, featured_until = $1 WHERE id = $2',
    [featuredUntil, req.params.id]
  );

  if (rowCount === 0) return res.status(404).json({ error: 'Server not found' });

  await auditLog({
    actorType: 'staff', actorId: req.session.staff.id,
    action: 'server_featured', targetType: 'server', targetId: req.params.id,
    details: { featured_until: featuredUntil }
  });

  res.json({ ok: true, featured_until: featuredUntil });
});

// ── Unfeature a server ───────────────────────────────────────
router.delete('/servers/:id/feature', requireStaff, requirePermission('feature_servers'), async (req, res) => {
  await pool.query(
    'UPDATE servers SET is_featured = false, featured_until = null WHERE id = $1',
    [req.params.id]
  );

  await auditLog({
    actorType: 'staff', actorId: req.session.staff.id,
    action: 'server_unfeatured', targetType: 'server', targetId: req.params.id
  });

  res.json({ ok: true });
});

// ── Ban a server ─────────────────────────────────────────────
router.post('/servers/:id/ban', requireStaff, requirePermission('ban_servers'), express.json(), async (req, res) => {
  const { reason } = req.body;
  if (!reason) return res.status(400).json({ error: 'Ban reason required' });

  await pool.query(
    'UPDATE servers SET is_banned = true, ban_reason = $1, banned_by = $2 WHERE id = $3',
    [reason, req.session.staff.id, req.params.id]
  );

  await pool.query(
    'INSERT INTO bans (target_type, target_id, reason, banned_by) VALUES ($1, $2, $3, $4)',
    ['server', req.params.id, reason, req.session.staff.id]
  );

  await auditLog({
    actorType: 'staff', actorId: req.session.staff.id,
    action: 'server_banned', targetType: 'server', targetId: req.params.id,
    details: { reason }
  });

  res.json({ ok: true });
});

// ── Unban a server ───────────────────────────────────────────
router.delete('/servers/:id/ban', requireStaff, requirePermission('ban_servers'), async (req, res) => {
  await pool.query(
    'UPDATE servers SET is_banned = false, ban_reason = null, banned_by = null WHERE id = $1',
    [req.params.id]
  );

  await pool.query(
    'UPDATE bans SET is_active = false WHERE target_type = $1 AND target_id = $2 AND is_active = true',
    ['server', req.params.id]
  );

  await auditLog({
    actorType: 'staff', actorId: req.session.staff.id,
    action: 'server_unbanned', targetType: 'server', targetId: req.params.id
  });

  res.json({ ok: true });
});

// ── Ban a user ───────────────────────────────────────────────
router.post('/users/:id/ban', requireStaff, requirePermission('ban_users'), express.json(), async (req, res) => {
  const { reason } = req.body;
  if (!reason) return res.status(400).json({ error: 'Ban reason required' });

  await pool.query(
    'UPDATE users SET is_banned = true, ban_reason = $1 WHERE id = $2',
    [reason, req.params.id]
  );

  await pool.query(
    'INSERT INTO bans (target_type, target_id, reason, banned_by) VALUES ($1, $2, $3, $4)',
    ['user', req.params.id, reason, req.session.staff.id]
  );

  await auditLog({
    actorType: 'staff', actorId: req.session.staff.id,
    action: 'user_banned', targetType: 'user', targetId: req.params.id,
    details: { reason }
  });

  res.json({ ok: true });
});

// ── Unban a user ─────────────────────────────────────────────
router.delete('/users/:id/ban', requireStaff, requirePermission('ban_users'), async (req, res) => {
  await pool.query(
    'UPDATE users SET is_banned = false, ban_reason = null WHERE id = $1',
    [req.params.id]
  );

  await pool.query(
    'UPDATE bans SET is_active = false WHERE target_type = $1 AND target_id = $2 AND is_active = true',
    ['user', req.params.id]
  );

  await auditLog({
    actorType: 'staff', actorId: req.session.staff.id,
    action: 'user_unbanned', targetType: 'user', targetId: req.params.id
  });

  res.json({ ok: true });
});

// ── List users (admin view) ──────────────────────────────────
router.get('/users', requireStaff, async (req, res) => {
  const page = Math.max(1, parseInt(req.query.page) || 1);
  const limit = 25;
  const offset = (page - 1) * limit;
  const search = req.query.q || '';

  let where = '';
  const params = [];
  let paramIdx = 1;

  if (search) {
    where = `WHERE (username ILIKE $${paramIdx} OR email ILIKE $${paramIdx})`;
    params.push(`%${search}%`);
    paramIdx++;
  }

  const countQuery = `SELECT COUNT(*) FROM users ${where}`;
  const dataQuery = `SELECT id, username, email, avatar, oauth_provider, is_banned, ban_reason, created_at
    FROM users ${where} ORDER BY created_at DESC LIMIT $${paramIdx} OFFSET $${paramIdx + 1}`;

  const [countResult, dataResult] = await Promise.all([
    pool.query(countQuery, [...params]),
    pool.query(dataQuery, [...params, limit, offset])
  ]);

  const total = parseInt(countResult.rows[0].count);
  res.json({ users: dataResult.rows, total, page, pages: Math.ceil(total / limit) });
});

// ── List bans ────────────────────────────────────────────────
router.get('/bans', requireStaff, async (req, res) => {
  const { rows } = await pool.query(
    'SELECT * FROM bans WHERE is_active = true ORDER BY created_at DESC LIMIT 100'
  );
  res.json(rows);
});

// ── Ads management ───────────────────────────────────────────
router.get('/ads', requireStaff, async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM ads ORDER BY created_at DESC');
  res.json(rows);
});

router.post('/ads', requireStaff, requirePermission('manage_ads'), express.json(), async (req, res) => {
  const { name, href, image_url, placement } = req.body;
  if (!name || !href || !image_url) return res.status(400).json({ error: 'Name, href, and image URL required' });

  const { rows } = await pool.query(
    `INSERT INTO ads (name, href, image_url, placement) VALUES ($1, $2, $3, $4) RETURNING *`,
    [name, href, image_url, placement || 'banner']
  );

  const data = rows[0];

  await auditLog({
    actorType: 'staff', actorId: req.session.staff.id,
    action: 'ad_created', targetType: 'ad', targetId: data.id,
    details: { name, href }
  });

  res.status(201).json(data);
});

router.put('/ads/:id', requireStaff, requirePermission('manage_ads'), express.json(), async (req, res) => {
  const allowed = ['name', 'href', 'image_url', 'placement', 'is_active'];
  const updates = {};
  for (const k of allowed) { if (req.body[k] !== undefined) updates[k] = req.body[k]; }

  if (Object.keys(updates).length === 0) return res.status(400).json({ error: 'No valid fields to update' });

  const setClauses = [];
  const params = [];
  let paramIdx = 1;
  for (const [key, val] of Object.entries(updates)) {
    setClauses.push(`${key} = $${paramIdx}`);
    params.push(val);
    paramIdx++;
  }
  params.push(req.params.id);

  const { rows } = await pool.query(
    `UPDATE ads SET ${setClauses.join(', ')} WHERE id = $${paramIdx} RETURNING *`,
    params
  );

  if (rows.length === 0) return res.status(404).json({ error: 'Ad not found' });
  res.json(rows[0]);
});

router.delete('/ads/:id', requireStaff, requirePermission('manage_ads'), async (req, res) => {
  await pool.query('DELETE FROM ads WHERE id = $1', [req.params.id]);

  await auditLog({
    actorType: 'staff', actorId: req.session.staff.id,
    action: 'ad_deleted', targetType: 'ad', targetId: req.params.id
  });

  res.json({ ok: true });
});

// ── Staff management (owner only) ────────────────────────────
router.get('/staff', requireStaff, requireRole('owner', 'admin'), async (req, res) => {
  const { rows } = await pool.query(
    'SELECT id, username, display_name, role, permissions, created_at FROM staff ORDER BY created_at ASC'
  );
  res.json(rows);
});

router.post('/staff', requireStaff, requireRole('owner'), express.json(), async (req, res) => {
  const { username, password, display_name, role, permissions } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Username and password required' });
  if (password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });

  const validRoles = ['moderator', 'admin'];
  const safeRole = validRoles.includes(role) ? role : 'moderator';
  const validPerms = ['feature_servers', 'ban_servers', 'ban_users', 'manage_ads', 'view_audit'];
  const safePerms = (permissions || []).filter(p => validPerms.includes(p));

  const hash = await argon2.hash(password, {
    type: argon2.argon2id,
    memoryCost: 65536,
    timeCost: 3,
    parallelism: 4
  });

  let data;
  try {
    const { rows } = await pool.query(
      `INSERT INTO staff (username, password_hash, display_name, role, permissions, created_by)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id, username, display_name, role, permissions, created_at`,
      [username.toLowerCase().trim(), hash, display_name || username, safeRole, JSON.stringify(safePerms), req.session.staff.id]
    );
    data = rows[0];
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'Username already taken' });
    return res.status(500).json({ error: err.message });
  }

  await auditLog({
    actorType: 'staff', actorId: req.session.staff.id,
    action: 'staff_created', targetType: 'staff', targetId: data.id,
    details: { username: data.username, role: safeRole }
  });

  res.status(201).json(data);
});

router.put('/staff/:id', requireStaff, requireRole('owner'), express.json(), async (req, res) => {
  const { role, permissions, display_name } = req.body;
  const updates = {};
  const setClauses = [];
  const params = [];
  let paramIdx = 1;

  if (display_name) {
    setClauses.push(`display_name = $${paramIdx}`);
    params.push(display_name);
    paramIdx++;
  }
  if (role && ['moderator', 'admin'].includes(role)) {
    setClauses.push(`role = $${paramIdx}`);
    params.push(role);
    paramIdx++;
  }
  if (Array.isArray(permissions)) {
    const validPerms = ['feature_servers', 'ban_servers', 'ban_users', 'manage_ads', 'view_audit'];
    setClauses.push(`permissions = $${paramIdx}::jsonb`);
    params.push(JSON.stringify(permissions.filter(p => validPerms.includes(p))));
    paramIdx++;
  }

  if (setClauses.length === 0) return res.status(400).json({ error: 'No valid fields to update' });

  params.push(req.params.id);
  const { rows } = await pool.query(
    `UPDATE staff SET ${setClauses.join(', ')} WHERE id = $${paramIdx} RETURNING id, username, display_name, role, permissions`,
    params
  );

  if (rows.length === 0) return res.status(404).json({ error: 'Staff not found' });
  res.json(rows[0]);
});

router.delete('/staff/:id', requireStaff, requireRole('owner'), async (req, res) => {
  if (req.params.id === req.session.staff.id) return res.status(400).json({ error: 'Cannot delete yourself' });
  await pool.query('DELETE FROM staff WHERE id = $1', [req.params.id]);
  res.json({ ok: true });
});

// ── Audit log ────────────────────────────────────────────────
router.get('/audit', requireStaff, requirePermission('view_audit'), async (req, res) => {
  const { rows } = await pool.query(
    'SELECT * FROM audit_log ORDER BY created_at DESC LIMIT 100'
  );
  res.json(rows);
});

// ── Current staff info ───────────────────────────────────────
router.get('/me', requireStaff, (req, res) => {
  res.json(req.session.staff);
});

module.exports = router;
