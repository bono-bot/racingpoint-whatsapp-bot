const config = require('../config');
const logger = require('../utils/logger');

const RC_API_URL = config.racecontrol.apiUrl;
const RC_SECRET = config.racecontrol.terminalSecret;

const HEADERS = {
  'Content-Type': 'application/json',
  'x-terminal-secret': RC_SECRET,
};

async function lookupCustomer(phone) {
  const url = `${RC_API_URL}/bot/lookup?phone=${encodeURIComponent(phone)}`;
  const res = await fetch(url, { headers: HEADERS });
  const data = await res.json();

  if (data.error) {
    logger.error({ phone, error: data.error }, 'RC lookup failed');
    return null;
  }

  return data;
}

async function getPricing() {
  const url = `${RC_API_URL}/bot/pricing`;
  const res = await fetch(url, { headers: HEADERS });
  const data = await res.json();

  if (data.error) {
    logger.error({ error: data.error }, 'RC pricing fetch failed');
    return [];
  }

  return data.tiers || [];
}

async function bookSession(phone, pricingTierId, experienceId) {
  const url = `${RC_API_URL}/bot/book`;
  const body = {
    phone,
    pricing_tier_id: pricingTierId,
  };
  if (experienceId) body.experience_id = experienceId;

  const res = await fetch(url, {
    method: 'POST',
    headers: HEADERS,
    body: JSON.stringify(body),
  });

  const data = await res.json();

  if (data.status === 'error') {
    logger.warn({ phone, error: data.error, message: data.message }, 'RC booking failed');
  } else {
    logger.info({ phone, bookingId: data.booking_id, pod: data.pod_number }, 'RC booking created');
  }

  return data;
}

function isConfigured() {
  return Boolean(RC_API_URL && RC_SECRET);
}

module.exports = { lookupCustomer, getPricing, bookSession, isConfigured };
