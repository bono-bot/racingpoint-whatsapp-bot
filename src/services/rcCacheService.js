const logger = require('../utils/logger');
const config = require('../config');

// Lazy-load racecontrolService to avoid circular dependency issues
let rcService = null;
function getRcService() {
  if (!rcService) {
    rcService = require('./racecontrolService');
  }
  return rcService;
}

const { reportRcHealth } = require('./venueStatusService');
const RC_API_URL = config.racecontrol.apiUrl;
const RC_SECRET = config.racecontrol.terminalSecret;
const HEADERS = {
  'Content-Type': 'application/json',
  'x-terminal-secret': RC_SECRET,
};

// In-memory cache
const cache = {
  pods: { data: null, lastUpdated: null, error: null },
  pricing: { data: null, lastUpdated: null, error: null },
  bookingCount: { data: 0, lastUpdated: null, error: null },
};

const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
const STALE_THRESHOLD_MS = 15 * 60 * 1000; // 15 minutes = definitely stale

let syncInterval = null;

/**
 * Refresh all cached RC data. Called every 5 minutes by setInterval.
 * On failure, preserves old cached data and records the error.
 */
async function refreshCache() {
  const rc = getRcService();

  // 1. Pods status
  try {
    const pods = await rc.getPodsStatus();
    // BOOK-03 safety: strip all fields except total/available/in_use
    cache.pods.data = {
      total: pods.total,
      available: pods.available,
      in_use: pods.in_use,
    };
    cache.pods.lastUpdated = Date.now();
    cache.pods.error = null;
  } catch (err) {
    cache.pods.error = err.message;
    logger.warn({ err: err.message }, 'RC cache: failed to refresh pods');
  }

  // 2. Pricing
  try {
    const tiers = await rc.getPricing();
    cache.pricing.data = tiers;
    cache.pricing.lastUpdated = Date.now();
    cache.pricing.error = null;
  } catch (err) {
    cache.pricing.error = err.message;
    logger.warn({ err: err.message }, 'RC cache: failed to refresh pricing');
  }

  // 3. Booking count today
  try {
    const res = await fetch(`${RC_API_URL}/bot/booking-count-today`, { headers: HEADERS });
    const data = await res.json();
    cache.bookingCount.data = data.count || 0;
    cache.bookingCount.lastUpdated = Date.now();
    cache.bookingCount.error = null;
  } catch (err) {
    // Endpoint may not exist yet — graceful default
    if (!cache.bookingCount.lastUpdated) {
      cache.bookingCount.data = 0;
    }
    cache.bookingCount.error = err.message;
    logger.debug({ err: err.message }, 'RC cache: booking-count-today unavailable (may not exist yet)');
  }

  // Report health to venue status service for auto-close detection
  const podsOk = !!cache.pods.data && !cache.pods.error;
  reportRcHealth(podsOk);

  logger.info(
    {
      pods: !!cache.pods.data,
      pricing: !!cache.pricing.data,
      bookings: cache.bookingCount.data,
    },
    'RC cache refreshed'
  );
}

/**
 * Check if a cache entry is stale (older than STALE_THRESHOLD_MS).
 */
function isEntryStale(entry) {
  if (!entry.lastUpdated) return true;
  return Date.now() - entry.lastUpdated > STALE_THRESHOLD_MS;
}

/**
 * Get cached pods data with staleness info.
 * @returns {{ data: {total, available, in_use}|null, stale: boolean, unavailable: boolean }}
 */
function getCachedPods() {
  return {
    data: cache.pods.data,
    stale: isEntryStale(cache.pods),
    unavailable: cache.pods.data === null,
  };
}

/**
 * Get cached pricing data with staleness info.
 * @returns {{ data: Array|null, stale: boolean, unavailable: boolean }}
 */
function getCachedPricing() {
  return {
    data: cache.pricing.data,
    stale: isEntryStale(cache.pricing),
    unavailable: cache.pricing.data === null,
  };
}

/**
 * Get cached booking count for today.
 * @returns {{ count: number, stale: boolean }}
 */
function getCachedBookingCount() {
  return {
    count: cache.bookingCount.data,
    stale: isEntryStale(cache.bookingCount),
  };
}

/**
 * Returns true if any cache entry is older than STALE_THRESHOLD_MS.
 */
function isCacheStale() {
  return isEntryStale(cache.pods) || isEntryStale(cache.pricing) || isEntryStale(cache.bookingCount);
}

/**
 * Start periodic cache sync. Refreshes immediately, then every CACHE_TTL_MS.
 */
function startCacheSync() {
  logger.info({ ttlMs: CACHE_TTL_MS, staleMs: STALE_THRESHOLD_MS }, 'Starting RC cache sync');
  refreshCache(); // immediate first refresh
  syncInterval = setInterval(refreshCache, CACHE_TTL_MS);
}

/**
 * Stop periodic cache sync.
 */
function stopCacheSync() {
  if (syncInterval) {
    clearInterval(syncInterval);
    syncInterval = null;
    logger.info('RC cache sync stopped');
  }
}

module.exports = {
  getCachedPods,
  getCachedPricing,
  getCachedBookingCount,
  isCacheStale,
  startCacheSync,
  stopCacheSync,
};
