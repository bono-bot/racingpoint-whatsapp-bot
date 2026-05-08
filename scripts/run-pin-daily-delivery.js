#!/usr/bin/env node
/**
 * run-pin-daily-delivery.js — cron entry script for W1-S7 daily PIN delivery.
 *
 * Schedule (production, post-W1-S6 land + Captain auth):
 *   0 6 * * *  cd /root/racingpoint-whatsapp-bot && node scripts/run-pin-daily-delivery.js
 *
 * Per V2-MASTER-STATE.md §S-82 Q1.f bono-default 06:00 IST.
 *
 * Test invocation:
 *   STAFF_PIN_STUB_ENABLED=true node scripts/run-pin-daily-delivery.js --dry-run
 *   STAFF_PIN_STUB_ENABLED=true node scripts/run-pin-daily-delivery.js   # actually sends to STUB target Captain WhatsApp
 *
 * Production invocation (STUB unset; gates on W1-S6 racecontrol substrate landing):
 *   node scripts/run-pin-daily-delivery.js
 *
 * Composes-with: staffPinDeliveryService.deliverDailyPins.
 */

'use strict';

const { deliverDailyPins } = require('../src/services/staffPinDeliveryService');
const logger = require('../src/utils/logger');

const dryRun = process.argv.includes('--dry-run');

(async () => {
  try {
    const stats = await deliverDailyPins({ dryRun });
    logger.info({ stats, dryRun }, 'pin-daily-delivery cron run complete');
    process.exit(stats.failed > 0 ? 1 : 0);
  } catch (err) {
    logger.error({ err: err.message, stack: err.stack }, 'pin-daily-delivery cron run failed');
    process.exit(2);
  }
})();
