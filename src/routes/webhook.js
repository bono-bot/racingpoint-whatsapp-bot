const { Router } = require('express');
const { parseWebhookPayload } = require('../utils/messageParser');
const { handleMessage } = require('../services/messageHandler');
const logger = require('../utils/logger');

const router = Router();

router.post('/webhook', (req, res) => {
  // Respond immediately to Evolution API
  res.status(200).json({ status: 'received' });

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
