const express = require('express');
const crypto = require('crypto');
const { pool, auditLog } = require('../db');
const { requireUser } = require('../middleware');
const router = express.Router();

// ── List servers (public) ────────────────────────────────────
router.get('/', async (req, res) => {
  const page = Math.max(1, parseInt(req.query.page) || 1);
  const limit = Math.min(50, parseInt(req.query.limit) || 20);
  const offset = (page - 1) * limit;
  const tag = req.query.tag || '';
  const sort = req.query.sort || 'votes';
  const search = req.query.q || '';

  const conditions = ['is_approved = true', 'is_banned = false'];
  const params = [];
  let paramIdx = 1;

  if (tag && tag !== 'All') {
    conditions.push(`tags @> $${paramIdx}::jsonb`);
    params.push(JSON.stringify([tag]));
    paramIdx++;
  }
  if (search) {
    conditions.push(`(name ILIKE $${paramIdx} OR ip ILIKE $${paramIdx})`);
    params.push(`%${search}%`);
    paramIdx++;
  }

  let orderBy;
  if (sort === 'players') orderBy = 'is_featured DESC, player_count DESC';
  else if (sort === 'newest') orderBy = 'is_featured DESC, created_at DESC';
  else orderBy = 'is_featured DESC, total_votes DESC';

  const where = conditions.join(' AND ');

  const countQuery = `SELECT COUNT(*) FROM servers WHERE ${where}`;
  const dataQuery = `SELECT id, name, ip, port, description, country, tags, banner_url, version,
    player_count, max_players, total_votes, is_online, is_featured, featured_until, owner_id, created_at
    FROM servers WHERE ${where} ORDER BY ${orderBy} LIMIT $${paramIdx} OFFSET $${paramIdx + 1}`;

  const countParams = [...params];
  const dataParams = [...params, limit, offset];

  const [countResult, dataResult] = await Promise.all([
    pool.query(countQuery, countParams),
    pool.query(dataQuery, dataParams)
  ]);

  const total = parseInt(countResult.rows[0].count);
  res.json({
    servers: dataResult.rows,
    total,
    page,
    pages: Math.ceil(total / limit)
  });
});

// ── Get single server ────────────────────────────────────────
router.get('/:id', async (req, res) => {
  const { rows } = await pool.query(
    'SELECT * FROM servers WHERE id = $1 AND is_banned = false',
    [req.params.id]
  );

  if (rows.length === 0) return res.status(404).json({ error: 'Server not found' });
  const server = rows[0];

  // Get recent metrics
  const { rows: metrics } = await pool.query(
    'SELECT player_count, is_online, recorded_at FROM server_metrics WHERE server_id = $1 ORDER BY recorded_at DESC LIMIT 48',
    [server.id]
  );

  // Get vote count for this month
  const monthStart = new Date();
  monthStart.setDate(1); monthStart.setHours(0, 0, 0, 0);
  const { rows: voteRows } = await pool.query(
    'SELECT COUNT(*) FROM votes WHERE server_id = $1 AND created_at >= $2',
    [server.id, monthStart.toISOString()]
  );

  // Remove api_token from public response
  const { api_token, banned_by, ...safe } = server;
  res.json({ ...safe, metrics: metrics || [], month_votes: parseInt(voteRows[0].count) || 0 });
});

// ── Add server (requires login) ──────────────────────────────
router.post('/', requireUser, express.json(), async (req, res) => {
  const u = req.session.user;
  const { name, ip, port, description, country, tags, version, max_players, website_url, discord_url, store_url } = req.body;

  if (!name || !ip) return res.status(400).json({ error: 'Server name and IP are required' });
  if (name.length > 60) return res.status(400).json({ error: 'Name must be 60 characters or less' });
  if (ip.length > 253) return res.status(400).json({ error: 'Invalid IP address' });

  // Check duplicate IP
  const { rows: dupRows } = await pool.query('SELECT id FROM servers WHERE ip = $1', [ip]);
  if (dupRows.length > 0) return res.status(409).json({ error: 'A server with this IP already exists' });

  // Check owner limit (max 10 servers per user)
  const { rows: countRows } = await pool.query(
    'SELECT COUNT(*) FROM servers WHERE owner_id = $1',
    [u.id]
  );
  if (parseInt(countRows[0].count) >= 10) return res.status(400).json({ error: 'Maximum 10 servers per account' });

  const api_token = 'el_' + crypto.randomBytes(24).toString('hex');
  const safeTags = Array.isArray(tags) ? tags.slice(0, 10) : [];

  const { rows } = await pool.query(
    `INSERT INTO servers (owner_id, name, ip, port, description, country, tags, version, max_players, website_url, discord_url, store_url, api_token)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
     RETURNING *`,
    [
      u.id, name.trim(), ip.trim().toLowerCase(), parseInt(port) || 25565,
      (description || '').slice(0, 5000), country || 'United States',
      JSON.stringify(safeTags), (version || '1.21').slice(0, 20),
      Math.min(1000000, parseInt(max_players) || 100),
      (website_url || '').slice(0, 255), (discord_url || '').slice(0, 255),
      (store_url || '').slice(0, 255), api_token
    ]
  );

  const data = rows[0];

  await auditLog({
    actorType: 'user', actorId: u.id,
    action: 'server_created', targetType: 'server', targetId: data.id,
    details: { name: data.name, ip: data.ip }
  });

  res.status(201).json({ server: data, api_token });
});

