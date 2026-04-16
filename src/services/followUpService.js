const { getDb } = require('../db/database');
const { getCachedPods, getCachedBookingCount } = require('./rcCacheService');
const handoffService = require('./handoffService');
const logger = require('../utils/logger');

// Lazy-load evolutionService to avoid circular dependency
let evoService = null;
function getEvoService() {
  if (!evoService) {
    evoService = require('./evolutionService');
  }
  return evoService;
}

// ── Nudge timer ─────────────────────────────────────────────────────

let nudgeInterval = null;

function startNudgeTimer() {
  if (nudgeInterval) {
    logger.warn('Nudge timer already running');
    return;
  }
  nudgeInterval = setInterval(processNudgeQueue, 5 * 60 * 1000);
  logger.info('Nudge timer started (every 5 min)');
}

function stopNudgeTimer() {
  if (nudgeInterval) {
    clearInterval(nudgeInterval);
    nudgeInterval = null;
    logger.info('Nudge timer stopped');
  }
}

// ── Schedule follow-up ──────────────────────────────────────────────

function scheduleFollowUp(remoteJid, nudgeType, contextData = {}) {
  const db = getDb();
  const now = new Date().toISOString();

  // Ensure optin row exists
  ensureOptinRow(remoteJid);

  // Reset nudge count if date rolled over
  resetNudgeCountIfNeeded(remoteJid);

  // CONV-05: max 2 nudges per 24h
  const optin = db.prepare('SELECT nudges_sent_today FROM customer_optins WHERE remote_jid = ?').get(remoteJid);
  if (optin && optin.nudges_sent_today >= 2) {
    logger.info({ remoteJid, nudgeType, sent: optin.nudges_sent_today }, 'Nudge limit reached (2/24h), not scheduling');
    return null;
  }

  // Cancel existing pending nudge of same type for same jid
  db.prepare(`
    UPDATE customer_nudges SET status = 'cancelled'
    WHERE remote_jid = ? AND nudge_type = ? AND status = 'pending'
  `).run(remoteJid, nudgeType);

  // Calculate fire_at based on type
  const fireAt = calculateFireAt(nudgeType);

  const result = db.prepare(`
    INSERT INTO customer_nudges (remote_jid, nudge_type, scheduled_at, fire_at, context_json)
    VALUES (?, ?, ?, ?, ?)
  `).run(remoteJid, nudgeType, now, fireAt, JSON.stringify(contextData));

  logger.info({ remoteJid, nudgeType, fireAt, id: result.lastInsertRowid }, 'Nudge scheduled');
  return result.lastInsertRowid;
}

function calculateFireAt(nudgeType) {
  const now = Date.now();
  let delayMs;

  switch (nudgeType) {
    case 'pricing_followup':
      // 30-60 minutes
      delayMs = (30 + Math.random() * 30) * 60 * 1000;
      break;
    case 'slot_nudge':
      // 3-5 hours
      delayMs = (3 + Math.random() * 2) * 60 * 60 * 1000;
      break;
    case 'optin_request':
      // 22 hours (2h before 24h window closes)
      delayMs = 22 * 60 * 60 * 1000;
      break;
    default:
      delayMs = 60 * 60 * 1000; // 1 hour fallback
  }

  return new Date(now + delayMs).toISOString();
}

// ── Process nudge queue ─────────────────────────────────────────────

async function processNudgeQueue() {
  const db = getDb();

  const pending = db.prepare(`
    SELECT * FROM customer_nudges
    WHERE status = 'pending' AND fire_at <= datetime('now')
  `).all();

  if (pending.length === 0) return;

  logger.info({ count: pending.length }, 'Processing nudge queue');

  for (const nudge of pending) {
    try {
      await processOneNudge(db, nudge);
    } catch (err) {
      logger.error({ err, nudgeId: nudge.id, remoteJid: nudge.remote_jid }, 'Error processing nudge');
    }
  }
}

async function processOneNudge(db, nudge) {
  const { id, remote_jid: remoteJid, nudge_type: nudgeType } = nudge;

  // a) Check 24h window
  const optin = db.prepare('SELECT * FROM customer_optins WHERE remote_jid = ?').get(remoteJid);
  if (optin && optin.last_message_at) {
    const lastMsg = new Date(optin.last_message_at).getTime();
    const hoursSince = (Date.now() - lastMsg) / (1000 * 60 * 60);
    if (hoursSince > 24) {
      db.prepare("UPDATE customer_nudges SET status = 'expired' WHERE id = ?").run(id);
      logger.info({ nudgeId: id, remoteJid, hoursSince }, 'Nudge expired (24h window)');
      return;
    }
  }

  // b) Check opt-out
  if (optin && optin.opted_in === 0 && optin.opted_out_at) {
    db.prepare("UPDATE customer_nudges SET status = 'cancelled' WHERE id = ?").run(id);
    logger.info({ nudgeId: id, remoteJid }, 'Nudge cancelled (opted out)');
    return;
  }

  // c) Check handoff status
  if (!handoffService.isBotActive(remoteJid)) {
    db.prepare("UPDATE customer_nudges SET status = 'cancelled' WHERE id = ?").run(id);
    logger.info({ nudgeId: id, remoteJid }, 'Nudge cancelled (human handoff active)');
    return;
  }

  // d) Cross-timer cooldown — skip if any outbound message sent in last 30 min
  const recentOutbound = db.prepare(
    "SELECT 1 FROM customer_nudges WHERE remote_jid = ? AND status = 'sent' AND sent_at > datetime('now', '-30 minutes') LIMIT 1"
  ).get(remoteJid);
  if (recentOutbound) {
    db.prepare("UPDATE customer_nudges SET status = 'deferred', fire_at = datetime('now', '+30 minutes') WHERE id = ?").run(id);
    logger.info({ nudgeId: id, remoteJid }, 'Nudge deferred (30-min cross-timer cooldown)');
    return;
  }

  // e) Build message
  const message = buildNudgeMessage(nudge);

  // e) Send
  try {
    const evo = getEvoService();
    await evo.sendText(remoteJid, message);
  } catch (err) {
    logger.error({ err, nudgeId: id, remoteJid }, 'Failed to send nudge message');
    return; // Don't mark as sent if send failed
  }

  // f) Update nudge record
  db.prepare(`
    UPDATE customer_nudges
    SET status = 'sent', sent_at = datetime('now'), message_text = ?
    WHERE id = ?
  `).run(message, id);

  // g) Increment daily nudge count
  resetNudgeCountIfNeeded(remoteJid);
  db.prepare(`
    UPDATE customer_optins
    SET nudges_sent_today = nudges_sent_today + 1
    WHERE remote_jid = ?
  `).run(remoteJid);

  logger.info({ nudgeId: id, remoteJid, nudgeType: nudge.nudge_type }, 'Nudge sent');
}

