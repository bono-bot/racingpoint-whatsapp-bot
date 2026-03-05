const Database = require('better-sqlite3');
const path = require('path');
const logger = require('../utils/logger');

const DB_PATH = path.join(__dirname, '../../data/conversations.db');

let db;

function getDb() {
  if (!db) {
    db = new Database(DB_PATH);
    db.pragma('journal_mode = WAL');
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
