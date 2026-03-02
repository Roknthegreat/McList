const express = require('express');
const supabase = require('../db');
const { requireApiToken } = require('../middleware');
const router = express.Router();

// ── GET /api/v1/server — Get your server info ────────────────
router.get('/server', requireApiToken, async (req, res) => {
  const { data } = await supabase
    .from('servers')
    .select('id, name, ip, port, player_count, max_players, is_online, total_votes, version, tags, is_featured, created_at, updated_at')
    .eq('id', req.apiServer.id)
    .single();
  res.json(data);
});

// ── POST /api/v1/server/heartbeat — Update player count ──────
router.post('/server/heartbeat', requireApiToken, express.json(), async (req, res) => {
  const { player_count, max_players, is_online } = req.body;
  const sid = req.apiServer.id;

  const updates = { is_online: is_online !== false };
  if (typeof player_count === 'number' && player_count >= 0) updates.player_count = Math.min(player_count, 1000000);
  if (typeof max_players === 'number' && max_players > 0) updates.max_players = Math.min(max_players, 1000000);

  await supabase.from('servers').update(updates).eq('id', sid);

  // Record metric snapshot
  await supabase.from('server_metrics').insert({
    server_id: sid,
    player_count: updates.player_count || 0,
    is_online: updates.is_online
  });

  res.json({ ok: true, recorded: updates });
});

// ── GET /api/v1/server/votes — Get recent votes ─────────────
router.get('/server/votes', requireApiToken, async (req, res) => {
  const since = req.query.since || new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const { data, count } = await supabase
    .from('votes')
    .select('mc_username, created_at', { count: 'exact' })
    .eq('server_id', req.apiServer.id)
    .gte('created_at', since)
    .order('created_at', { ascending: false })
    .limit(100);

  res.json({ votes: data || [], total: count || 0, since });
});

// ── GET /api/v1/server/metrics — Get player history ──────────
router.get('/server/metrics', requireApiToken, async (req, res) => {
  const hours = Math.min(168, parseInt(req.query.hours) || 24); // max 7 days
  const since = new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();

  const { data } = await supabase
    .from('server_metrics')
    .select('player_count, is_online, recorded_at')
    .eq('server_id', req.apiServer.id)
    .gte('recorded_at', since)
    .order('recorded_at', { ascending: true });

  res.json({ metrics: data || [], hours });
});

// ── POST /api/v1/server/vote/check — Check if user voted ────
router.post('/server/vote/check', requireApiToken, express.json(), async (req, res) => {
  const { username } = req.body;
  if (!username) return res.status(400).json({ error: 'username required' });

  const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
  const { data } = await supabase
    .from('votes')
    .select('created_at')
    .eq('server_id', req.apiServer.id)
    .eq('mc_username', username)
    .gte('created_at', twoHoursAgo)
    .limit(1);

  res.json({ has_voted: data && data.length > 0, username });
});

// ── GET /api/v1/server/top-voters — Top voters this month ────
router.get('/server/top-voters', requireApiToken, async (req, res) => {
  const monthStart = new Date();
  monthStart.setDate(1); monthStart.setHours(0, 0, 0, 0);

  const { data } = await supabase
    .from('votes')
    .select('mc_username')
    .eq('server_id', req.apiServer.id)
    .gte('created_at', monthStart.toISOString());

  // Count by username
  const counts = {};
  (data || []).forEach(v => {
    if (v.mc_username) counts[v.mc_username] = (counts[v.mc_username] || 0) + 1;
  });

  const top = Object.entries(counts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([username, votes]) => ({ username, votes }));

  res.json({ top_voters: top });
});

// ── Public: Get ads for display ──────────────────────────────
router.get('/ads', async (req, res) => {
  const placement = req.query.placement || 'banner';
  const { data } = await supabase
    .from('ads')
    .select('id, name, href, image_url, placement')
    .eq('is_active', true)
    .eq('placement', placement)
    .order('created_at', { ascending: false });

  // Track impressions
  if (data && data.length > 0) {
    for (const ad of data) {
      supabase.from('ads').update({ impressions: ad.impressions + 1 }).eq('id', ad.id).then(() => {});
    }
  }
  res.json(data || []);
});

// ── Track ad click ───────────────────────────────────────────
router.post('/ads/:id/click', async (req, res) => {
  await supabase.rpc('increment_ad_clicks', { aid: req.params.id }).catch(async () => {
    const { data: ad } = await supabase.from('ads').select('clicks').eq('id', req.params.id).single();
    if (ad) await supabase.from('ads').update({ clicks: (ad.clicks || 0) + 1 }).eq('id', req.params.id);
  });
  res.json({ ok: true });
});

module.exports = router;
