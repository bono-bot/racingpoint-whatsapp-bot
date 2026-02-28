const logger = require('../utils/logger');

// Simple in-memory rate limiter: max messages per window per user
const MAX_MESSAGES = 20;
const WINDOW_MS = 60 * 1000; // 1 minute

const userBuckets = new Map();

function isRateLimited(remoteJid) {
  const now = Date.now();
  let bucket = userBuckets.get(remoteJid);

  if (!bucket || now - bucket.windowStart > WINDOW_MS) {
    bucket = { windowStart: now, count: 0 };
    userBuckets.set(remoteJid, bucket);
  }

  bucket.count++;

  if (bucket.count > MAX_MESSAGES) {
    logger.warn({ remoteJid, count: bucket.count }, 'Rate limited');
    return true;
  }

  return false;
}

// Clean up old entries every 5 minutes
setInterval(() => {
  const now = Date.now();
  for (const [jid, bucket] of userBuckets) {
    if (now - bucket.windowStart > WINDOW_MS * 2) {
      userBuckets.delete(jid);
    }
  }
}, 5 * 60 * 1000).unref();

module.exports = { isRateLimited };
