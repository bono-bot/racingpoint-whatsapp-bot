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

async function getPodsStatus() {
  const url = `${RC_API_URL}/bot/pods-status`;
  const res = await fetch(url, { headers: HEADERS });
  const data = await res.json();
  if (data.error) {
    logger.error({ error: data.error }, 'RC pods-status fetch failed');
    return { total: 0, available: 0, message: 'Unable to check availability right now.' };
  }
  return data; // { total, available, in_use, message }
}

async function getEvents() {
  const url = `${RC_API_URL}/bot/events`;
  const res = await fetch(url, { headers: HEADERS });
  const data = await res.json();
  if (data.error) {
    logger.error({ error: data.error }, 'RC events fetch failed');
    return { tournaments: [], time_trials: [], has_events: false };
  }
  return data;
}

async function getCustomerStats(phone) {
  const url = `${RC_API_URL}/bot/customer-stats?phone=${encodeURIComponent(phone)}`;
  const res = await fetch(url, { headers: HEADERS });
  const data = await res.json();
  if (data.error) {
    logger.error({ phone, error: data.error }, 'RC customer-stats fetch failed');
    return null;
  }
  return data;
}

async function registerLead(phone, name, intent) {
  const url = `${RC_API_URL}/bot/register-lead`;
  const res = await fetch(url, {
    method: 'POST',
    headers: HEADERS,
    body: JSON.stringify({ phone, name, source: 'whatsapp', intent }),
  });
  const data = await res.json();
  return data;
}

function isConfigured() {
  return Boolean(RC_API_URL && RC_SECRET);
}

module.exports = { lookupCustomer, getPricing, bookSession, isConfigured, getPodsStatus, getEvents, getCustomerStats, registerLead };
