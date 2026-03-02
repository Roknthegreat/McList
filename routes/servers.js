const express = require('express');
const crypto = require('crypto');
const supabase = require('../db');
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

  let query = supabase
    .from('servers')
    .select('id, name, ip, port, description, country, tags, banner_url, version, player_count, max_players, total_votes, is_online, is_featured, featured_until, owner_id, created_at', { count: 'exact' })
    .eq('is_approved', true)
    .eq('is_banned', false);

  if (tag && tag !== 'All') query = query.contains('tags', JSON.stringify([tag]));
  if (search) query = query.or(`name.ilike.%${search}%,ip.ilike.%${search}%`);

  // Sort: featured first, then by metric
  if (sort === 'players')  query = query.order('is_featured', { ascending: false }).order('player_count', { ascending: false });
  else if (sort === 'newest') query = query.order('is_featured', { ascending: false }).order('created_at', { ascending: false });
  else query = query.order('is_featured', { ascending: false }).order('total_votes', { ascending: false });

  query = query.range(offset, offset + limit - 1);
  const { data, count, error } = await query;
  if (error) return res.status(500).json({ error: error.message });

  res.json({
    servers: data || [],
    total: count || 0,
    page,
    pages: Math.ceil((count || 0) / limit)
  });
});

// ── Get single server ────────────────────────────────────────
router.get('/:id', async (req, res) => {
  const { data, error } = await supabase
    .from('servers')
    .select('*')
    .eq('id', req.params.id)
    .eq('is_banned', false)
    .single();

  if (error || !data) return res.status(404).json({ error: 'Server not found' });

  // Get recent metrics
  const { data: metrics } = await supabase
    .from('server_metrics')
    .select('player_count, is_online, recorded_at')
    .eq('server_id', data.id)
    .order('recorded_at', { ascending: false })
    .limit(48);

  // Get vote count for this month
  const monthStart = new Date();
  monthStart.setDate(1); monthStart.setHours(0, 0, 0, 0);
  const { count: monthVotes } = await supabase
    .from('votes')
    .select('*', { count: 'exact', head: true })
    .eq('server_id', data.id)
    .gte('created_at', monthStart.toISOString());

  // Remove api_token from public response
  const { api_token, banned_by, ...safe } = data;
  res.json({ ...safe, metrics: metrics || [], month_votes: monthVotes || 0 });
});

// ── Add server (requires login) ──────────────────────────────
router.post('/', requireUser, express.json(), async (req, res) => {
  const u = req.session.user;
  const { name, ip, port, description, country, tags, version, max_players, website_url, discord_url, store_url } = req.body;

  if (!name || !ip) return res.status(400).json({ error: 'Server name and IP are required' });
  if (name.length > 60) return res.status(400).json({ error: 'Name must be 60 characters or less' });
  if (ip.length > 253) return res.status(400).json({ error: 'Invalid IP address' });

  // Check duplicate IP
  const { data: dup } = await supabase.from('servers').select('id').eq('ip', ip).single();
  if (dup) return res.status(409).json({ error: 'A server with this IP already exists' });

  // Check owner limit (max 10 servers per user)
  const { count } = await supabase
    .from('servers')
    .select('*', { count: 'exact', head: true })
    .eq('owner_id', u.id);
  if (count >= 10) return res.status(400).json({ error: 'Maximum 10 servers per account' });

  const api_token = 'el_' + crypto.randomBytes(24).toString('hex');
  const safeTags = Array.isArray(tags) ? tags.slice(0, 10) : [];

  const { data, error } = await supabase
    .from('servers')
    .insert({
      owner_id: u.id,
      name: name.trim(),
      ip: ip.trim().toLowerCase(),
      port: parseInt(port) || 25565,
      description: (description || '').slice(0, 5000),
      country: country || 'United States',
      tags: safeTags,
      version: (version || '1.21').slice(0, 20),
      max_players: Math.min(1000000, parseInt(max_players) || 100),
      website_url: (website_url || '').slice(0, 255),
      discord_url: (discord_url || '').slice(0, 255),
      store_url: (store_url || '').slice(0, 255),
      api_token
    })
    .select()
    .single();

  if (error) return res.status(500).json({ error: error.message });

  // Audit log
  await supabase.from('audit_log').insert({
    actor_type: 'user', actor_id: u.id,
    action: 'server_created', target_type: 'server', target_id: data.id,
    details: { name: data.name, ip: data.ip }
  });

  res.status(201).json({ server: data, api_token });
});

