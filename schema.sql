-- ╔══════════════════════════════════════════════════════════════╗
-- ║  ENDER LIST — Self-Hosted PostgreSQL 16 Schema             ║
-- ║  Run against your local Postgres instance                  ║
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

-- ── SESSIONS (for express-session via connect-pg-simple) ────────
CREATE TABLE IF NOT EXISTS sessions (
  sid           TEXT PRIMARY KEY,
  sess          JSONB NOT NULL,
  expire        TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_expire ON sessions(expire);

-- ── REVOKED TOKENS (for JWT denylist) ───────────────────────────
CREATE TABLE IF NOT EXISTS revoked_tokens (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  token_jti     TEXT UNIQUE NOT NULL,
  revoked_at    TIMESTAMPTZ DEFAULT now(),
  expires_at    TIMESTAMPTZ NOT NULL     -- auto-cleanup after JWT would expire
);
CREATE INDEX IF NOT EXISTS idx_revoked_jti ON revoked_tokens(token_jti);

-- ── AUDIT LOG (append-only, tamper-proof) ───────────────────────
CREATE TABLE IF NOT EXISTS audit_log (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_type    TEXT NOT NULL,           -- 'staff' | 'user' | 'system'
  actor_id      UUID,
  action        TEXT NOT NULL,
  target_type   TEXT,
  target_id     UUID,
  details       JSONB DEFAULT '{}'::jsonb,
  ip_address    INET,
  created_at    TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_log(created_at DESC);

-- Prevent any modification or deletion of audit records
REVOKE UPDATE, DELETE, TRUNCATE ON audit_log FROM app_user;

CREATE OR REPLACE FUNCTION prevent_audit_modification()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'Audit log is immutable';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS no_audit_changes ON audit_log;
CREATE TRIGGER no_audit_changes
  BEFORE UPDATE OR DELETE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION prevent_audit_modification();

-- ── ROW LEVEL SECURITY ──────────────────────────────────────────

ALTER TABLE servers ENABLE ROW LEVEL SECURITY;
ALTER TABLE users   ENABLE ROW LEVEL SECURITY;
ALTER TABLE votes   ENABLE ROW LEVEL SECURITY;

-- Users can only modify their own servers
CREATE POLICY owner_only_select ON servers FOR SELECT USING (true);
CREATE POLICY owner_only_insert ON servers FOR INSERT WITH CHECK (
  owner_id = current_setting('app.current_user_id', true)::uuid
);
CREATE POLICY owner_only_update ON servers FOR UPDATE USING (
  owner_id = current_setting('app.current_user_id', true)::uuid
);
CREATE POLICY owner_only_delete ON servers FOR DELETE USING (
  owner_id = current_setting('app.current_user_id', true)::uuid
);

-- Users can only see their own profile for modifications
CREATE POLICY users_select_all ON users FOR SELECT USING (true);
CREATE POLICY users_update_own ON users FOR UPDATE USING (
  id = current_setting('app.current_user_id', true)::uuid
);

-- Votes: anyone can read, users insert their own
CREATE POLICY votes_select_all ON votes FOR SELECT USING (true);
CREATE POLICY votes_insert_own ON votes FOR INSERT WITH CHECK (
  user_id = current_setting('app.current_user_id', true)::uuid
);

-- ── HELPER: auto-update updated_at ──────────────────────────────
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_servers_updated ON servers;
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

-- ── HELPER: clean expired revoked tokens ────────────────────────
CREATE OR REPLACE FUNCTION clean_expired_revoked_tokens()
RETURNS void AS $$
BEGIN
  DELETE FROM revoked_tokens WHERE expires_at < now();
END;
$$ LANGUAGE plpgsql;
