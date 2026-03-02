const express = require('express');
const passport = require('passport');
const GoogleStrategy = require('passport-google-oauth20').Strategy;
const DiscordStrategy = require('passport-discord').Strategy;
const bcrypt = require('bcryptjs');
const supabase = require('../db');
const router = express.Router();

// ── Passport serialization ───────────────────────────────────
passport.serializeUser((user, done) => done(null, user));
passport.deserializeUser((user, done) => done(null, user));

// ── Google OAuth ─────────────────────────────────────────────
if (process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_ID !== 'your-google-client-id') {
  passport.use(new GoogleStrategy({
    clientID: process.env.GOOGLE_CLIENT_ID,
    clientSecret: process.env.GOOGLE_CLIENT_SECRET,
    callbackURL: `${process.env.BASE_URL}/auth/google/callback`
  }, async (accessToken, refreshToken, profile, done) => {
    try {
      const { data: existing } = await supabase
        .from('users')
        .select('*')
        .eq('oauth_provider', 'google')
        .eq('oauth_id', profile.id)
        .single();

      if (existing) {
        if (existing.is_banned) return done(null, false, { message: 'Account banned: ' + existing.ban_reason });
        return done(null, existing);
      }

      const { data: newUser } = await supabase
        .from('users')
        .insert({
          oauth_provider: 'google',
          oauth_id: profile.id,
          username: profile.displayName,
          email: profile.emails?.[0]?.value,
          avatar: profile.photos?.[0]?.value
        })
        .select()
        .single();

      done(null, newUser);
    } catch (err) { done(err); }
  }));
}

// ── Discord OAuth ────────────────────────────────────────────
if (process.env.DISCORD_CLIENT_ID && process.env.DISCORD_CLIENT_ID !== 'your-discord-client-id') {
  passport.use(new DiscordStrategy({
    clientID: process.env.DISCORD_CLIENT_ID,
    clientSecret: process.env.DISCORD_CLIENT_SECRET,
    callbackURL: `${process.env.BASE_URL}/auth/discord/callback`,
    scope: ['identify', 'email']
  }, async (accessToken, refreshToken, profile, done) => {
    try {
      const { data: existing } = await supabase
        .from('users')
        .select('*')
        .eq('oauth_provider', 'discord')
        .eq('oauth_id', profile.id)
        .single();

      if (existing) {
        if (existing.is_banned) return done(null, false, { message: 'Account banned' });
        return done(null, existing);
      }

      const avatar = profile.avatar
        ? `https://cdn.discordapp.com/avatars/${profile.id}/${profile.avatar}.png`
        : null;

      const { data: newUser } = await supabase
        .from('users')
        .insert({
          oauth_provider: 'discord',
          oauth_id: profile.id,
          username: profile.username,
          email: profile.email,
          avatar
        })
        .select()
        .single();

      done(null, newUser);
    } catch (err) { done(err); }
  }));
}

// ── OAuth routes ─────────────────────────────────────────────
router.get('/google', passport.authenticate('google', { scope: ['profile', 'email'] }));
router.get('/google/callback', passport.authenticate('google', { failureRedirect: '/?error=auth' }),
  (req, res) => { req.session.user = req.user; res.redirect('/'); }
);

router.get('/discord', passport.authenticate('discord'));
router.get('/discord/callback', passport.authenticate('discord', { failureRedirect: '/?error=auth' }),
  (req, res) => { req.session.user = req.user; res.redirect('/'); }
);

// ── Login page ───────────────────────────────────────────────
router.get('/login', (req, res) => {
  res.sendFile('auth-login.html', { root: './public' });
});

// ── Current user API ─────────────────────────────────────────
router.get('/me', (req, res) => {
  if (req.session && req.session.user) {
    const u = req.session.user;
    return res.json({ id: u.id, username: u.username, avatar: u.avatar, provider: u.oauth_provider });
  }
  res.json(null);
});

// ── Logout ───────────────────────────────────────────────────
router.post('/logout', (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});
router.get('/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/'));
});

// ── Staff login ──────────────────────────────────────────────
router.post('/staff/login', express.json(), async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Username and password required' });

  const { data: staff } = await supabase
    .from('staff')
    .select('*')
    .eq('username', username.toLowerCase().trim())
    .single();

  if (!staff || !bcrypt.compareSync(password, staff.password_hash)) {
    return res.status(401).json({ error: 'Invalid credentials' });
  }

  req.session.staff = {
    id: staff.id,
    username: staff.username,
    display_name: staff.display_name,
    role: staff.role,
    permissions: staff.permissions || []
  };
  res.json({ ok: true, role: staff.role });
});

router.post('/staff/logout', (req, res) => {
  delete req.session.staff;
  req.session.save(() => res.json({ ok: true }));
});

module.exports = router;
