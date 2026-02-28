const logger = require('./logger');

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

    // Extract text content
    const text = message.conversation
      || message.extendedTextMessage?.text
      || null;

    if (!text || text.trim().length === 0) return null;

    return {
      remoteJid: key.remoteJid,
      messageId: key.id,
      text: text.trim(),
      pushName: data.pushName || 'Customer',
    };
  } catch (err) {
    logger.error({ err, body }, 'Failed to parse webhook payload');
    return null;
  }
}

module.exports = { parseWebhookPayload };