// ── Update server (owner only) ───────────────────────────────
router.put('/:id', requireUser, express.json(), async (req, res) => {
  const u = req.session.user;
  const { data: server } = await supabase.from('servers').select('owner_id').eq('id', req.params.id).single();
  if (!server) return res.status(404).json({ error: 'Server not found' });
  if (server.owner_id !== u.id) return res.status(403).json({ error: 'Not your server' });

  const allowed = ['name', 'description', 'country', 'tags', 'version', 'max_players', 'website_url', 'discord_url', 'store_url', 'banner_url'];
  const updates = {};
  for (const key of allowed) {
    if (req.body[key] !== undefined) updates[key] = req.body[key];
  }
  if (updates.name && updates.name.length > 60) return res.status(400).json({ error: 'Name too long' });
  if (updates.tags && Array.isArray(updates.tags)) updates.tags = updates.tags.slice(0, 10);

  const { data, error } = await supabase.from('servers').update(updates).eq('id', req.params.id).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// ── Delete server (owner only) ───────────────────────────────
router.delete('/:id', requireUser, async (req, res) => {
  const u = req.session.user;
  const { data: server } = await supabase.from('servers').select('owner_id').eq('id', req.params.id).single();
  if (!server) return res.status(404).json({ error: 'Server not found' });
  if (server.owner_id !== u.id) return res.status(403).json({ error: 'Not your server' });

  await supabase.from('servers').delete().eq('id', req.params.id);
  res.json({ ok: true });
});

// ── Vote for server ──────────────────────────────────────────
router.post('/:id/vote', requireUser, async (req, res) => {
  const u = req.session.user;
  const serverId = req.params.id;

  // Check server exists
  const { data: server } = await supabase.from('servers').select('id').eq('id', serverId).eq('is_banned', false).single();
  if (!server) return res.status(404).json({ error: 'Server not found' });

  // Rate limit: 1 vote per 2 hours per user per server
  const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
  const { data: recent } = await supabase
    .from('votes')
    .select('id')
    .eq('server_id', serverId)
    .eq('user_id', u.id)
    .gte('created_at', twoHoursAgo)
    .limit(1);

  if (recent && recent.length > 0) {
    return res.status(429).json({ error: 'You can vote once every 2 hours', next_vote: twoHoursAgo });
  }

  const ip = req.headers['x-forwarded-for']?.split(',')[0] || req.ip;
  await supabase.from('votes').insert({
    server_id: serverId,
    user_id: u.id,
    voter_ip: ip
  });

  // Increment total_votes
  await supabase.rpc('increment_votes', { sid: serverId }).catch(() => {
    // Fallback: manual increment
    supabase.from('servers')
      .select('total_votes')
      .eq('id', serverId)
      .single()
      .then(({ data: s }) => {
        if (s) supabase.from('servers').update({ total_votes: (s.total_votes || 0) + 1 }).eq('id', serverId).then(() => {});
      });
  });

  res.json({ ok: true, message: 'Vote recorded!' });
});

// ── Get API token (owner only) ───────────────────────────────
router.get('/:id/token', requireUser, async (req, res) => {
  const u = req.session.user;
  const { data } = await supabase.from('servers').select('api_token, owner_id').eq('id', req.params.id).single();
  if (!data) return res.status(404).json({ error: 'Server not found' });
  if (data.owner_id !== u.id) return res.status(403).json({ error: 'Not your server' });
  res.json({ api_token: data.api_token });
});

// ── Regenerate API token (owner only) ────────────────────────
router.post('/:id/regenerate-token', requireUser, async (req, res) => {
  const u = req.session.user;
  const { data: server } = await supabase.from('servers').select('owner_id').eq('id', req.params.id).single();
  if (!server) return res.status(404).json({ error: 'Server not found' });
  if (server.owner_id !== u.id) return res.status(403).json({ error: 'Not your server' });

  const newToken = 'el_' + crypto.randomBytes(24).toString('hex');
  await supabase.from('servers').update({ api_token: newToken }).eq('id', req.params.id);
  res.json({ api_token: newToken });
});

module.exports = router;
