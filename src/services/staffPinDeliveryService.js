/**
 * staffPinDeliveryService.js — W1-S7+S8 daily PIN delivery via WhatsApp + helpdesk@ fallback.
 *
 * Substrate ship under Captain Option Bravo class-level V2-aligned auth (2026-05-08).
 *
 * Composes-with:
 *   - comms-link/.planning/draft-pacts/PACT-DRAFT-pact-001-phase-1-wave-1-static-billing-engine.md
 *     (parent PACT; W1-S7 PIN daily delivery + W1-S8 fallback in §1.1)
 *   - V2-MASTER-STATE.md §S-82 Q1 dispositions (Captain 2026-05-07 ~04:58→05:13 IST)
 *     - Q1.a security-event escalation: helpdesk@racingpoint.in for 5-wrong reset
 *     - Q1.e bono-default: daily fresh PIN; previous-day auto-invalidates at delivery time
 *     - Q1.f bono-default: 06:00 IST delivery time
 *     - Q1.h bono-default: 30min fallback to helpdesk@ on delivery-ack failure
 *   - V2-MASTER-STATE.md §S-101 GST-INCLUSIVE doctrine (no impact here; cross-cutting)
 *   - PACT-018 security-debt-ledger class=credential-storage closure_phase=Phase-0.5c-AUTH
 *     (pin_hash stored, NOT raw PIN)
 *   - racingpoint-whatsapp-bot/src/services/evolutionService.js (sendText)
 *   - @racingpoint/google gmail.sendEmail (helpdesk fallback)
 *
 * Status: SCAFFOLDING — gates on james-LEAD W1-S6 PIN-LOCKOUT auto-rotate Rust substrate
 * via src/services/racecontrolStubs.js (STUB until W1-S6 lands). Production cron
 * registration DEFERRED until W1-S6 lands + integration tests pass + Captain auth
 * for cron registration on Bono VPS.
 *
 * Module API:
 *   - deliverDailyPins(opts)        — main entry point (cron at 06:00 IST)
 *   - recordDeliveryEvent(eventRow) — INSERT staff_pin_delivery_events row
 *   - markDeliveryAck(messageId, ackTimestamp) — UPDATE event with ack
 *   - findPendingFallbacks(maxAgeMs) — find events older than 30min without ack
 *   - fallbackToHelpdesk(eventRow)   — gmail send to helpdesk@racingpoint.in
 */

'use strict';

const crypto = require('crypto');
const logger = require('../utils/logger');
const { getDb } = require('./database');
const evolutionService = require('./evolutionService');
const { fetchPinForStaff, fetchStaffRegistry } = require('./racecontrolStubs');

const HELPDESK_EMAIL = 'helpdesk@racingpoint.in';
const FALLBACK_THRESHOLD_MS = 30 * 60 * 1000; // 30min per §S-82 Q1.h bono-default

/**
 * IST timestamp helper (UTC + 5:30).
 * NEVER use TZ=Asia/Kolkata in shell — see racecontrol/CLAUDE.md timezone warning.
 */
function nowIst() {
  const d = new Date(Date.now() + 5.5 * 60 * 60 * 1000);
  return d.toISOString().replace('Z', '+05:30');
}

function todayIstDate() {
  return nowIst().slice(0, 10);
}

/**
 * SHA-256 hash of PIN for audit log persistence (PACT-018 security-debt-ledger
 * class=credential-storage; raw PIN never persisted on bono-side).
 */
function hashPin(pin) {
  return crypto.createHash('sha256').update(pin).digest('hex');
}

/**
 * INSERT a staff_pin_delivery_events row.
 * Returns the inserted row id.
 */
function recordDeliveryEvent(eventRow) {
  const db = getDb();
  const stmt = db.prepare(`
    INSERT INTO staff_pin_delivery_events (
      staff_id, staff_whatsapp_jid, pin_hash, delivery_attempt_at,
      delivery_status, evolution_message_id, delivery_date_ist
    ) VALUES (
      @staff_id, @staff_whatsapp_jid, @pin_hash, @delivery_attempt_at,
      @delivery_status, @evolution_message_id, @delivery_date_ist
    )
  `);
  const info = stmt.run({
    staff_id: eventRow.staff_id,
    staff_whatsapp_jid: eventRow.staff_whatsapp_jid || null,
    pin_hash: eventRow.pin_hash,
    delivery_attempt_at: eventRow.delivery_attempt_at,
    delivery_status: eventRow.delivery_status,
    evolution_message_id: eventRow.evolution_message_id || null,
    delivery_date_ist: eventRow.delivery_date_ist,
  });
  return info.lastInsertRowid;
}

