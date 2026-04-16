/**
 * Venue Status Service — temporary closure awareness.
 *
 * Three closure sources (any one = venue closed):
 *   1. VENUE_CLOSED env var set to any truthy value
 *   2. /root/racingpoint-whatsapp-bot/VENUE_CLOSED file exists
 *   3. Auto-detect: racecontrol server unreachable for 3+ consecutive cache cycles (15+ min)
 *
 * Manual override always wins. Auto-detect is a safety net.
 */

const fs = require('fs');
const path = require('path');
const logger = require('../utils/logger');

const FLAG_FILE = path.join(__dirname, '..', '..', 'VENUE_CLOSED');
const CLOSURE_MESSAGE_FILE = path.join(__dirname, '..', '..', 'VENUE_CLOSED_MESSAGE');

// Auto-detect state
let consecutiveRcFailures = 0;
const AUTO_CLOSE_THRESHOLD = 3; // 3 failures × 5 min = 15 min down → auto-close

// Default closure message
const DEFAULT_CLOSURE_MESSAGE =
  "Hey! Thanks for reaching out to RacingPoint.\n\n" +
  "We're currently *temporarily closed* — our systems are being upgraded.\n\n" +
  "We'll be back soon! Follow us on Instagram for updates: https://www.instagram.com/racingpoint.esports/\n\n" +
  "For urgent queries, call: +91 7981264279\n\n" +
  "_This is an automated message._";

/**
 * Check if venue is manually closed via env var or flag file.
 */
function isManualClosed() {
  // Check env var
  if (process.env.VENUE_CLOSED && process.env.VENUE_CLOSED !== '0' && process.env.VENUE_CLOSED !== 'false') {
    return true;
  }
  // Check flag file
  try {
    fs.accessSync(FLAG_FILE, fs.constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Check if auto-close triggered due to prolonged RC failure.
 */
function isAutoClosedFromRcDown() {
  return consecutiveRcFailures >= AUTO_CLOSE_THRESHOLD;
}

/**
 * Called by rcCacheService after each refresh cycle.
 * @param {boolean} success - true if at least pods endpoint responded
 */
function reportRcHealth(success) {
  if (success) {
    if (consecutiveRcFailures >= AUTO_CLOSE_THRESHOLD) {
      logger.info('Venue auto-close lifted — racecontrol is back');
    }
    consecutiveRcFailures = 0;
  } else {
    consecutiveRcFailures++;
    if (consecutiveRcFailures === AUTO_CLOSE_THRESHOLD) {
      logger.warn(
        { consecutiveFailures: consecutiveRcFailures },
        'Venue AUTO-CLOSED: racecontrol unreachable for 3+ cycles'
      );
    }
  }
}

/**
 * Is the venue currently closed (any source)?
 */
function isVenueClosed() {
  return isManualClosed() || isAutoClosedFromRcDown();
}

/**
 * Get the reason for closure.
 */
function getClosureReason() {
  if (isManualClosed()) return 'manual';
  if (isAutoClosedFromRcDown()) return 'rc_unreachable';
  return null;
}

/**
 * Get the closure message to send to customers.
 * Checks VENUE_CLOSED_MESSAGE file first for custom message.
 */
function getClosureMessage() {
  // Check for custom message file
  try {
    const custom = fs.readFileSync(CLOSURE_MESSAGE_FILE, 'utf-8').trim();
    if (custom) return custom;
  } catch {
    // No custom message file — use default
  }
  return DEFAULT_CLOSURE_MESSAGE;
}

/**
 * Get a short status line for injection into system prompts.
 */
function getClosureContextForPrompt() {
  if (!isVenueClosed()) return '';
  const reason = getClosureReason();
  const reasonText = reason === 'manual'
    ? 'manually set to closed'
    : 'systems are currently down';
  return `\n\n## ⚠️ VENUE IS CURRENTLY CLOSED\nRacingPoint is TEMPORARILY CLOSED (${reasonText}). Do NOT tell customers we are open. Do NOT encourage walk-ins or bookings. If asked, say we are temporarily closed for maintenance/upgrades and suggest following @racingpoint.esports on Instagram for reopening updates. For urgent queries, direct them to call +91 7981264279.\n`;
}

module.exports = {
  isVenueClosed,
  getClosureReason,
  getClosureMessage,
  getClosureContextForPrompt,
  reportRcHealth,
  isManualClosed,
};
