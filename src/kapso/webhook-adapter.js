const crypto = require('crypto');
const logger = require('../utils/logger');

/**
 * Adapt a Kapso webhook payload into the internal message format
 * expected by messageHandler.js.
 *
 * Internal format (from parseWebhookPayload in messageParser.js):
 * {
 *   remoteJid: "919059833001@s.whatsapp.net",
 *   messageId: "wamid.123",
 *   text: "Hello",
 *   pushName: "Customer",
 *   isInteractive: false,
 *   selectedId: null,
 *   source: "customer",
 *   messageType: "text"
 * }
 *
 * Kapso webhook payload (whatsapp.message.received):
 * {
 *   message: {
 *     id: "wamid.123",
 *     type: "text",
 *     from: "919059833001",
 *     text: { body: "Hello" },
 *     timestamp: "1730092800",
 *     kapso: { direction: "inbound", content: "Hello" },
 *     contacts: [{ profile: { name: "John" }, wa_id: "919059833001" }]
 *   },
 *   conversation: { phone_number: "+919059833001", phone_number_id: "12345" },
 *   phone_number_id: "12345"
 * }
 *
 * @param {object} kapsoPayload - Raw Kapso webhook body
 * @param {string} source       - "staff" or "customer"
 * @returns {object|null}       - Internal message format, or null to skip
 */
function adaptKapsoWebhook(kapsoPayload, source) {
  try {
    const msg = kapsoPayload.message;
    if (!msg) {
      // Status update or delivery receipt — skip
      logger.debug('Kapso webhook: no message field, skipping');
      return null;
    }

    const from = msg.from;
    if (!from) {
      logger.debug('Kapso webhook: no from field, skipping');
      return null;
    }

    // Ignore outbound messages
    if (msg.kapso && msg.kapso.direction === 'outbound') {
      return null;
    }

    // Extract text content based on message type
    let text = null;
    let isInteractive = false;
    let selectedId = null;

    switch (msg.type) {
      case 'text':
        text = msg.text?.body || null;
        break;

      case 'interactive':
        // Button reply
        if (msg.interactive?.type === 'button_reply') {
          text = msg.interactive.button_reply.title || msg.interactive.button_reply.id;
          selectedId = msg.interactive.button_reply.id;
          isInteractive = true;
        }
        // List reply
        else if (msg.interactive?.type === 'list_reply') {
          text = msg.interactive.list_reply.title || msg.interactive.list_reply.id;
          selectedId = msg.interactive.list_reply.id;
          isInteractive = true;
        }
        break;

      case 'button':
        // Quick reply button (template button responses)
        text = msg.button?.text || null;
        selectedId = msg.button?.payload || null;
        isInteractive = !!selectedId;
        break;

      default:
        // Non-text messages (image, audio, video, document, location, sticker, contacts):
        // Pass through with type metadata for FIX-02 handling
        break;
    }

    const messageType = msg.type || 'unknown';

    // For text messages, require non-empty text. For non-text, text will be null.
    if (messageType === 'text' && (!text || text.trim().length === 0)) {
      return null;
    }

    // Extract push name from contacts array or kapso metadata
    const pushName = msg.contacts?.[0]?.profile?.name
      || msg.kapso?.contact_name
      || 'Customer';

    // Build internal format matching parseWebhookPayload output
    const remoteJid = `${from.replace(/^\+/, '')}@s.whatsapp.net`;

    return {
      remoteJid,
      messageId: msg.id || `kapso_${Date.now()}`,
      text: text ? text.trim() : null,
      pushName,
      isInteractive,
      selectedId,
      source, // "staff" or "customer" — extra field for routing
      messageType, // "text"|"image"|"audio"|"video"|"document"|"location"|"sticker"|"contacts"
    };
  } catch (err) {
    logger.error({ err, payload: kapsoPayload }, 'Failed to adapt Kapso webhook payload');
    return null;
  }
}

/**
 * Verify Kapso webhook HMAC signature.
 * Uses raw body buffer for accurate HMAC computation.
 *
 * @param {object} req           - Express request with rawBody buffer
 * @param {string} webhookSecret - HMAC secret from Kapso dashboard
 * @returns {boolean}
 */
function verifyKapsoSignature(req, webhookSecret) {
  if (!webhookSecret) {
    // No secret configured — skip verification (dev mode)
    return true;
  }

  const signature = req.headers['x-webhook-signature'];
  if (!signature) {
    logger.warn('Kapso webhook: missing x-webhook-signature header');
    return false;
  }

  const rawBody = req.rawBody;
  if (!rawBody) {
    logger.warn('Kapso webhook: missing rawBody — ensure express.json verify callback is configured');
    return false;
  }

  const hmac = crypto.createHmac('sha256', webhookSecret);
  hmac.update(rawBody);
  const expected = hmac.digest('hex');

  const valid = crypto.timingSafeEqual(
    Buffer.from(signature),
    Buffer.from(expected)
  );

  if (!valid) {
    logger.warn('Kapso webhook: signature verification failed');
  }

  return valid;
}

module.exports = { adaptKapsoWebhook, verifyKapsoSignature };
