-- ╔══════════════════════════════════════════════════════════════╗
-- ║  ENDER LIST — Supabase Schema Migration                    ║
-- ║  Run this in the Supabase SQL Editor (Dashboard → SQL)     ║
-- ╚══════════════════════════════════════════════════════════════╝

-- ── USERS ───────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS users (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  oauth_provider TEXT NOT NULL,          -- 'google' | 'discord'
  oauth_id      TEXT NOT NULL,
  username      TEXT,
  email         TEXT,
  avatar        TEXT,
  is_banned     BOOLEAN DEFAULT FALSE,
  ban_reason    TEXT,
  created_at    TIMESTAMPTZ DEFAULT now(),
  UNIQUE(oauth_provider, oauth_id)
);

-- ── STAFF ───────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS staff (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  username      TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  display_name  TEXT,
  role          TEXT DEFAULT 'moderator', -- 'owner' | 'admin' | 'moderator'
  permissions   JSONB DEFAULT '[]'::jsonb,
  created_by    UUID REFERENCES staff(id),
  created_at    TIMESTAMPTZ DEFAULT now()
);

-- ── SERVERS ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS servers (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id      UUID REFERENCES users(id) ON DELETE SET NULL,
  name          TEXT NOT NULL,
  ip            TEXT NOT NULL,
  port          INTEGER DEFAULT 25565,
  description   TEXT DEFAULT '',
  country       TEXT DEFAULT 'United States',
  tags          JSONB DEFAULT '[]'::jsonb,
  banner_url    TEXT,
  website_url   TEXT,
  discord_url   TEXT,
  store_url     TEXT,
  api_token     TEXT UNIQUE NOT NULL,
  version       TEXT DEFAULT '1.21',
  player_count  INTEGER DEFAULT 0,
  max_players   INTEGER DEFAULT 100,
  total_votes   INTEGER DEFAULT 0,
  is_online     BOOLEAN DEFAULT TRUE,
  is_featured   BOOLEAN DEFAULT FALSE,
  featured_until TIMESTAMPTZ,
  is_approved   BOOLEAN DEFAULT TRUE,
  is_banned     BOOLEAN DEFAULT FALSE,
  ban_reason    TEXT,
  banned_by     UUID REFERENCES staff(id),
  created_at    TIMESTAMPTZ DEFAULT now(),
  updated_at    TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_servers_api_token ON servers(api_token);
CREATE INDEX IF NOT EXISTS idx_servers_owner ON servers(owner_id);
CREATE INDEX IF NOT EXISTS idx_servers_featured ON servers(is_featured) WHERE is_featured = TRUE;

-- ── VOTES ───────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS votes (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  server_id     UUID REFERENCES servers(id) ON DELETE CASCADE,
  user_id       UUID REFERENCES users(id) ON DELETE SET NULL,
  voter_ip      TEXT,
  mc_username   TEXT,
  created_at    TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_votes_server ON votes(server_id);
CREATE INDEX IF NOT EXISTS idx_votes_user_server ON votes(user_id, server_id);

-- ── SERVER METRICS (player count snapshots) ─────────────────────
CREATE TABLE IF NOT EXISTS server_metrics (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  server_id     UUID REFERENCES servers(id) ON DELETE CASCADE,
  player_count  INTEGER DEFAULT 0,
  is_online     BOOLEAN DEFAULT TRUE,
  recorded_at   TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_metrics_server ON server_metrics(server_id, recorded_at DESC);

-- ── BANS ────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS bans (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  target_type   TEXT NOT NULL,           -- 'user' | 'server' | 'ip'
  target_id     UUID,
  target_ip     TEXT,
  reason        TEXT NOT NULL,
  banned_by     UUID REFERENCES staff(id),
  expires_at    TIMESTAMPTZ,
  is_active     BOOLEAN DEFAULT TRUE,
  created_at    TIMESTAMPTZ DEFAULT now()
);

-- ── ADS / BANNERS ───────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS ads (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name          TEXT NOT NULL,
  href          TEXT NOT NULL,
  image_url     TEXT NOT NULL,
  placement     TEXT DEFAULT 'banner',   -- 'banner' | 'sidebar' | 'card'
  is_active     BOOLEAN DEFAULT TRUE,
  clicks        INTEGER DEFAULT 0,
  impressions   INTEGER DEFAULT 0,
  start_date    TIMESTAMPTZ DEFAULT now(),
  end_date      TIMESTAMPTZ,
  created_at    TIMESTAMPTZ DEFAULT now()
);

-- ── SESSIONS (for express-session via Supabase) ─────────────────
CREATE TABLE IF NOT EXISTS sessions (
  sid           TEXT PRIMARY KEY,
  sess          JSONB NOT NULL,
  expire        TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_expire ON sessions(expire);

-- ── AUDIT LOG ───────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS audit_log (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_type    TEXT NOT NULL,           -- 'staff' | 'user' | 'system'
  actor_id      UUID,
  action        TEXT NOT NULL,
  target_type   TEXT,
  target_id     UUID,
  details       JSONB DEFAULT '{}'::jsonb,
  created_at    TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_log(created_at DESC);

-- ── HELPER: auto-update updated_at ──────────────────────────────
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_servers_updated
  BEFORE UPDATE ON servers
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- ── HELPER: clean expired sessions ──────────────────────────────
CREATE OR REPLACE FUNCTION clean_expired_sessions()
RETURNS void AS $$
BEGIN
  DELETE FROM sessions WHERE expire < now();
END;
$$ LANGUAGE plpgsql;

-- ── ROW LEVEL SECURITY (optional — enable per table as needed) ──
-- ALTER TABLE servers ENABLE ROW LEVEL SECURITY;
-- ALTER TABLE votes   ENABLE ROW LEVEL SECURITY;
