'use strict';

/**
 * VPS Booking Service — atomic booking via RaceControl API with wallet check
 * and graceful degradation.
 *
 * Runs on the SAME VPS as RaceControl. All API calls are to localhost:8080.
 * CommonJS module matching v1.0 service pattern.
 */

// ── Config (env vars, matching config.ts pattern) ─────────────────────
const RC_API_URL = process.env.RACECONTROL_URL || 'http://localhost:8080';
const RC_SECRET = process.env.RC_TERMINAL_SECRET || '';

const HEADERS = {
  'Content-Type': 'application/json',
  'x-terminal-secret': RC_SECRET,
};

// ── Simple logger (pino-compatible subset) ─────────────────────────────
const pino = (() => {
  try { return require('pino'); } catch { return null; }
})();
const logger = pino
  ? pino({ level: process.env.NODE_ENV === 'production' ? 'info' : 'debug' })
  : { info: console.log, warn: console.warn, error: console.error, debug: () => {} };

// ── Exported constants ─────────────────────────────────────────────────

const GRACEFUL_DEGRADATION_MSG =
  "I can't process bookings right now. Please call +91 7981264279 to book, or just walk in — we're at Vantage Line Mall, 3rd Floor!";

function WALLET_TOPUP_MSG(balance, required) {
  return (
    `Your wallet balance is Rs.${balance} but this booking needs Rs.${required}.\n\n` +
    `Top up here: https://app.racingpoint.cloud/wallet\n\n` +
    `Once topped up, just say 'book' and we'll get you racing!`
  );
}

// ── Helper: fetch with AbortController timeout ─────────────────────────

async function fetchWithTimeout(url, options, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    return res;
  } finally {
    clearTimeout(timer);
  }
}

// ── Service functions ──────────────────────────────────────────────────

/**
 * Quick health check — can we reach the VPS RaceControl API?
 * @returns {Promise<boolean>}
 */
async function isVPSReachable() {
  try {
    const res = await fetchWithTimeout(
      `${RC_API_URL}/api/v1/bot/pods-status`,
      { method: 'GET', headers: HEADERS },
      3000
    );
    return res.ok;
  } catch (err) {
    logger.debug({ err: err.message }, 'VPS reachability check failed');
    return false;
  }
}

/**
 * Check wallet balance for a phone number.
 * @param {string} phone - Customer phone number
 * @param {number} [requiredAmount=0] - Amount needed for comparison
 * @returns {Promise<{balance: number, sufficient: boolean, shortfall: number, error?: string}>}
 */
async function checkWalletBalance(phone, requiredAmount = 0) {
  try {
    const res = await fetchWithTimeout(
      `${RC_API_URL}/api/v1/bot/lookup?phone=${encodeURIComponent(phone)}`,
      { method: 'GET', headers: HEADERS },
      5000
    );

    if (!res.ok) {
      logger.warn({ status: res.status, phone }, 'Wallet lookup failed');
      return { balance: 0, sufficient: false, shortfall: requiredAmount, error: 'lookup_failed' };
    }

    const data = await res.json();
    const balance = data.wallet_balance || data.balance || 0;
    const sufficient = balance >= requiredAmount;
    const shortfall = sufficient ? 0 : requiredAmount - balance;

    return { balance, sufficient, shortfall };
  } catch (err) {
    logger.warn({ err: err.message, phone }, 'Wallet balance check failed (VPS unreachable)');
    return { balance: 0, sufficient: false, shortfall: requiredAmount, error: 'vps_unreachable' };
  }
}

/**
 * Fetch available pricing tiers from VPS.
 * @returns {Promise<Array<{id: string, name: string, duration_minutes: number, price_paise: number, is_trial: boolean}>>}
 */
async function getPricingTiers() {
  try {
    const res = await fetchWithTimeout(
      `${RC_API_URL}/api/v1/bot/pricing`,
      { method: 'GET', headers: HEADERS },
      5000
    );
    if (!res.ok) return [];
    const data = await res.json();
    return data.tiers || [];
  } catch {
    return [];
  }
}

