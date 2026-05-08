#!/usr/bin/env node
/**
 * run-pin-fallback-check.js — cron entry script for W1-S8 helpdesk@ fallback check.
 *
 * Schedule (production, post-W1-S6 land + Captain auth):
 *   *\/5 * * * *  cd /root/racingpoint-whatsapp-bot && node scripts/run-pin-fallback-check.js
 *
 * Per V2-MASTER-STATE.md §S-82 Q1.h bono-default 30min fallback to helpdesk@.
 * Cron runs every 5min; finds events older than 30min without ack; dispatches
 * helpdesk fallback email per staff.
 *
 * Test invocation:
 *   node scripts/run-pin-fallback-check.js --dry-run    # log candidates only
 *   node scripts/run-pin-fallback-check.js              # actually send helpdesk emails
 *
 * Composes-with: staffPinDeliveryService.findPendingFallbacks + .fallbackToHelpdesk.
 */

'use strict';

const {
  findPendingFallbacks,
  fallbackToHelpdesk,
} = require('../src/services/staffPinDeliveryService');
const logger = require('../src/utils/logger');

const dryRun = process.argv.includes('--dry-run');

(async () => {
  try {
    const pending = findPendingFallbacks();
    logger.info({ count: pending.length, dryRun }, 'pin-fallback-check candidates');

    let sent = 0;
    let failed = 0;

    for (const eventRow of pending) {
      if (dryRun) {
        logger.info({
          eventId: eventRow.id,
          staffId: eventRow.staff_id,
          deliveryAttemptAt: eventRow.delivery_attempt_at,
        }, 'pin-fallback-check dry-run — would dispatch helpdesk fallback');
        continue;
      }
      try {
        await fallbackToHelpdesk(eventRow);
        sent += 1;
      } catch (err) {
        logger.error({
          eventId: eventRow.id,
          err: err.message,
        }, 'fallbackToHelpdesk failed');
        failed += 1;
      }
    }

    logger.info({ candidates: pending.length, sent, failed, dryRun }, 'pin-fallback-check run complete');
    process.exit(failed > 0 ? 1 : 0);
  } catch (err) {
    logger.error({ err: err.message, stack: err.stack }, 'pin-fallback-check run failed');
    process.exit(2);
  }
})();
