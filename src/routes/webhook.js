const { Router } = require('express');
const { parseWebhookPayload } = require('../utils/messageParser');
const { handleMessage } = require('../services/messageHandler');
const { adaptKapsoWebhook, verifyKapsoSignature } = require('../kapso/webhook-adapter');
const config = require('../config');
const logger = require('../utils/logger');

const router = Router();

router.post('/webhook', (req, res) => {
  // Respond immediately
  res.status(200).json({ status: 'received' });

  const webhookEvent = req.headers['x-webhook-event'];

  // ── Kapso webhook path ──
  if (config.USE_KAPSO && webhookEvent) {
    // Verify signature if secret is configured
    if (config.kapso.webhookSecret) {
      if (!verifyKapsoSignature(req, config.kapso.webhookSecret)) {
        logger.warn('Kapso webhook: signature verification failed, ignoring');
        return;
      }
    }

    // Only handle message events
    if (webhookEvent !== 'whatsapp.message.received') {
      logger.debug({ webhookEvent }, 'Kapso webhook: ignoring non-message event');
      return;
    }

    // Determine source (staff vs customer) from phone_number_id
    const phoneNumberId = req.body.phone_number_id
      || req.body.conversation?.phone_number_id
      || '';
    let source = 'customer';
    if (phoneNumberId === config.kapso.staffPhoneNumberId) {
      source = 'staff';
    }

    const parsed = adaptKapsoWebhook(req.body, source);
    if (!parsed) return;

    logger.info({ remoteJid: parsed.remoteJid, pushName: parsed.pushName, text: parsed.text.substring(0, 50), source }, 'Incoming Kapso message');

    handleMessage(parsed).catch(err => {
      logger.error({ err, remoteJid: parsed.remoteJid }, 'Unhandled error in message handler (Kapso)');
    });
    return;
  }

  // ── Evolution API webhook path (existing behavior) ──
  const event = req.body.event;

  // Only process message upsert events
  if (event !== 'messages.upsert') {
    return;
  }

  const parsed = parseWebhookPayload(req.body);
  if (!parsed) return;

  logger.info({ remoteJid: parsed.remoteJid, pushName: parsed.pushName, text: parsed.text.substring(0, 50) }, 'Incoming message');

  // Handle async — don't block the webhook response
  handleMessage(parsed).catch(err => {
    logger.error({ err, remoteJid: parsed.remoteJid }, 'Unhandled error in message handler');
  });
});

module.exports = router;
