/**
 * IST time awareness and venue open/closed logic.
 *
 * Racing Point eSports hours: 12:00 PM to 12:00 AM (midnight) IST, daily.
 * No holidays — open every day.
 */

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000; // UTC+5:30
const VENUE_OPEN_HOUR = 12; // 12 PM
const VENUE_CLOSE_HOUR = 24; // midnight (hour 0 next day)
// Venue closure override
const { isVenueClosed, getClosureMessage } = require('./venueStatusService');

/**
 * Get current time in IST regardless of server timezone.
 * @returns {Date} Date object representing current IST time
 */
function getCurrentIST() {
  const now = new Date();
  const utc = now.getTime() + now.getTimezoneOffset() * 60000;
  return new Date(utc + IST_OFFSET_MS);
}

/**
 * Check if venue is currently open (12 PM - midnight IST).
 * @returns {boolean}
 */
function isVenueOpen() {
  // Venue closure override — manual or auto-detected
  if (isVenueClosed()) return false;
  const ist = getCurrentIST();
  const hour = ist.getHours();
  return hour >= VENUE_OPEN_HOUR; // hours 12-23 = open
}

/**
 * Get a human-friendly venue status message with current IST time.
 * @returns {string}
 */
function getVenueStatusMessage() {
  // Return closure message if venue is closed (manual or auto)
  if (isVenueClosed()) return getClosureMessage();
  const ist = getCurrentIST();
  const hour = ist.getHours();
  const timeStr = ist.toLocaleTimeString('en-IN', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: true,
  });

  if (hour >= VENUE_OPEN_HOUR) {
    const hoursLeft = 24 - hour;
    if (hoursLeft <= 1) {
      return `Yes, we're open! It's ${timeStr} IST — we close at midnight, so come quick!`;
    }
    return `Yes, we're open right now! It's ${timeStr} IST — we're open until midnight.`;
  }
  return `We're currently closed — it's ${timeStr} IST. We open daily at 12:00 PM. See you then!`;
}

module.exports = { getCurrentIST, isVenueOpen, getVenueStatusMessage };