// ── Update server (owner only) ───────────────────────────────
router.put('/:id', requireUser, express.json(), async (req, res) => {
  const u = req.session.user;
  const { rows: serverRows } = await pool.query('SELECT owner_id FROM servers WHERE id = $1', [req.params.id]);
  if (serverRows.length === 0) return res.status(404).json({ error: 'Server not found' });
  if (serverRows[0].owner_id !== u.id) return res.status(403).json({ error: 'Not your server' });

  const allowed = ['name', 'description', 'country', 'tags', 'version', 'max_players', 'website_url', 'discord_url', 'store_url', 'banner_url'];
  const updates = {};
  for (const key of allowed) {
    if (req.body[key] !== undefined) updates[key] = req.body[key];
  }
  if (updates.name && updates.name.length > 60) return res.status(400).json({ error: 'Name too long' });
  if (updates.tags && Array.isArray(updates.tags)) updates.tags = updates.tags.slice(0, 10);

  if (Object.keys(updates).length === 0) return res.status(400).json({ error: 'No valid fields to update' });

  const setClauses = [];
  const params = [];
  let paramIdx = 1;
  for (const [key, val] of Object.entries(updates)) {
    if (key === 'tags') {
      setClauses.push(`${key} = $${paramIdx}::jsonb`);
      params.push(JSON.stringify(val));
    } else {
      setClauses.push(`${key} = $${paramIdx}`);
      params.push(val);
    }
    paramIdx++;
  }
  params.push(req.params.id);

  const { rows } = await pool.query(
    `UPDATE servers SET ${setClauses.join(', ')} WHERE id = $${paramIdx} RETURNING *`,
    params
  );

  res.json(rows[0]);
});

// ── Delete server (owner only) ───────────────────────────────
router.delete('/:id', requireUser, async (req, res) => {
  const u = req.session.user;
  const { rows: serverRows } = await pool.query('SELECT owner_id FROM servers WHERE id = $1', [req.params.id]);
  if (serverRows.length === 0) return res.status(404).json({ error: 'Server not found' });
  if (serverRows[0].owner_id !== u.id) return res.status(403).json({ error: 'Not your server' });

  await pool.query('DELETE FROM servers WHERE id = $1', [req.params.id]);
  res.json({ ok: true });
});

// ── Vote for server ──────────────────────────────────────────
router.post('/:id/vote', requireUser, async (req, res) => {
  const u = req.session.user;
  const serverId = req.params.id;

  // Check server exists
  const { rows: serverRows } = await pool.query(
    'SELECT id FROM servers WHERE id = $1 AND is_banned = false',
    [serverId]
  );
  if (serverRows.length === 0) return res.status(404).json({ error: 'Server not found' });

  // Rate limit: 1 vote per 2 hours per user per server
  const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
  const { rows: recentRows } = await pool.query(
    'SELECT id FROM votes WHERE server_id = $1 AND user_id = $2 AND created_at >= $3 LIMIT 1',
    [serverId, u.id, twoHoursAgo]
  );

  if (recentRows.length > 0) {
    return res.status(429).json({ error: 'You can vote once every 2 hours', next_vote: twoHoursAgo });
  }

  const ip = req.headers['x-forwarded-for']?.split(',')[0] || req.ip;
  await pool.query(
    'INSERT INTO votes (server_id, user_id, voter_ip) VALUES ($1, $2, $3)',
    [serverId, u.id, ip]
  );

  // Increment total_votes
  await pool.query(
    'UPDATE servers SET total_votes = total_votes + 1 WHERE id = $1',
    [serverId]
  );

  res.json({ ok: true, message: 'Vote recorded!' });
});

// ── Get API token (owner only) ───────────────────────────────
router.get('/:id/token', requireUser, async (req, res) => {
  const u = req.session.user;
  const { rows } = await pool.query('SELECT api_token, owner_id FROM servers WHERE id = $1', [req.params.id]);
  if (rows.length === 0) return res.status(404).json({ error: 'Server not found' });
  if (rows[0].owner_id !== u.id) return res.status(403).json({ error: 'Not your server' });
  res.json({ api_token: rows[0].api_token });
});

// ── Regenerate API token (owner only) ────────────────────────
router.post('/:id/regenerate-token', requireUser, async (req, res) => {
  const u = req.session.user;
  const { rows: serverRows } = await pool.query('SELECT owner_id FROM servers WHERE id = $1', [req.params.id]);
  if (serverRows.length === 0) return res.status(404).json({ error: 'Server not found' });
  if (serverRows[0].owner_id !== u.id) return res.status(403).json({ error: 'Not your server' });

  const newToken = 'el_' + crypto.randomBytes(24).toString('hex');
  await pool.query('UPDATE servers SET api_token = $1 WHERE id = $2', [newToken, req.params.id]);
  res.json({ api_token: newToken });
});

module.exports = router;
