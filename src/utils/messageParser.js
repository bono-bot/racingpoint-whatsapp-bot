const logger = require('./logger');

/**
 * Detect message type from Evolution API message object.
 * @param {object} message - Evolution API message object
 * @returns {string} Message type identifier
 */
function detectMessageType(message) {
  if (message.conversation || message.extendedTextMessage) return 'text';
  if (message.imageMessage) return 'image';
  if (message.audioMessage) return 'audio';
  if (message.videoMessage) return 'video';
  if (message.documentMessage) return 'document';
  if (message.locationMessage) return 'location';
  if (message.stickerMessage) return 'sticker';
  if (message.contactMessage || message.contactsArrayMessage) return 'contacts';
  if (message.buttonsResponseMessage) return 'interactive';
  if (message.listResponseMessage) return 'interactive';
  if (message.templateButtonReplyMessage) return 'interactive';
  return 'unknown';
}

function parseWebhookPayload(body) {
  try {
    // Evolution API v2 sends messages in data array
    const data = body.data;
    if (!data) return null;

    const key = data.key;
    const message = data.message;

    if (!key || !message) return null;

    // Ignore messages sent by us
    if (key.fromMe) return null;

    // Ignore status broadcasts
    if (key.remoteJid === 'status@broadcast') return null;

    // Only handle individual chats (not groups)
    if (key.remoteJid.endsWith('@g.us')) return null;

    // Detect message type
    const messageType = detectMessageType(message);

    // Extract text content (including interactive message responses)
    let text = message.conversation
      || message.extendedTextMessage?.text
      || message.buttonsResponseMessage?.selectedDisplayText
      || message.listResponseMessage?.singleSelectReply?.selectedRowId
      || message.templateButtonReplyMessage?.selectedDisplayText
      || null;

    // For text messages, require non-empty text. For non-text, text will be null.
    if (messageType === 'text' && (!text || text.trim().length === 0)) {
      return null;
    }

    return {
      remoteJid: key.remoteJid,
      messageId: key.id,
      text: text ? text.trim() : null,
      pushName: data.pushName || 'Customer',
      isInteractive: !!(
        message.buttonsResponseMessage ||
        message.listResponseMessage ||
        message.templateButtonReplyMessage
      ),
      selectedId: message.buttonsResponseMessage?.selectedButtonId
        || message.listResponseMessage?.singleSelectReply?.selectedRowId
        || null,
      messageType, // "text"|"image"|"audio"|"video"|"document"|"location"|"sticker"|"contacts"
    };
  } catch (err) {
    logger.error({ err, body }, 'Failed to parse webhook payload');
    return null;
  }
}

module.exports = { parseWebhookPayload };
