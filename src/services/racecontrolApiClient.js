/**
 * racecontrolApiClient.js — real HTTP client for W1-S7+S8 ↔ W1-S6 integration.
 *
 * STATUS: WIRE-IN PREP (PART 51 segment-L) — authored ahead of W1-S6 landing.
 * Runtime path stays STUB-delegated until STAFF_PIN_HTTP_ENABLED=true env flag is set
 * AND W1-S6 ships the racecontrol endpoints. See racecontrolStubs.js delegation logic.
 *
 * Composes-with:
 *   - PACT-DRAFT-pact-001-phase-1-wave-1-static-billing-engine.md §1.1 W1-S6 + W1-S7 + W1-S8
 *   - V2-MASTER-STATE.md §S-122 (W1-S7+S8 scaffolding ship) + §S-123 (this segment-L wire-in prep)
 *   - msg=35677 §1.1 W1-S6 wire-in API contracts (sender=bono recipient=james 2026-05-08 14:06 IST)
 *   - PACT-018 security-debt-ledger class=credential-storage closure_phase=Phase-0.5c-AUTH (pin_hash SHA-256 only)
 *
 * Substrate-Pointer Convention applied throughout (canonical: pointers per declaration).
 *
 * RUNTIME GATE: This module DOES NOT replace racecontrolStubs.js. It is consumed BY stubs
 * via delegation when STAFF_PIN_HTTP_ENABLED=true. Pre-W1-S6, calling the real client will
 * fail with HTTP 404 (endpoints don't exist yet); STUB delegation is the production path
 * until W1-S6 lands AND Captain explicit auth gate fires for live PIN flow per gate-check #4.
 */

'use strict';

/**
 * Custom error class — racecontrol API rejected the request.
 *
 * Caller can branch on .status (HTTP) or .code (well-known error key like 'NETWORK', 'PARSE').
 */
class RacecontrolApiError extends Error {
  constructor(message, { status = null, code = null, cause = null } = {}) {
    super(message);
    this.name = 'RacecontrolApiError';
    this.status = status;
    this.code = code;
    if (cause) this.cause = cause;
  }
}

/**
 * Read RACECONTROL_API_URL + RACECONTROL_SERVICE_KEY from env at call-time.
 *
 * Read-at-call (not module-load) lets tests inject env per-test without process restart.
 * Throws RacecontrolApiError(code='CONFIG') if either is missing — fail loud, not silent
 * (a missing service key is a security-debt-ledger violation per PACT-018).
 */
function readConfig() {
  const url = process.env.RACECONTROL_API_URL;
  const key = process.env.RACECONTROL_SERVICE_KEY;
  if (!url) {
    throw new RacecontrolApiError(
      'RACECONTROL_API_URL env var is unset; cannot reach racecontrol API',
      { code: 'CONFIG' }
    );
  }
  if (!key) {
    throw new RacecontrolApiError(
      'RACECONTROL_SERVICE_KEY env var is unset; cannot authenticate to racecontrol API',
      { code: 'CONFIG' }
    );
  }
  return { url: url.replace(/\/$/, ''), key };
}

/**
 * Internal — perform a GET against racecontrol with X-Service-Key auth.
 *
 * Returns parsed JSON on 200; throws RacecontrolApiError on non-200, network failure,
 * or parse failure. Intentionally minimal: no retries (caller decides), no timeouts beyond
 * Node default fetch timeout (caller can pass AbortController via opts.signal).
 */
async function getJson(path, opts = {}) {
  const { url, key } = readConfig();
  const target = `${url}${path}`;
  let res;
  try {
    res = await fetch(target, {
      method: 'GET',
      headers: { 'X-Service-Key': key, Accept: 'application/json' },
      signal: opts.signal,
    });
  } catch (err) {
    throw new RacecontrolApiError(
      `racecontrol GET ${path} network failure: ${err.message}`,
      { code: 'NETWORK', cause: err }
    );
  }
  if (!res.ok) {
    throw new RacecontrolApiError(
      `racecontrol GET ${path} returned HTTP ${res.status}`,
      { status: res.status, code: 'HTTP' }
    );
  }
  try {
    return await res.json();
  } catch (err) {
    throw new RacecontrolApiError(
      `racecontrol GET ${path} response not valid JSON: ${err.message}`,
      { code: 'PARSE', cause: err }
    );
  }
}

/**
 * GET /api/v2/staff/${staffId}/pin-of-the-day
 *
 * Per msg=35677 §1.1 wire-in spec:
 *   200 OK envelope: { pin: string(6), pin_hash: string(64-hex), staff_id: string,
 *                      rotated_at_ist: ISO-8601, expires_at_ist: ISO-8601 }
 *   Side effect: GET fires PIN rotation if not already rotated for today (idempotent;
 *                respects §S-82 Q1.e "previous-day auto-invalidates AT DELIVERY TIME"); race-safe
 *                via row lock on staff record (W1-S6 server-side concern).
 *   404 → staff not found OR not yet rotated; 401 → bad service key.
 *
 * @param {string} staffId
 * @param {{signal?: AbortSignal}} [opts]
 * @returns {Promise<{pin: string, pin_hash: string, staff_id: string, rotated_at_ist: string, expires_at_ist: string}>}
 */
async function fetchPinForStaff(staffId, opts = {}) {
  if (!staffId || typeof staffId !== 'string') {
    throw new RacecontrolApiError(
      'fetchPinForStaff: staffId must be a non-empty string',
      { code: 'INPUT' }
    );
  }
  const path = `/api/v2/staff/${encodeURIComponent(staffId)}/pin-of-the-day`;
  const data = await getJson(path, opts);
  // Envelope contract check — fail loud if W1-S6 ships a different shape so we catch it
  // pre-prod rather than emitting NaN/undefined PINs through WhatsApp.
  for (const field of ['pin', 'pin_hash', 'staff_id', 'rotated_at_ist', 'expires_at_ist']) {
    if (typeof data[field] !== 'string' || data[field].length === 0) {
      throw new RacecontrolApiError(
        `fetchPinForStaff envelope missing/invalid field "${field}"`,
        { code: 'CONTRACT' }
      );
    }
  }
  return data;
}

/**
 * GET /api/v2/staff?active=true
 *
 * Per msg=35677 §1.1 wire-in spec:
 *   200 OK envelope: [{ staff_id, whatsapp_e164, display_name, active, registered_at_ist }, ...]
 *   Gates on Phase-0.5c-AUTH closure (PACT-20260503-018 RATIFIED 2026-05-05).
 *
 * @param {{signal?: AbortSignal}} [opts]
 * @returns {Promise<Array<{staff_id: string, whatsapp_e164: string, display_name: string, active: boolean, registered_at_ist: string}>>}
 */
async function fetchStaffRegistry(opts = {}) {
  const path = '/api/v2/staff?active=true';
  const data = await getJson(path, opts);
  if (!Array.isArray(data)) {
    throw new RacecontrolApiError(
      'fetchStaffRegistry envelope is not an array',
      { code: 'CONTRACT' }
    );
  }
  for (const [i, row] of data.entries()) {
    for (const field of ['staff_id', 'whatsapp_e164', 'display_name']) {
      if (typeof row[field] !== 'string' || row[field].length === 0) {
        throw new RacecontrolApiError(
          `fetchStaffRegistry row[${i}] missing/invalid field "${field}"`,
          { code: 'CONTRACT' }
        );
      }
    }
  }
  return data;
}

module.exports = {
  fetchPinForStaff,
  fetchStaffRegistry,
  RacecontrolApiError,
  // exposed for tests:
  _readConfig: readConfig,
};
