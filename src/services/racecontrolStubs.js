/**
 * racecontrolStubs.js — STUBs for W1-S7+S8 ↔ W1-S6 integration boundary.
 *
 * STATUS: STUB — gates on james-LEAD W1-S6 PIN-LOCKOUT auto-rotate Rust substrate
 * landing in racecontrol. When W1-S6 ships, replace these STUBs with real HTTP
 * calls to racecontrol API.
 *
 * Composes-with: comms-link/.planning/draft-pacts/PACT-DRAFT-pact-001-phase-1-wave-1-static-billing-engine.md
 * (W1-S7 daily PIN delivery + W1-S8 fallback) + V2-MASTER-STATE.md §S-82 Q1
 * (Captain 2026-05-07 disposition: PIN-LOCKOUT auto-rotate + WhatsApp daily 06:00 IST + helpdesk@ fallback).
 *
 * Substrate-Pointer Convention applied:
 *   - Q1.e PIN rotation cadence (canonical: V2-MASTER-STATE.md §S-82 Q1.e bono-default daily fresh)
 *   - Q1.f delivery time (canonical: V2-MASTER-STATE.md §S-82 Q1.f bono-default 06:00 IST)
 *   - PrivilegedAction enum (canonical: racecontrol commit 7f193030)
 *
 * Test mode: set STAFF_PIN_STUB_ENABLED=true env var to return mock data for
 * scaffolding tests. Production runs MUST have STUB_ENABLED unset; W1-S6 wire-in
 * replaces these functions before production cron registration.
 */

'use strict';

const crypto = require('crypto');

const STUB_ENABLED = process.env.STAFF_PIN_STUB_ENABLED === 'true';

/**
 * Fetch today's PIN for a given staff_id from racecontrol.
 *
 * REAL IMPLEMENTATION (post-W1-S6):
 *   GET ${RACECONTROL_URL}/api/v2/staff/${staffId}/pin-of-the-day
 *     Headers: X-Staff-Auth or service-key
 *     Returns: { pin: "123456", pin_hash: "<sha256>", expires_at_ist: "2026-05-09T06:00:00+05:30",
 *               rotated_at_ist: "2026-05-09T06:00:00+05:30", staff_id: "..." }
 *
 * STUB BEHAVIOR: throws unless STAFF_PIN_STUB_ENABLED=true (then returns mock 6-digit PIN).
 *
 * @param {string} staffId
 * @returns {Promise<{pin: string, pin_hash: string, expires_at_ist: string, staff_id: string}>}
 */
async function fetchPinForStaff(staffId) {
  if (!STUB_ENABLED) {
    throw new Error(
      `STUB-W1-S6-PENDING: racecontrol GET /api/v2/staff/${staffId}/pin-of-the-day not yet implemented. ` +
      'Gate on james-LEAD W1-S6 PIN-LOCKOUT auto-rotate Rust substrate landing. ' +
      'Set STAFF_PIN_STUB_ENABLED=true for scaffolding tests only.'
    );
  }

  // Test mode: deterministic mock PIN per staff_id + date for repeatable testing
  const today = new Date().toISOString().slice(0, 10);
  const seed = `${staffId}:${today}:STUB`;
  const hash = crypto.createHash('sha256').update(seed).digest('hex');
  const pin = (parseInt(hash.slice(0, 6), 16) % 900000 + 100000).toString();
  const pinHash = crypto.createHash('sha256').update(pin).digest('hex');

  return {
    pin,
    pin_hash: pinHash,
    expires_at_ist: `${today}T06:00:00+05:30`,
    rotated_at_ist: `${today}T06:00:00+05:30`,
    staff_id: staffId,
  };
}

/**
 * Fetch staff registry from racecontrol.
 *
 * REAL IMPLEMENTATION (post-Phase-0.5c-AUTH closure):
 *   GET ${RACECONTROL_URL}/api/v2/staff?active=true
 *     Returns: [{ staff_id: "...", whatsapp_e164: "+91...", display_name: "..." }, ...]
 *
 * STUB BEHAVIOR: returns [] unless STAFF_PIN_STUB_ENABLED=true (then returns 1
 * mock staff entry with Captain's WhatsApp number for end-to-end smoke test only).
 *
 * @returns {Promise<Array<{staff_id: string, whatsapp_e164: string, display_name: string}>>}
 */
async function fetchStaffRegistry() {
  if (!STUB_ENABLED) {
    return [];
  }

  // Test mode: single mock staff entry — Uday's number per security-debt-ledger
  // class=credential-storage convention for testing-only paths
  return [
    {
      staff_id: 'STUB_STAFF_001',
      whatsapp_e164: '917981264279', // Captain WhatsApp (test target only)
      display_name: 'STUB Captain',
    },
  ];
}

module.exports = {
  fetchPinForStaff,
  fetchStaffRegistry,
  STUB_ENABLED,
};
