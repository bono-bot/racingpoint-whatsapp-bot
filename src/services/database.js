const Database = require('better-sqlite3');
const path = require('path');
const logger = require('../utils/logger');

const DB_PATH = path.join(__dirname, '../../data/conversations.db');

let db;

function getDb() {
  if (!db) {
    db = new Database(DB_PATH);
    db.pragma('journal_mode = WAL');
    db.pragma('synchronous = FULL');
    db.pragma('busy_timeout = 5000');
    initSchema();
    logger.info('SQLite database initialized');
  }
  return db;
}

function initSchema() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      remote_jid TEXT NOT NULL,
      role TEXT NOT NULL CHECK(role IN ('user', 'assistant')),
      content TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_messages_jid_created
      ON messages(remote_jid, created_at DESC);

    CREATE TABLE IF NOT EXISTS bookings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      booking_id TEXT UNIQUE NOT NULL,
      remote_jid TEXT NOT NULL,
      customer_name TEXT NOT NULL,
      customer_phone TEXT NOT NULL,
      customer_email TEXT,
      booking_type TEXT NOT NULL DEFAULT 'Sim Racing',
      session_date TEXT NOT NULL,
      start_time TEXT NOT NULL,
      end_time TEXT NOT NULL,
      calendar_event_id TEXT,
      status TEXT NOT NULL DEFAULT 'confirmed' CHECK(status IN ('confirmed', 'cancelled')),
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_bookings_jid ON bookings(remote_jid);
    CREATE INDEX IF NOT EXISTS idx_bookings_booking_id ON bookings(booking_id);

    CREATE TABLE IF NOT EXISTS customers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      remote_jid TEXT UNIQUE NOT NULL,
      full_name TEXT,
      phone TEXT,
      email TEXT,
      age INTEGER,
      registered BOOLEAN DEFAULT 0,
      waiver_signed BOOLEAN DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_customers_jid ON customers(remote_jid);
    CREATE INDEX IF NOT EXISTS idx_customers_phone ON customers(phone);

    CREATE TABLE IF NOT EXISTS campaigns (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      segment TEXT NOT NULL,
      template_label TEXT,
      total_recipients INTEGER DEFAULT 0,
      sent_count INTEGER DEFAULT 0,
      failed_count INTEGER DEFAULT 0,
      status TEXT DEFAULT 'pending' CHECK(status IN ('pending', 'sending', 'completed', 'failed')),
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      completed_at DATETIME
    );

    CREATE TABLE IF NOT EXISTS campaign_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      campaign_id INTEGER NOT NULL REFERENCES campaigns(id),
      remote_jid TEXT NOT NULL,
      customer_name TEXT,
      status TEXT DEFAULT 'pending' CHECK(status IN ('pending', 'sent', 'failed')),
      sent_at DATETIME,
      error TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_campaign_messages_campaign ON campaign_messages(campaign_id);

    CREATE TABLE IF NOT EXISTS booking_flows (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      remote_jid TEXT NOT NULL,
      state TEXT NOT NULL DEFAULT 'select_game',
      data_json TEXT DEFAULT '{}',
      phone TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      expires_at DATETIME DEFAULT (datetime('now', '+10 minutes'))
    );
    CREATE INDEX IF NOT EXISTS idx_booking_flows_jid
      ON booking_flows(remote_jid, state);

    CREATE TABLE IF NOT EXISTS conversation_ownership (
      remote_jid TEXT PRIMARY KEY,
      state TEXT NOT NULL DEFAULT 'bot_active'
        CHECK(state IN ('bot_active', 'human_active', 'cooldown')),
      reason TEXT,
      handoff_at DATETIME,
      last_human_reply_at DATETIME,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS customer_profiles (
      remote_jid TEXT PRIMARY KEY,
      phone TEXT,
      push_name TEXT,
      first_seen TEXT NOT NULL DEFAULT (datetime('now')),
      last_interaction TEXT NOT NULL DEFAULT (datetime('now')),
      total_messages INTEGER NOT NULL DEFAULT 0,
      total_sessions INTEGER NOT NULL DEFAULT 0,
      lead_score INTEGER NOT NULL DEFAULT 0,
      lead_temperature TEXT NOT NULL DEFAULT 'cold',
      intent_history TEXT NOT NULL DEFAULT '[]',
      preferences TEXT NOT NULL DEFAULT '{}',
      funnel_stage TEXT NOT NULL DEFAULT 'inquiry',
      visit_count INTEGER NOT NULL DEFAULT 0,
      last_visit TEXT,
      referral_code TEXT,
      tags TEXT NOT NULL DEFAULT '[]',
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS customer_funnel (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      remote_jid TEXT NOT NULL,
      stage TEXT NOT NULL,
      previous_stage TEXT,
      trigger_message TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      metadata TEXT NOT NULL DEFAULT '{}'
    );
    CREATE INDEX IF NOT EXISTS idx_funnel_jid ON customer_funnel(remote_jid);
    CREATE INDEX IF NOT EXISTS idx_funnel_stage ON customer_funnel(stage);

    CREATE TABLE IF NOT EXISTS customer_nudges (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      remote_jid TEXT NOT NULL,
      nudge_type TEXT NOT NULL CHECK(nudge_type IN ('pricing_followup', 'slot_nudge', 'optin_request')),
      scheduled_at TEXT NOT NULL,
      fire_at TEXT NOT NULL,
      sent_at TEXT,
      status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'sent', 'cancelled', 'expired')),
      message_text TEXT,
      context_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_nudges_status ON customer_nudges(status, fire_at);
    CREATE INDEX IF NOT EXISTS idx_nudges_jid ON customer_nudges(remote_jid, status);

    CREATE TABLE IF NOT EXISTS customer_optins (
      remote_jid TEXT PRIMARY KEY,
      opted_in INTEGER NOT NULL DEFAULT 0,
      opted_in_at TEXT,
      opted_out_at TEXT,
      opt_source TEXT,
      last_message_at TEXT NOT NULL DEFAULT (datetime('now')),
      nudges_sent_today INTEGER NOT NULL DEFAULT 0,
      nudges_reset_date TEXT NOT NULL DEFAULT (date('now')),
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS template_sends (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      remote_jid TEXT NOT NULL,
      template_name TEXT NOT NULL,
      campaign_type TEXT NOT NULL CHECK(campaign_type IN ('post_visit', 'segment', 'festival', 'referral', 'lap_card')),
      flow_day INTEGER,
      scheduled_at TEXT NOT NULL,
      sent_at TEXT,
      status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'sent', 'failed', 'suppressed')),
      response_status TEXT DEFAULT 'unknown' CHECK(response_status IN ('unknown', 'delivered', 'read', 'ignored')),
      error TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_tsends_jid_status ON template_sends(remote_jid, status);
    CREATE INDEX IF NOT EXISTS idx_tsends_scheduled ON template_sends(status, scheduled_at);
    CREATE INDEX IF NOT EXISTS idx_tsends_jid_type ON template_sends(remote_jid, campaign_type, created_at DESC);

    CREATE TABLE IF NOT EXISTS referral_codes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      remote_jid TEXT NOT NULL,
      code TEXT UNIQUE NOT NULL,
      uses INTEGER NOT NULL DEFAULT 0,
      max_uses INTEGER NOT NULL DEFAULT 10,
      referrer_credit INTEGER NOT NULL DEFAULT 100,
      friend_credit INTEGER NOT NULL DEFAULT 50,
      active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_referral_jid ON referral_codes(remote_jid);
    CREATE INDEX IF NOT EXISTS idx_referral_code ON referral_codes(code);

    CREATE TABLE IF NOT EXISTS referral_redemptions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      code TEXT NOT NULL,
      referrer_jid TEXT NOT NULL,
      friend_jid TEXT NOT NULL,
      referrer_credited INTEGER NOT NULL DEFAULT 0,
      friend_credited INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_redemption_code ON referral_redemptions(code);

    CREATE TABLE IF NOT EXISTS monthly_challenges (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      month TEXT NOT NULL,
      challenge_name TEXT NOT NULL,
      challenge_type TEXT NOT NULL DEFAULT 'fastest_lap',
      active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS challenge_entries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      challenge_id INTEGER NOT NULL REFERENCES monthly_challenges(id),
      remote_jid TEXT NOT NULL,
      score_value REAL,
      submitted_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_challenge_entries ON challenge_entries(challenge_id, score_value DESC);
  `);
}

function close() {
  if (db) {
    db.close();
    db = null;
    logger.info('SQLite database closed');
  }
}

module.exports = { getDb, close };