/**
 * UPDATE delivery_ack_at + delivery_status when WhatsApp delivery confirmed.
 * (Caller wires this from Evolution API webhook OR polling delivery status.)
 */
function markDeliveryAck(messageId, ackTimestamp) {
  const db = getDb();
  const stmt = db.prepare(`
    UPDATE staff_pin_delivery_events
       SET delivery_ack_at = ?, delivery_status = 'delivered'
     WHERE evolution_message_id = ?
       AND delivery_status IN ('pending', 'sent')
  `);
  return stmt.run(ackTimestamp, messageId).changes;
}

/**
 * Find events older than maxAgeMs without delivery_ack_at AND without
 * fallback_attempt_at — these are the candidates for helpdesk@ fallback.
 */
function findPendingFallbacks(maxAgeMs = FALLBACK_THRESHOLD_MS) {
  const db = getDb();
  const cutoffMs = Date.now() - maxAgeMs;
  const cutoffIst = new Date(cutoffMs + 5.5 * 60 * 60 * 1000)
    .toISOString()
    .replace('Z', '+05:30');

  return db.prepare(`
    SELECT * FROM staff_pin_delivery_events
     WHERE delivery_status IN ('pending', 'sent', 'failed')
       AND delivery_ack_at IS NULL
       AND fallback_attempt_at IS NULL
       AND delivery_attempt_at < ?
  `).all(cutoffIst);
}

/**
 * Send fallback email to helpdesk@racingpoint.in for a stuck delivery event.
 * Returns the gmail message id on success; throws on failure.
 *
 * NOTE: uses @racingpoint/google gmail.sendEmail; requires gmail OAuth.
 * If gmail OAuth not available, logs error and updates row status to
 * 'fallback_helpdesk_dispatch_failed' for human follow-up.
 */
async function fallbackToHelpdesk(eventRow) {
  let gmail;
  try {
    gmail = require('@racingpoint/google').gmail;
  } catch (err) {
    logger.error({ err: err.message }, 'gmail module not available; cannot send helpdesk fallback');
    throw new Error('GMAIL_MODULE_UNAVAILABLE');
  }

  // pin_hash only — never include raw PIN in email per security-debt-ledger
  const subject = `[W1-S8 fallback] Staff PIN delivery stuck — staff_id=${eventRow.staff_id}`;
  const body = [
    'W1-S8 fallback handler — WhatsApp delivery did not ack within 30min.',
    '',
    `staff_id: ${eventRow.staff_id}`,
    `delivery_date_ist: ${eventRow.delivery_date_ist}`,
    `delivery_attempt_at: ${eventRow.delivery_attempt_at}`,
    `pin_hash: ${eventRow.pin_hash}`,
    `evolution_message_id: ${eventRow.evolution_message_id || '(none)'}`,
    '',
    'Action required: helpdesk verifies staff identity per §S-82 Q1.a security-event human-gate, then',
    'reads today\'s PIN from racecontrol admin dashboard (gates on Phase-0.5c-AUTH closure).',
    '',
    'Composes-with: PACT-DRAFT-pact-001-phase-1-wave-1-static-billing-engine.md §1.1 W1-S8',
    'V2-MASTER-STATE.md §S-82 Q1.h bono-default 30min fallback',
  ].join('\n');

  const result = await gmail.sendEmail({
    auth: undefined, // gmail module sources auth from googleAuth singleton
    to: HELPDESK_EMAIL,
    subject,
    body,
  });

  // Mark fallback dispatched
  const db = getDb();
  db.prepare(`
    UPDATE staff_pin_delivery_events
       SET delivery_status = 'fallback_helpdesk_dispatched',
           fallback_attempt_at = ?,
           fallback_reason = ?
     WHERE id = ?
  `).run(nowIst(), 'delivery_ack_timeout_30min', eventRow.id);

  logger.info({
    staff_id: eventRow.staff_id,
    event_id: eventRow.id,
    gmail_message_id: result?.id,
  }, 'W1-S8 helpdesk fallback dispatched');

  return result?.id;
}