/**
 * Book a session via VPS RaceControl API (atomic wallet+slot).
 * VPS handles: wallet check → find idle pod → debit wallet → reserve pod → create auth token.
 * @param {string} phone - Customer phone
 * @param {string} pricingTierId - Pricing tier ID (e.g., 'tier_30min', 'tier_60min', 'tier_trial')
 * @param {string} [experienceId] - Optional experience/game ID
 * @returns {Promise<{success: boolean, bookingId?: string, podNumber?: number, pin?: string, durationMinutes?: number, tierName?: string, message?: string, reason?: string, balance?: number, required?: number, topUpUrl?: string}>}
 */
async function bookViaVPS(phone, pricingTierId, experienceId) {
  try {
    // Idempotency key: phone + tier + 5-min window = prevents double-booking on retry/duplicate webhook
    const idempotencyKey = `${phone}-${pricingTierId}-${Math.floor(Date.now() / 300000)}`;
    const body = { phone, pricing_tier_id: pricingTierId, idempotency_key: idempotencyKey };
    if (experienceId) body.experience_id = experienceId;

    const res = await fetchWithTimeout(
      `${RC_API_URL}/api/v1/bot/book`,
      {
        method: 'POST',
        headers: HEADERS,
        body: JSON.stringify(body),
      },
      5000
    );

    const data = await res.json().catch(() => ({}));

    // ── Success (status: "booked") ─────────────────────────────────
    if (res.ok && data.status === 'booked') {
      logger.info({ phone, podNumber: data.pod_number, bookingId: data.booking_id, pin: data.pin }, 'VPS booking succeeded');
      return {
        success: true,
        bookingId: data.booking_id,
        podNumber: data.pod_number,
        pin: data.pin,
        durationMinutes: data.duration_minutes,
        tierName: data.tier_name,
        message: data.message,
      };
    }

    // ── Insufficient balance ────────────────────────────────────────
    if (data.error === 'insufficient_balance') {
      const balance = Math.round((data.balance_paise || 0) / 100);
      const required = Math.round((data.required_paise || 0) / 100);
      logger.info({ phone, balance, required }, 'VPS booking: insufficient balance');
      return {
        success: false,
        reason: 'insufficient_wallet',
        balance,
        required,
        topUpUrl: 'https://app.racingpoint.cloud/wallet',
      };
    }

    // ── Not registered ──────────────────────────────────────────────
    if (data.error === 'not_registered') {
      logger.info({ phone }, 'VPS booking: customer not registered');
      return { success: false, reason: 'not_registered', message: data.message };
    }

    // ── No pods available ───────────────────────────────────────────
    if (data.error === 'no_pods') {
      logger.info({ phone }, 'VPS booking: no pods available');
      return { success: false, reason: 'no_pods', message: data.message };
    }

    // ── Active reservation exists ───────────────────────────────────
    if (data.error === 'active_reservation') {
      logger.info({ phone }, 'VPS booking: already has active reservation');
      return { success: false, reason: 'active_reservation', message: data.message };
    }

    // ── Trial already used ──────────────────────────────────────────
    if (data.error === 'trial_used') {
      logger.info({ phone }, 'VPS booking: trial already used');
      return { success: false, reason: 'trial_used', message: data.message };
    }

    // ── Other server error ─────────────────────────────────────────
    logger.warn({ phone, status: res.status, data }, 'VPS booking: unexpected response');
    return { success: false, reason: 'unknown', message: data.message || data.error || `HTTP ${res.status}` };
  } catch (err) {
    // ── Network error / timeout ────────────────────────────────────
    if (err.name === 'AbortError') {
      logger.warn({ phone }, 'VPS booking: request timed out');
    } else {
      logger.warn({ err: err.message, phone }, 'VPS booking: network error');
    }
    return { success: false, reason: 'vps_unreachable' };
  }
}

// ── Exports (CommonJS) ─────────────────────────────────────────────────

module.exports = {
  bookViaVPS,
  checkWalletBalance,
  isVPSReachable,
  getPricingTiers,
  GRACEFUL_DEGRADATION_MSG,
  WALLET_TOPUP_MSG,
};
