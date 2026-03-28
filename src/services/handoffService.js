const { getDb } = require('../db/database');
const evolutionService = require('./evolutionService');
const logger = require('../utils/logger');

const STAFF_JID = '917981264279@s.whatsapp.net';

// ── Handoff trigger patterns ────────────────────────────────────────

const EXPLICIT_REQUEST_RE = /\b(human|agent|manager|person|staff|real person|talk to someone|speak to someone)\b/i;

const ANGER_KEYWORDS_RE = /\b(angry|furious|terrible|worst|useless|stupid|pathetic|fed up|scam|waste|disgusting|horrible)\b/i;

const CORPORATE_RE = /\b(corporate|company|event|sponsorship|partnership|large group|team building|bulk|conference)\b/i;

const COMPLAINT_RE = /\b(not working|doesn't work|broken|wrong|issue|problem|still|again)\b/i;

const BOT_ERROR_RE = /sorry.*trouble|having.*issue|try again|contact us directly/i;

// ── Ownership state queries ─────────────────────────────────────────

function getOwnership(remoteJid) {
  const db = getDb();
  return db.prepare('SELECT * FROM conversation_ownership WHERE remote_jid = ?').get(remoteJid) || null;
}

function setOwnership(remoteJid, state, reason) {
  const db = getDb();
  const now = new Date().toISOString();
  const handoffAt = state === 'human_active' ? now : null;

  db.prepare(`
    INSERT INTO conversation_ownership (remote_jid, state, reason, handoff_at, updated_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(remote_jid) DO UPDATE SET
      state = excluded.state,
      reason = excluded.reason,
      handoff_at = CASE WHEN excluded.state = 'human_active' THEN excluded.handoff_at ELSE conversation_ownership.handoff_at END,
      updated_at = excluded.updated_at
  `).run(remoteJid, state, reason, handoffAt, now);

  logger.info({ remoteJid, state, reason }, 'Ownership state updated');
}

function isBotActive(remoteJid) {
  const row = getOwnership(remoteJid);
  if (!row) return true;
  return row.state === 'bot_active';
}

// ── Handoff detection ───────────────────────────────────────────────

function shouldHandoff(remoteJid, text, recentHistory) {
  // a) Explicit request for human
  if (EXPLICIT_REQUEST_RE.test(text)) {
    return { trigger: true, reason: 'customer_request' };
  }

  // b) Frustration detection
  // ALL CAPS (>50% uppercase, length > 10)
  if (text.length > 10) {
    const upper = text.replace(/[^a-zA-Z]/g, '');
    const upperCount = (text.match(/[A-Z]/g) || []).length;
    if (upper.length > 0 && upperCount / upper.length > 0.5) {
      return { trigger: true, reason: 'frustration_detected' };
    }
  }
  // Anger keywords
  if (ANGER_KEYWORDS_RE.test(text)) {
    return { trigger: true, reason: 'frustration_detected' };
  }
  // 2+ complaint messages in last 5 user messages
  const userMessages = recentHistory
    .filter(m => m.role === 'user')
    .slice(-5);
  const complaintCount = userMessages.filter(m => COMPLAINT_RE.test(m.content)).length;
  if (complaintCount >= 2 && COMPLAINT_RE.test(text)) {
    return { trigger: true, reason: 'frustration_detected' };
  }

  // c) Corporate/event inquiry
  if (CORPORATE_RE.test(text)) {
    return { trigger: true, reason: 'corporate_inquiry' };
  }

  // d) Bot failures: last 3 assistant messages all contain error phrases
  const assistantMessages = recentHistory
    .filter(m => m.role === 'assistant')
    .slice(-3);
  if (assistantMessages.length >= 3 && assistantMessages.every(m => BOT_ERROR_RE.test(m.content))) {
    return { trigger: true, reason: 'repeated_failures' };
  }

  return { trigger: false, reason: '' };
}

// ── Execute handoff ─────────────────────────────────────────────────

async function executeHandoff(remoteJid, pushName, reason, text) {
  // Set ownership to human_active
  setOwnership(remoteJid, 'human_active', reason);

  // Extract phone from JID
  const phone = remoteJid.replace('@s.whatsapp.net', '');
  const truncatedText = text.length > 200 ? text.substring(0, 200) + '...' : text;

  // Notify staff via WhatsApp
  const staffMsg = [
    '*Handoff Alert*',
    `Customer: ${pushName || 'Unknown'} (${phone})`,
    `Reason: ${reason}`,
    `Last message: "${truncatedText}"`,
    '',
    'Reply via Kapso inbox: app.kapso.ai',
    'Bot is now SILENT for this customer.',
  ].join('\n');

  try {
    await evolutionService.sendText(STAFF_JID, staffMsg);
    logger.info({ remoteJid, pushName, reason }, 'Staff notified of handoff');
  } catch (err) {
    logger.error({ err, remoteJid }, 'Failed to notify staff of handoff');
  }

  // Send message to customer
  const customerMsg = "I'm connecting you with our team. Someone will be with you shortly! You can also reach us directly at +91 7981264279.";
  try {
    await evolutionService.sendText(remoteJid, customerMsg);
  } catch (err) {
    logger.error({ err, remoteJid }, 'Failed to send handoff message to customer');
  }
}

// ── Stale handoff detection ─────────────────────────────────────────

function getStaleHandoffs(maxAgeMinutes) {
  const db = getDb();
  return db.prepare(`
    SELECT remote_jid, reason, handoff_at
    FROM conversation_ownership
    WHERE state = 'human_active'
      AND handoff_at < datetime('now', '-' || ? || ' minutes')
      AND last_human_reply_at IS NULL
  `).all(maxAgeMinutes);
}

// ── Record human reply ──────────────────────────────────────────────

function recordHumanReply(remoteJid) {
  const db = getDb();
  const now = new Date().toISOString();
  db.prepare(`
    UPDATE conversation_ownership
    SET last_human_reply_at = ?, updated_at = ?
    WHERE remote_jid = ? AND state = 'human_active'
  `).run(now, now, remoteJid);
}

// ── Auto-resume timer ───────────────────────────────────────────────

let autoResumeInterval = null;

async function autoResumeStaleHandoffs() {
  try {
    const stale = getStaleHandoffs(120);
    if (stale.length === 0) return;

    logger.info({ count: stale.length }, 'Found stale handoffs to auto-resume');

    for (const row of stale) {
      const { remote_jid: remoteJid, reason, handoff_at } = row;

      // Send apology to customer
      const apologyMsg = "Hi! Sorry for the wait. Our team wasn't able to get back to you in time. I'm back to help! What can I assist you with?\n\nYou can always reach our team at +91 7981264279.";

      try {
        await evolutionService.sendText(remoteJid, apologyMsg);
      } catch (err) {
        logger.error({ err, remoteJid }, 'Failed to send auto-resume apology');
      }

      // Set ownership back to bot_active
      setOwnership(remoteJid, 'bot_active', 'auto_resumed_2h_timeout');

      // Notify staff
      const phone = remoteJid.replace('@s.whatsapp.net', '');
      const staffNotice = '*Auto-resumed:* ' + phone + ' \u2014 no human reply after 2h. Bot is active again.';
      try {
        await evolutionService.sendText(STAFF_JID, staffNotice);
      } catch (err) {
        logger.error({ err, remoteJid }, 'Failed to notify staff of auto-resume');
      }

      logger.info({ remoteJid, reason, handoff_at }, 'Auto-resumed after 2h timeout');
    }
  } catch (err) {
    logger.error({ err }, 'Error in autoResumeStaleHandoffs');
  }
}

function startAutoResumeTimer() {
  if (autoResumeInterval) {
    logger.warn('Auto-resume timer already running');
    return;
  }
  autoResumeInterval = setInterval(autoResumeStaleHandoffs, 5 * 60 * 1000);
  logger.info('Auto-resume timer started (every 5 min)');
}

function stopAutoResumeTimer() {
  if (autoResumeInterval) {
    clearInterval(autoResumeInterval);
    autoResumeInterval = null;
    logger.info('Auto-resume timer stopped');
  }
}

module.exports = {
  getOwnership,
  setOwnership,
  shouldHandoff,
  executeHandoff,
  isBotActive,
  getStaleHandoffs,
  recordHumanReply,
  autoResumeStaleHandoffs,
  startAutoResumeTimer,
  stopAutoResumeTimer,
};
