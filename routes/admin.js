const express = require('express');
const bcrypt = require('bcryptjs');
const supabase = require('../db');
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
    supabase.from('servers').select('*', { count: 'exact', head: true }),
    supabase.from('users').select('*', { count: 'exact', head: true }),
    supabase.from('votes').select('*', { count: 'exact', head: true }),
    supabase.from('bans').select('*', { count: 'exact', head: true }).eq('is_active', true),
    supabase.from('ads').select('*', { count: 'exact', head: true }).eq('is_active', true),
  ]);

  // Online servers
  const { count: onlineCount } = await supabase
    .from('servers').select('*', { count: 'exact', head: true }).eq('is_online', true).eq('is_banned', false);

  // Total player count
  const { data: playerData } = await supabase
    .from('servers').select('player_count').eq('is_online', true).eq('is_banned', false);
  const totalPlayers = (playerData || []).reduce((sum, s) => sum + (s.player_count || 0), 0);

  // Featured count
  const { count: featuredCount } = await supabase
    .from('servers').select('*', { count: 'exact', head: true }).eq('is_featured', true);

  res.json({
    total_servers: servers.count || 0,
    online_servers: onlineCount || 0,
    total_users: users.count || 0,
    total_votes: votes.count || 0,
    total_players: totalPlayers,
    active_bans: bans.count || 0,
    active_ads: ads.count || 0,
    featured_servers: featuredCount || 0
  });
});

// ── List all servers (admin view) ────────────────────────────
router.get('/servers', requireStaff, async (req, res) => {
  const page = Math.max(1, parseInt(req.query.page) || 1);
  const limit = 25;
  const offset = (page - 1) * limit;
  const search = req.query.q || '';

  let query = supabase
    .from('servers')
    .select('id, name, ip, owner_id, player_count, total_votes, is_online, is_featured, featured_until, is_banned, ban_reason, created_at', { count: 'exact' });

  if (search) query = query.or(`name.ilike.%${search}%,ip.ilike.%${search}%`);
  query = query.order('created_at', { ascending: false }).range(offset, offset + limit - 1);

  const { data, count } = await query;
  res.json({ servers: data || [], total: count || 0, page, pages: Math.ceil((count || 0) / limit) });
});

// ── Feature a server (30 days) ───────────────────────────────
router.post('/servers/:id/feature', requireStaff, requirePermission('feature_servers'), async (req, res) => {
  const featuredUntil = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();

  const { error } = await supabase
    .from('servers')
    .update({ is_featured: true, featured_until: featuredUntil })
    .eq('id', req.params.id);

  if (error) return res.status(500).json({ error: error.message });

  await supabase.from('audit_log').insert({
    actor_type: 'staff', actor_id: req.session.staff.id,
    action: 'server_featured', target_type: 'server', target_id: req.params.id,
    details: { featured_until: featuredUntil }
  });

  res.json({ ok: true, featured_until: featuredUntil });
});

// ── Unfeature a server ───────────────────────────────────────
router.delete('/servers/:id/feature', requireStaff, requirePermission('feature_servers'), async (req, res) => {
  await supabase.from('servers').update({ is_featured: false, featured_until: null }).eq('id', req.params.id);

  await supabase.from('audit_log').insert({
    actor_type: 'staff', actor_id: req.session.staff.id,
    action: 'server_unfeatured', target_type: 'server', target_id: req.params.id
  });

  res.json({ ok: true });
});

// ── Ban a server ─────────────────────────────────────────────
router.post('/servers/:id/ban', requireStaff, requirePermission('ban_servers'), express.json(), async (req, res) => {
  const { reason } = req.body;
  if (!reason) return res.status(400).json({ error: 'Ban reason required' });

  await supabase.from('servers').update({
    is_banned: true, ban_reason: reason, banned_by: req.session.staff.id
  }).eq('id', req.params.id);

  await supabase.from('bans').insert({
    target_type: 'server', target_id: req.params.id,
    reason, banned_by: req.session.staff.id
  });

  await supabase.from('audit_log').insert({
    actor_type: 'staff', actor_id: req.session.staff.id,
    action: 'server_banned', target_type: 'server', target_id: req.params.id,
    details: { reason }
  });

  res.json({ ok: true });
});

