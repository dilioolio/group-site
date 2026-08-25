-- Group Site — D1 schema. Applied automatically by the Worker on first request
-- (see src/lib/config.js). Every statement is idempotent.

PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS events (
  id            TEXT PRIMARY KEY,
  title         TEXT NOT NULL,
  description   TEXT NOT NULL,
  event_date    TEXT NOT NULL,
  location      TEXT,
  status        TEXT NOT NULL DEFAULT 'active',
  -- id of a category from the CATEGORIES config setting ('' = uncategorised)
  category      TEXT NOT NULL DEFAULT '',
  -- per-event member photo gallery on/off (category supplies the default)
  gallery_enabled INTEGER NOT NULL DEFAULT 1,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_events_date ON events(event_date);
CREATE INDEX IF NOT EXISTS idx_events_status ON events(status);

CREATE TABLE IF NOT EXISTS event_images (
  id         TEXT PRIMARY KEY,
  event_id   TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  r2_key     TEXT NOT NULL,
  is_primary INTEGER NOT NULL DEFAULT 0,
  sort_order INTEGER NOT NULL DEFAULT 0,
  alt_text   TEXT
);

CREATE INDEX IF NOT EXISTS idx_event_images_event ON event_images(event_id, sort_order);

CREATE TABLE IF NOT EXISTS rsvps (
  id          TEXT PRIMARY KEY,
  event_id    TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  email       TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'going',
  created_at  TEXT NOT NULL,
  UNIQUE(event_id, email)
);

CREATE INDEX IF NOT EXISTS idx_rsvps_event ON rsvps(event_id);

CREATE TABLE IF NOT EXISTS push_subscriptions (
  id         TEXT PRIMARY KEY,
  email      TEXT NOT NULL,
  endpoint   TEXT NOT NULL UNIQUE,
  p256dh     TEXT NOT NULL,
  auth       TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_push_subs_email ON push_subscriptions(email);

CREATE TABLE IF NOT EXISTS member_photos (
  id             TEXT PRIMARY KEY,
  event_id       TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  r2_key         TEXT NOT NULL,
  uploader_name  TEXT,
  uploader_email TEXT,
  caption        TEXT,
  created_at     TEXT NOT NULL,
  expires_at     TEXT NOT NULL,
  -- CRC-32 of the file bytes, computed at upload (NULL for legacy rows / very
  -- large files). Lets the zip endpoint skip re-hashing every photo.
  crc32          INTEGER
);

CREATE INDEX IF NOT EXISTS idx_member_photos_event ON member_photos(event_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_member_photos_expires ON member_photos(expires_at);
CREATE INDEX IF NOT EXISTS idx_member_photos_uploader ON member_photos(event_id, uploader_email);

CREATE TABLE IF NOT EXISTS broadcasts (
  id        TEXT PRIMARY KEY,
  event_id  TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  subject   TEXT NOT NULL,
  body      TEXT NOT NULL,
  sent_at   TEXT NOT NULL,
  -- 'broadcast' (confirmable) or 'notify' (fire-and-forget). Same table because
  -- both are admin-authored messages to the same event; the kind drives the UI
  -- (red border for broadcasts, yellow for notifies) and the per-recipient ack
  -- rows only exist for the broadcast kind.
  kind      TEXT NOT NULL DEFAULT 'broadcast'
);

CREATE INDEX IF NOT EXISTS idx_broadcasts_event ON broadcasts(event_id, sent_at DESC);

CREATE TABLE IF NOT EXISTS broadcast_acks (
  id            TEXT PRIMARY KEY,
  broadcast_id  TEXT NOT NULL REFERENCES broadcasts(id) ON DELETE CASCADE,
  email         TEXT NOT NULL,
  name          TEXT,
  token         TEXT NOT NULL UNIQUE,
  confirmed_at  TEXT,
  UNIQUE(broadcast_id, email)
);

CREATE INDEX IF NOT EXISTS idx_broadcast_acks_broadcast ON broadcast_acks(broadcast_id);

-- Fixed-window rate-limit counters (login attempts, RSVP/email sends).
-- `reset_at` is unix seconds; expired rows are swept by the daily cron.
CREATE TABLE IF NOT EXISTS rate_limits (
  key      TEXT PRIMARY KEY,
  count    INTEGER NOT NULL DEFAULT 0,
  reset_at INTEGER NOT NULL
);

-- Runtime configuration written by the /setup wizard and the admin Settings
-- page (password hash, Resend key, VAPID keys, names, colours...). Replaces
-- Worker secrets so the site is configurable without a terminal.
CREATE TABLE IF NOT EXISTS config (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
