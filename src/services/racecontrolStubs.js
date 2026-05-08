/**
 * racecontrolStubs.js — STUBs + runtime delegation for W1-S7+S8 ↔ W1-S6 integration boundary.
 *
 * STATUS (PART 51 segment-L): tri-modal runtime path —
 *   1. STAFF_PIN_HTTP_ENABLED=true → delegate to racecontrolApiClient.js (real HTTP)
 *      Gates on W1-S6 PIN-LOCKOUT auto-rotate Rust substrate shipping the racecontrol
 *      endpoints. Pre-W1-S6 this path will fail with HTTP 404; STUB stays default.
 *   2. STAFF_PIN_STUB_ENABLED=true → return mock data (scaffolding tests; not for prod)
 *   3. (default; both flags unset) → throw STUB-W1-S6-PENDING (production-mode safety)
 *
 * Both env flags MUST NOT be set together (asymmetric); HTTP wins if both set
 * (a deliberate "production-readiness > test-fixture" precedence).
 *
 * Composes-with: comms-link/.planning/draft-pacts/PACT-DRAFT-pact-001-phase-1-wave-1-static-billing-engine.md
 * (W1-S7 daily PIN delivery + W1-S8 fallback) + V2-MASTER-STATE.md §S-82 Q1
 * (Captain 2026-05-07 disposition: PIN-LOCKOUT auto-rotate + WhatsApp daily 06:00 IST + helpdesk@ fallback)
 * + V2-MASTER-STATE.md §S-122 (W1-S7+S8 scaffolding ship) + §S-123 (this segment-L wire-in prep)
 * + msg=35687 §1.1 W1-S6 wire-in API contracts.
 *
 * Substrate-Pointer Convention applied:
 *   - Q1.e PIN rotation cadence (canonical: V2-MASTER-STATE.md §S-82 Q1.e bono-default daily fresh)
 *   - Q1.f delivery time (canonical: V2-MASTER-STATE.md §S-82 Q1.f bono-default 06:00 IST)
 *   - PrivilegedAction enum (canonical: racecontrol commit 7f193030)
 *   - HTTP wire-in (canonical: src/services/racecontrolApiClient.js)
 *
 * Wire-in cascade gate-checks (per docs/W1-S7-S8-PIN-DELIVERY-SCAFFOLDING.md):
 *   2a. (DONE pre-W1-S6) racecontrolApiClient.js authored + 18/18 mock-fetch tests PASS
 *   2b. (POST-W1-S6) STAFF_PIN_HTTP_ENABLED=true env flag flips runtime to live HTTP
 *   2c. (POST-W1-S6) Real racecontrol endpoint smoke test under Captain auth gate
 */

'use strict';

const crypto = require('crypto');

const STUB_ENABLED = process.env.STAFF_PIN_STUB_ENABLED === 'true';
const HTTP_ENABLED = process.env.STAFF_PIN_HTTP_ENABLED === 'true';

// Lazy-require so smoke tests of STUB-mode don't load the HTTP client unless needed.
let _httpClient = null;
function getHttpClient() {
  if (_httpClient === null) {
    _httpClient = require('./racecontrolApiClient');
  }
  return _httpClient;
}

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
  if (HTTP_ENABLED) {
    return getHttpClient().fetchPinForStaff(staffId);
  }
  if (!STUB_ENABLED) {
    throw new Error(
      `STUB-W1-S6-PENDING: racecontrol GET /api/v2/staff/${staffId}/pin-of-the-day not yet implemented. ` +
      'Gate on james-LEAD W1-S6 PIN-LOCKOUT auto-rotate Rust substrate landing. ' +
      'Set STAFF_PIN_HTTP_ENABLED=true for live HTTP (post-W1-S6) ' +
      'OR STAFF_PIN_STUB_ENABLED=true for scaffolding tests only.'
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
  if (HTTP_ENABLED) {
    return getHttpClient().fetchStaffRegistry();
  }
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
  HTTP_ENABLED,
};
