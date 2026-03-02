// ── Auth & permission middleware ─────────────────────────────

// Require logged-in user (OAuth)
function requireUser(req, res, next) {
  if (req.session && req.session.user) return next();
  if (req.headers.accept && req.headers.accept.includes('application/json')) {
    return res.status(401).json({ error: 'Authentication required' });
  }
  res.redirect('/auth/login');
}

// Require staff session
function requireStaff(req, res, next) {
  if (req.session && req.session.staff) return next();
  if (req.headers.accept && req.headers.accept.includes('application/json')) {
    return res.status(401).json({ error: 'Staff authentication required' });
  }
  res.redirect('/admin/login');
}

// Require specific staff role
function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.session || !req.session.staff) {
      return res.status(401).json({ error: 'Staff authentication required' });
    }
    if (!roles.includes(req.session.staff.role)) {
      return res.status(403).json({ error: 'Insufficient permissions' });
    }
    next();
  };
}

// Require staff permission (or owner/admin bypass)
function requirePermission(perm) {
  return (req, res, next) => {
    if (!req.session || !req.session.staff) {
      return res.status(401).json({ error: 'Staff authentication required' });
    }
    const s = req.session.staff;
    if (s.role === 'owner' || s.role === 'admin') return next();
    const perms = s.permissions || [];
    if (perms.includes(perm)) return next();
    res.status(403).json({ error: `Missing permission: ${perm}` });
  };
}

// Validate API token from header
async function requireApiToken(req, res, next) {
  const token = req.headers['x-api-token'] || req.query.token;
  if (!token) return res.status(401).json({ error: 'API token required. Pass via X-API-Token header.' });

  const supabase = require('../db');
  const { data } = await supabase
    .from('servers')
    .select('id, name, is_banned')
    .eq('api_token', token)
    .single();

  if (!data) return res.status(401).json({ error: 'Invalid API token' });
  if (data.is_banned) return res.status(403).json({ error: 'This server has been banned' });
  req.apiServer = data;
  next();
}

module.exports = { requireUser, requireStaff, requireRole, requirePermission, requireApiToken };
