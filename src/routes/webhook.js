const { Router } = require('express');
const { parseWebhookPayload } = require('../utils/messageParser');
const { handleMessage } = require('../services/messageHandler');
const { adaptKapsoWebhook, verifyKapsoSignature } = require('../kapso/webhook-adapter');
const config = require('../config');
const logger = require('../utils/logger');

const router = Router();

// ── Webhook deduplication (prevents duplicate processing on retry/reconnect) ──
const recentWebhookIds = new Map();
const DEDUPE_TTL_MS = 5 * 60 * 1000; // 5 min

function isDuplicate(eventId) {
  if (!eventId) return false;
  if (recentWebhookIds.has(eventId)) return true;
  recentWebhookIds.set(eventId, Date.now());
  // Sweep old entries every 100 inserts
  if (recentWebhookIds.size % 100 === 0) {
    const cutoff = Date.now() - DEDUPE_TTL_MS;
    for (const [k, v] of recentWebhookIds) {
      if (v < cutoff) recentWebhookIds.delete(k);
    }
  }
  return false;
}

// ── Evolution API webhook auth ──
const EVOLUTION_WEBHOOK_SECRET = process.env.EVOLUTION_WEBHOOK_SECRET || '';

function verifyEvolutionAuth(req) {
  if (!EVOLUTION_WEBHOOK_SECRET) return true; // No secret = open (backwards compat)
  const provided = req.headers['x-webhook-secret'] || req.headers['authorization'];
  return provided === EVOLUTION_WEBHOOK_SECRET || provided === `Bearer ${EVOLUTION_WEBHOOK_SECRET}`;
}

router.post('/webhook', (req, res) => {
  // Respond immediately
  res.status(200).json({ status: 'received' });

  const webhookEvent = req.headers['x-webhook-event'];

  // ── Kapso webhook path ──
  if (config.USE_KAPSO && webhookEvent) {
    if (config.kapso.webhookSecret) {
      if (!verifyKapsoSignature(req, config.kapso.webhookSecret)) {
        logger.warn('Kapso webhook: signature verification failed, ignoring');
        return;
      }
    }

    if (webhookEvent !== 'whatsapp.message.received') {
      logger.debug({ webhookEvent }, 'Kapso webhook: ignoring non-message event');
      return;
    }

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

  // ── Evolution API webhook path ──

  // Auth check (if secret configured)
  if (!verifyEvolutionAuth(req)) {
    logger.warn({ ip: req.ip }, 'Evolution webhook: auth failed, ignoring');
    return;
  }

  const event = req.body.event;
  if (event !== 'messages.upsert') return;

  // Dedupe by message key
  const msgKey = req.body.data?.key?.id || req.body.data?.message?.key?.id;
  if (isDuplicate(msgKey)) {
    logger.debug({ msgKey }, 'Duplicate webhook ignored');
    return;
  }

  const parsed = parseWebhookPayload(req.body);
  if (!parsed) return;

  logger.info({ remoteJid: parsed.remoteJid, pushName: parsed.pushName, text: parsed.text.substring(0, 50) }, 'Incoming message');

  handleMessage(parsed).catch(err => {
    logger.error({ err, remoteJid: parsed.remoteJid }, 'Unhandled error in message handler');
  });
});

module.exports = router;