// ── Unban a server ───────────────────────────────────────────
router.delete('/servers/:id/ban', requireStaff, requirePermission('ban_servers'), async (req, res) => {
  await supabase.from('servers').update({
    is_banned: false, ban_reason: null, banned_by: null
  }).eq('id', req.params.id);

  await supabase.from('bans').update({ is_active: false })
    .eq('target_type', 'server').eq('target_id', req.params.id).eq('is_active', true);

  await supabase.from('audit_log').insert({
    actor_type: 'staff', actor_id: req.session.staff.id,
    action: 'server_unbanned', target_type: 'server', target_id: req.params.id
  });

  res.json({ ok: true });
});

// ── Ban a user ───────────────────────────────────────────────
router.post('/users/:id/ban', requireStaff, requirePermission('ban_users'), express.json(), async (req, res) => {
  const { reason } = req.body;
  if (!reason) return res.status(400).json({ error: 'Ban reason required' });

  await supabase.from('users').update({ is_banned: true, ban_reason: reason }).eq('id', req.params.id);
  await supabase.from('bans').insert({
    target_type: 'user', target_id: req.params.id,
    reason, banned_by: req.session.staff.id
  });

  await supabase.from('audit_log').insert({
    actor_type: 'staff', actor_id: req.session.staff.id,
    action: 'user_banned', target_type: 'user', target_id: req.params.id,
    details: { reason }
  });

  res.json({ ok: true });
});

// ── Unban a user ─────────────────────────────────────────────
router.delete('/users/:id/ban', requireStaff, requirePermission('ban_users'), async (req, res) => {
  await supabase.from('users').update({ is_banned: false, ban_reason: null }).eq('id', req.params.id);
  await supabase.from('bans').update({ is_active: false })
    .eq('target_type', 'user').eq('target_id', req.params.id).eq('is_active', true);

  await supabase.from('audit_log').insert({
    actor_type: 'staff', actor_id: req.session.staff.id,
    action: 'user_unbanned', target_type: 'user', target_id: req.params.id
  });

  res.json({ ok: true });
});

// ── List users (admin view) ──────────────────────────────────
router.get('/users', requireStaff, async (req, res) => {
  const page = Math.max(1, parseInt(req.query.page) || 1);
  const limit = 25;
  const offset = (page - 1) * limit;
  const search = req.query.q || '';

  let query = supabase
    .from('users')
    .select('id, username, email, avatar, oauth_provider, is_banned, ban_reason, created_at', { count: 'exact' });

  if (search) query = query.or(`username.ilike.%${search}%,email.ilike.%${search}%`);
  query = query.order('created_at', { ascending: false }).range(offset, offset + limit - 1);

  const { data, count } = await query;
  res.json({ users: data || [], total: count || 0, page, pages: Math.ceil((count || 0) / limit) });
});

// ── List bans ────────────────────────────────────────────────
router.get('/bans', requireStaff, async (req, res) => {
  const { data } = await supabase
    .from('bans')
    .select('*')
    .eq('is_active', true)
    .order('created_at', { ascending: false })
    .limit(100);
  res.json(data || []);
});

// ── Ads management ───────────────────────────────────────────
router.get('/ads', requireStaff, async (req, res) => {
  const { data } = await supabase.from('ads').select('*').order('created_at', { ascending: false });
  res.json(data || []);
});

router.post('/ads', requireStaff, requirePermission('manage_ads'), express.json(), async (req, res) => {
  const { name, href, image_url, placement } = req.body;
  if (!name || !href || !image_url) return res.status(400).json({ error: 'Name, href, and image URL required' });

  const { data, error } = await supabase.from('ads').insert({
    name, href, image_url,
    placement: placement || 'banner'
  }).select().single();

  if (error) return res.status(500).json({ error: error.message });

  await supabase.from('audit_log').insert({
    actor_type: 'staff', actor_id: req.session.staff.id,
    action: 'ad_created', target_type: 'ad', target_id: data.id,
    details: { name, href }
  });

  res.status(201).json(data);
});

