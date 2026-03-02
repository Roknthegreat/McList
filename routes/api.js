const express = require('express');
const { pool } = require('../db');
const { requireApiToken } = require('../middleware');
const router = express.Router();

// ── GET /api/v1/server — Get your server info ────────────────
router.get('/server', requireApiToken, async (req, res) => {
  const { rows } = await pool.query(
    `SELECT id, name, ip, port, player_count, max_players, is_online, total_votes,
     version, tags, is_featured, created_at, updated_at
     FROM servers WHERE id = $1`,
    [req.apiServer.id]
  );
  res.json(rows[0]);
});

// ── POST /api/v1/server/heartbeat — Update player count ──────
router.post('/server/heartbeat', requireApiToken, express.json(), async (req, res) => {
  const { player_count, max_players, is_online } = req.body;
  const sid = req.apiServer.id;

  const updates = { is_online: is_online !== false };
  if (typeof player_count === 'number' && player_count >= 0) updates.player_count = Math.min(player_count, 1000000);
  if (typeof max_players === 'number' && max_players > 0) updates.max_players = Math.min(max_players, 1000000);

  const setClauses = [];
  const params = [];
  let paramIdx = 1;
  for (const [key, val] of Object.entries(updates)) {
    setClauses.push(`${key} = $${paramIdx}`);
    params.push(val);
    paramIdx++;
  }
  params.push(sid);

  await pool.query(
    `UPDATE servers SET ${setClauses.join(', ')} WHERE id = $${paramIdx}`,
    params
  );

  // Record metric snapshot
  await pool.query(
    'INSERT INTO server_metrics (server_id, player_count, is_online) VALUES ($1, $2, $3)',
    [sid, updates.player_count || 0, updates.is_online]
  );

  res.json({ ok: true, recorded: updates });
});

// ── GET /api/v1/server/votes — Get recent votes ─────────────
router.get('/server/votes', requireApiToken, async (req, res) => {
  const since = req.query.since || new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const { rows } = await pool.query(
    `SELECT mc_username, created_at FROM votes
     WHERE server_id = $1 AND created_at >= $2
     ORDER BY created_at DESC LIMIT 100`,
    [req.apiServer.id, since]
  );

  const { rows: countRows } = await pool.query(
    'SELECT COUNT(*) FROM votes WHERE server_id = $1 AND created_at >= $2',
    [req.apiServer.id, since]
  );

  res.json({ votes: rows, total: parseInt(countRows[0].count), since });
});

// ── GET /api/v1/server/metrics — Get player history ──────────
router.get('/server/metrics', requireApiToken, async (req, res) => {
  const hours = Math.min(168, parseInt(req.query.hours) || 24); // max 7 days
  const since = new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();

  const { rows } = await pool.query(
    `SELECT player_count, is_online, recorded_at FROM server_metrics
     WHERE server_id = $1 AND recorded_at >= $2
     ORDER BY recorded_at ASC`,
    [req.apiServer.id, since]
  );

  res.json({ metrics: rows, hours });
});

// ── POST /api/v1/server/vote/check — Check if user voted ────
router.post('/server/vote/check', requireApiToken, express.json(), async (req, res) => {
  const { username } = req.body;
  if (!username) return res.status(400).json({ error: 'username required' });

  const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
  const { rows } = await pool.query(
    `SELECT created_at FROM votes
     WHERE server_id = $1 AND mc_username = $2 AND created_at >= $3 LIMIT 1`,
    [req.apiServer.id, username, twoHoursAgo]
  );

  res.json({ has_voted: rows.length > 0, username });
});

// ── GET /api/v1/server/top-voters — Top voters this month ────
router.get('/server/top-voters', requireApiToken, async (req, res) => {
  const monthStart = new Date();
  monthStart.setDate(1); monthStart.setHours(0, 0, 0, 0);

  const { rows } = await pool.query(
    `SELECT mc_username, COUNT(*) AS votes FROM votes
     WHERE server_id = $1 AND created_at >= $2 AND mc_username IS NOT NULL
     GROUP BY mc_username ORDER BY votes DESC LIMIT 10`,
    [req.apiServer.id, monthStart.toISOString()]
  );

  res.json({ top_voters: rows.map(r => ({ username: r.mc_username, votes: parseInt(r.votes) })) });
});

// ── Public: Get ads for display ──────────────────────────────
router.get('/ads', async (req, res) => {
  const placement = req.query.placement || 'banner';
  const { rows } = await pool.query(
    `SELECT id, name, href, image_url, placement FROM ads
     WHERE is_active = true AND placement = $1
     ORDER BY created_at DESC`,
    [placement]
  );

  // Track impressions
  if (rows.length > 0) {
    const ids = rows.map(a => a.id);
    pool.query(
      `UPDATE ads SET impressions = impressions + 1 WHERE id = ANY($1)`,
      [ids]
    ).catch(() => {});
  }

  res.json(rows);
});

// ── Track ad click ───────────────────────────────────────────
router.post('/ads/:id/click', async (req, res) => {
  await pool.query(
    'UPDATE ads SET clicks = clicks + 1 WHERE id = $1',
    [req.params.id]
  );
  res.json({ ok: true });
});

module.exports = router;
