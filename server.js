require('dotenv').config();
const express = require('express');
const session = require('express-session');
const passport = require('passport');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// ── Security ─────────────────────────────────────────────────
app.use(helmet({
  contentSecurityPolicy: false,     // allow inline scripts/styles in our pages
  crossOriginEmbedderPolicy: false
}));

// ── Rate limiting ────────────────────────────────────────────
app.use('/api/', rateLimit({ windowMs: 60_000, max: 120, message: { error: 'Rate limit exceeded' } }));
app.use('/auth/', rateLimit({ windowMs: 60_000, max: 20, message: { error: 'Too many auth requests' } }));

// ── Body parsing ─────────────────────────────────────────────
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true, limit: '1mb' }));

// ── Sessions (stored in memory for dev — swap to pg/Redis in prod) ──
app.use(session({
  secret: process.env.SESSION_SECRET || 'dev-secret-change-me',
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: process.env.NODE_ENV === 'production',
    httpOnly: true,
    maxAge: 7 * 24 * 60 * 60 * 1000,   // 7 days
    sameSite: 'lax'
  }
}));

// ── Passport ─────────────────────────────────────────────────
app.use(passport.initialize());
app.use(passport.session());

// ── Static files ─────────────────────────────────────────────
app.use('/uploads', express.static(path.join(__dirname, 'public/uploads')));
app.use(express.static(path.join(__dirname, 'public')));

// ── Routes ───────────────────────────────────────────────────
app.use('/auth',    require('./routes/auth'));
app.use('/servers', require('./routes/servers'));
app.use('/api/v1',  require('./routes/api'));
app.use('/admin',   require('./routes/admin'));

// ── Page routes (serve HTML files) ───────────────────────────
const pages = ['add-server', 'faq', 'privacy', 'terms', 'api-docs', 'advertise', 'auth-login'];
pages.forEach(page => {
  app.get(`/${page}`, (req, res) => {
    res.sendFile(`${page}.html`, { root: path.join(__dirname, 'public') });
  });
});

// ── SPA fallback — serve index.html for client-side routing ──
app.get('/', (req, res) => {
  res.sendFile('index.html', { root: path.join(__dirname, 'public') });
});

// ── Error handler ────────────────────────────────────────────
app.use((err, req, res, next) => {
  console.error('[ERROR]', err.message);
  res.status(err.status || 500).json({
    error: process.env.NODE_ENV === 'production' ? 'Internal server error' : err.message
  });
});

// ── Start ────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n  ⬢ Ender List running at http://localhost:${PORT}\n`);
});