router.put('/ads/:id', requireStaff, requirePermission('manage_ads'), express.json(), async (req, res) => {
  const allowed = ['name', 'href', 'image_url', 'placement', 'is_active'];
  const updates = {};
  for (const k of allowed) { if (req.body[k] !== undefined) updates[k] = req.body[k]; }

  const { data, error } = await supabase.from('ads').update(updates).eq('id', req.params.id).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

router.delete('/ads/:id', requireStaff, requirePermission('manage_ads'), async (req, res) => {
  await supabase.from('ads').delete().eq('id', req.params.id);

  await supabase.from('audit_log').insert({
    actor_type: 'staff', actor_id: req.session.staff.id,
    action: 'ad_deleted', target_type: 'ad', target_id: req.params.id
  });

  res.json({ ok: true });
});

// ── Staff management (owner only) ────────────────────────────
router.get('/staff', requireStaff, requireRole('owner', 'admin'), async (req, res) => {
  const { data } = await supabase.from('staff')
    .select('id, username, display_name, role, permissions, created_at')
    .order('created_at', { ascending: true });
  res.json(data || []);
});

router.post('/staff', requireStaff, requireRole('owner'), express.json(), async (req, res) => {
  const { username, password, display_name, role, permissions } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Username and password required' });
  if (password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });

  const validRoles = ['moderator', 'admin'];
  const safeRole = validRoles.includes(role) ? role : 'moderator';
  const validPerms = ['feature_servers', 'ban_servers', 'ban_users', 'manage_ads', 'view_audit'];
  const safePerms = (permissions || []).filter(p => validPerms.includes(p));

  const hash = bcrypt.hashSync(password, 12);
  const { data, error } = await supabase.from('staff').insert({
    username: username.toLowerCase().trim(),
    password_hash: hash,
    display_name: display_name || username,
    role: safeRole,
    permissions: safePerms,
    created_by: req.session.staff.id
  }).select('id, username, display_name, role, permissions, created_at').single();

  if (error) {
    if (error.message.includes('unique')) return res.status(409).json({ error: 'Username already taken' });
    return res.status(500).json({ error: error.message });
  }

  await supabase.from('audit_log').insert({
    actor_type: 'staff', actor_id: req.session.staff.id,
    action: 'staff_created', target_type: 'staff', target_id: data.id,
    details: { username: data.username, role: safeRole }
  });

  res.status(201).json(data);
});

router.put('/staff/:id', requireStaff, requireRole('owner'), express.json(), async (req, res) => {
  const { role, permissions, display_name } = req.body;
  const updates = {};

  if (display_name) updates.display_name = display_name;
  if (role && ['moderator', 'admin'].includes(role)) updates.role = role;
  if (Array.isArray(permissions)) {
    const validPerms = ['feature_servers', 'ban_servers', 'ban_users', 'manage_ads', 'view_audit'];
    updates.permissions = permissions.filter(p => validPerms.includes(p));
  }

  const { data, error } = await supabase.from('staff').update(updates)
    .eq('id', req.params.id).select('id, username, display_name, role, permissions').single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

router.delete('/staff/:id', requireStaff, requireRole('owner'), async (req, res) => {
  if (req.params.id === req.session.staff.id) return res.status(400).json({ error: 'Cannot delete yourself' });
  await supabase.from('staff').delete().eq('id', req.params.id);
  res.json({ ok: true });
});

// ── Audit log ────────────────────────────────────────────────
router.get('/audit', requireStaff, requirePermission('view_audit'), async (req, res) => {
  const { data } = await supabase
    .from('audit_log')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(100);
  res.json(data || []);
});

// ── Current staff info ───────────────────────────────────────
router.get('/me', requireStaff, (req, res) => {
  res.json(req.session.staff);
});

module.exports = router;
