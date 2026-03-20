const logger = require('../utils/logger');

const STATES = {
  SELECT_GAME: 'select_game',
  SELECT_DURATION: 'select_duration',
  CONFIRM: 'confirm',
  BOOKED: 'booked',
  CANCELLED: 'cancelled',
  EXPIRED: 'expired',
};

const TRANSITIONS = {
  select_game:     { game_selected: 'select_duration', cancel: 'cancelled' },
  select_duration: { duration_selected: 'confirm', cancel: 'cancelled' },
  confirm:         { confirmed: 'booked', cancel: 'cancelled' },
};

class BookingStateMachine {
  constructor(db) {
    this.db = db;
  }

  /**
   * Create a new booking flow for a remoteJid.
   * Phone is derived from the JID — never from user input.
   */
  createFlow(remoteJid) {
    const phone = remoteJid.replace('@s.whatsapp.net', '').slice(-10);

    const stmt = this.db.prepare(`
      INSERT INTO booking_flows (remote_jid, state, data_json, phone)
      VALUES (?, 'select_game', '{}', ?)
    `);
    const info = stmt.run(remoteJid, phone);

    const row = this.db.prepare('SELECT * FROM booking_flows WHERE id = ?').get(info.lastInsertRowid);
    logger.debug({ remoteJid, phone, flowId: row.id }, 'Booking flow created');
    return row;
  }

  /**
   * Get the active (non-terminal, non-expired) booking flow for a remoteJid.
   * Returns null if no active flow exists.
   */
  getActiveFlow(remoteJid) {
    const row = this.db.prepare(`
      SELECT * FROM booking_flows
      WHERE remote_jid = ?
        AND state NOT IN ('booked', 'cancelled', 'expired')
        AND expires_at > datetime('now')
      ORDER BY created_at DESC
      LIMIT 1
    `).get(remoteJid);

    return row || null;
  }

  /**
   * Advance the booking flow to the next state based on the event.
   * Merges data into data_json.
   * Returns { state, data } on success or { error: 'invalid_transition' } on failure.
   */
  advance(remoteJid, event, data = {}) {
    const flow = this.getActiveFlow(remoteJid);
    if (!flow) {
      return { error: 'no_active_flow' };
    }

    const transitions = TRANSITIONS[flow.state];
    if (!transitions || !transitions[event]) {
      logger.warn({ remoteJid, currentState: flow.state, event }, 'Invalid booking transition');
      return { error: 'invalid_transition' };
    }

    const newState = transitions[event];
    const existingData = JSON.parse(flow.data_json || '{}');
    const mergedData = { ...existingData, ...data };

    this.db.prepare(`
      UPDATE booking_flows
      SET state = ?, data_json = ?, updated_at = datetime('now')
      WHERE id = ?
    `).run(newState, JSON.stringify(mergedData), flow.id);

    logger.debug({ remoteJid, from: flow.state, to: newState, event }, 'Booking flow advanced');
    return { state: newState, data: mergedData };
  }

  /**
   * Cancel the active booking flow for a remoteJid.
   */
  cancelFlow(remoteJid) {
    const flow = this.getActiveFlow(remoteJid);
    if (!flow) return false;

    this.db.prepare(`
      UPDATE booking_flows
      SET state = 'cancelled', updated_at = datetime('now')
      WHERE id = ?
    `).run(flow.id);

    logger.debug({ remoteJid, flowId: flow.id }, 'Booking flow cancelled');
    return true;
  }

  /**
   * Expire all stale flows that have passed their expires_at time.
   * Returns the number of flows expired.
   */
  expireStaleFlows() {
    const result = this.db.prepare(`
      UPDATE booking_flows
      SET state = 'expired', updated_at = datetime('now')
      WHERE expires_at <= datetime('now')
        AND state NOT IN ('booked', 'cancelled', 'expired')
    `).run();

    if (result.changes > 0) {
      logger.debug({ count: result.changes }, 'Expired stale booking flows');
    }
    return result.changes;
  }

  /**
   * Get parsed data_json for the active flow.
   */
  getFlowData(remoteJid) {
    const flow = this.getActiveFlow(remoteJid);
    if (!flow) return null;
    return JSON.parse(flow.data_json || '{}');
  }
}

/**
 * Parse a user's numbered or text response against a list of options.
 * @param {string} text - User input (e.g., '2' or 'F1 25')
 * @param {Array<{text: string}>} options - Available options
 * @returns {object|null} The matched option, or null
 */
function parseNumberedResponse(text, options) {
  const trimmed = text.trim();
  const num = parseInt(trimmed);
  if (num >= 1 && num <= options.length) return options[num - 1];
  const lower = trimmed.toLowerCase();
  return options.find(o => o.text.toLowerCase().includes(lower)) || null;
}

module.exports = { BookingStateMachine, parseNumberedResponse, STATES };