/**
 * Main entry point — daily PIN delivery cron job.
 * Invoked at 06:00 IST per §S-82 Q1.f bono-default.
 *
 * @param {object} opts
 * @param {boolean} opts.dryRun — skip Evolution API send + DB INSERT (log only)
 * @returns {Promise<{attempted: number, sent: number, failed: number, skipped: number}>}
 */
async function deliverDailyPins(opts = {}) {
  const { dryRun = false } = opts;
  const stats = { attempted: 0, sent: 0, failed: 0, skipped: 0 };

  let staff;
  try {
    staff = await fetchStaffRegistry();
  } catch (err) {
    logger.error({ err: err.message }, 'staff registry fetch failed; aborting delivery cycle');
    throw err;
  }

  if (!staff || staff.length === 0) {
    logger.warn('staff registry empty (STUB returns [] unless STAFF_PIN_STUB_ENABLED=true); skipping cycle');
    return stats;
  }

  const todayDate = todayIstDate();

  for (const member of staff) {
    stats.attempted += 1;
    const { staff_id: staffId, whatsapp_e164: phoneE164, display_name: displayName } = member;
    const remoteJid = phoneE164.startsWith('+')
      ? `${phoneE164.slice(1)}@s.whatsapp.net`
      : `${phoneE164}@s.whatsapp.net`;

    let pinData;
    try {
      pinData = await fetchPinForStaff(staffId);
    } catch (err) {
      logger.error({ staffId, err: err.message }, 'fetchPinForStaff STUB threw; W1-S6 racecontrol substrate not yet landed');
      stats.failed += 1;
      continue;
    }

    const messageText = [
      `🏁 RacingPoint — your PIN for ${todayDate}`,
      '',
      `${displayName || staffId}, today's staff PIN is:`,
      '',
      `   ${pinData.pin}`,
      '',
      `Valid until 06:00 IST tomorrow when a fresh PIN is delivered.`,
      'Previous-day PIN is now invalid.',
      '',
      'If you didn\'t request this, contact helpdesk@racingpoint.in immediately.',
    ].join('\n');

    const eventRow = {
      staff_id: staffId,
      staff_whatsapp_jid: remoteJid,
      pin_hash: pinData.pin_hash,
      delivery_attempt_at: nowIst(),
      delivery_status: 'pending',
      evolution_message_id: null,
      delivery_date_ist: todayDate,
    };

    if (dryRun) {
      logger.info({ staffId, remoteJid, todayDate, dryRun: true }, 'W1-S7 dry-run — would send WhatsApp + record event');
      stats.skipped += 1;
      continue;
    }

    let evolutionResp;
    try {
      evolutionResp = await evolutionService.sendText(remoteJid, messageText);
    } catch (err) {
      logger.error({ staffId, err: err.message }, 'W1-S7 Evolution API send failed');
      eventRow.delivery_status = 'failed';
      try {
        recordDeliveryEvent(eventRow);
      } catch (dbErr) {
        logger.error({ dbErr: dbErr.message }, 'audit-log INSERT also failed');
      }
      stats.failed += 1;
      continue;
    }

    eventRow.delivery_status = 'sent';
    eventRow.evolution_message_id = evolutionResp?.key?.id || null;

    try {
      const eventId = recordDeliveryEvent(eventRow);
      logger.info({
        staffId,
        eventId,
        evolutionMessageId: eventRow.evolution_message_id,
      }, 'W1-S7 PIN delivery sent + audit row recorded');
      stats.sent += 1;
    } catch (dbErr) {
      logger.error({ dbErr: dbErr.message }, 'W1-S7 audit-log INSERT failed despite successful WhatsApp send');
      stats.failed += 1;
    }
  }

  logger.info({ stats }, 'W1-S7 daily PIN delivery cycle complete');
  return stats;
}

module.exports = {
  deliverDailyPins,
  recordDeliveryEvent,
  markDeliveryAck,
  findPendingFallbacks,
  fallbackToHelpdesk,
  hashPin,
  nowIst,
  todayIstDate,
  HELPDESK_EMAIL,
  FALLBACK_THRESHOLD_MS,
};