// ── Message builders ────────────────────────────────────────────────

function buildNudgeMessage(nudge) {
  const fomoLine = buildFomoLine();
  const fomo = fomoLine ? ` ${fomoLine}` : '';

  switch (nudge.nudge_type) {
    case 'pricing_followup':
      return `Hey! Just checking in -- still thinking about trying RacingPoint?${fomo} Book now and lock in your spot!`;
    case 'slot_nudge':
      return `Quick heads up --${fomo} Weekend slots fill up fast. Want me to help you book?`;
    case 'optin_request':
      return "Thanks for chatting with us! Want to hear about deals, events, and cafe specials? Reply *YES* to opt in, or *no thanks* to skip.";
    default:
      return `Hey! Just wanted to follow up.${fomo} Let me know if you have any questions!`;
  }
}

function buildFomoLine() {
  // Check pod scarcity
  const pods = getCachedPods();
  if (pods.data && pods.data.available <= 3 && !pods.unavailable && !pods.stale) {
    return `Only ${pods.data.available} rigs left right now!`;
  }

  // Check booking count
  const bookings = getCachedBookingCount();
  if (bookings.count >= 3 && !bookings.stale) {
    return `${bookings.count} people have already booked today!`;
  }

  return '';
}

// ── Opt-in management ───────────────────────────────────────────────

function ensureOptinRow(remoteJid) {
  const db = getDb();
  db.prepare(`
    INSERT OR IGNORE INTO customer_optins (remote_jid)
    VALUES (?)
  `).run(remoteJid);
}

function updateLastMessageTime(remoteJid) {
  const db = getDb();
  db.prepare(`
    INSERT INTO customer_optins (remote_jid, last_message_at)
    VALUES (?, datetime('now'))
    ON CONFLICT(remote_jid) DO UPDATE SET
      last_message_at = datetime('now')
  `).run(remoteJid);
}

function handleOptInResponse(remoteJid, text) {
  const db = getDb();
  const trimmed = text.trim();

  // Opt-in patterns
  if (/^(yes|yeah|sure|ok|opt.?in|subscribe)$/i.test(trimmed)) {
    ensureOptinRow(remoteJid);
    db.prepare(`
      UPDATE customer_optins
      SET opted_in = 1, opted_in_at = datetime('now')
      WHERE remote_jid = ?
    `).run(remoteJid);
    logger.info({ remoteJid }, 'Customer opted in');
    return true;
  }

  // Opt-out patterns
  if (/^(no|nah|stop|no thanks|opt.?out|unsubscribe)$/i.test(trimmed)) {
    ensureOptinRow(remoteJid);
    db.prepare(`
      UPDATE customer_optins
      SET opted_in = 0, opted_out_at = datetime('now')
      WHERE remote_jid = ?
    `).run(remoteJid);
    // Cancel all pending nudges
    db.prepare(`
      UPDATE customer_nudges
      SET status = 'cancelled'
      WHERE remote_jid = ? AND status = 'pending'
    `).run(remoteJid);
    logger.info({ remoteJid }, 'Customer opted out, pending nudges cancelled');
    return true;
  }

  return false;
}

function isOptedIn(remoteJid) {
  const db = getDb();
  const row = db.prepare('SELECT opted_in FROM customer_optins WHERE remote_jid = ?').get(remoteJid);
  return row ? row.opted_in === 1 : false;
}

// ── Helpers ─────────────────────────────────────────────────────────

function resetNudgeCountIfNeeded(remoteJid) {
  const db = getDb();
  const today = new Date().toISOString().split('T')[0];
  db.prepare(`
    UPDATE customer_optins
    SET nudges_sent_today = 0, nudges_reset_date = ?
    WHERE remote_jid = ? AND nudges_reset_date != ?
  `).run(today, remoteJid, today);
}

module.exports = {
  scheduleFollowUp,
  processNudgeQueue,
  startNudgeTimer,
  stopNudgeTimer,
  updateLastMessageTime,
  handleOptInResponse,
  isOptedIn,
  buildFomoLine,
};
