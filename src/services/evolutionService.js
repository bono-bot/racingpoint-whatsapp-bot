const config = require('../config');
const logger = require('../utils/logger');

const instanceEncoded = encodeURIComponent(config.evolution.instance);

async function sendText(remoteJid, text) {
  const url = `${config.evolution.url}/message/sendText/${instanceEncoded}`;

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'apikey': config.evolution.apiKey,
    },
    body: JSON.stringify({
      number: remoteJid,
      text,
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Evolution API sendText error ${response.status}: ${body}`);
  }

  const data = await response.json();
  logger.debug({ remoteJid }, 'Message sent via Evolution API');
  return data;
}

async function sendPresence(remoteJid, presence) {
  const url = `${config.evolution.url}/chat/updatePresence/${instanceEncoded}`;

  try {
    await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': config.evolution.apiKey,
      },
      body: JSON.stringify({
        number: remoteJid,
        presence, // "composing" or "paused"
      }),
    });
  } catch (err) {
    // Non-critical, just log
    logger.warn({ err, remoteJid, presence }, 'Failed to send presence');
  }
}

/**
 * Send interactive message with automatic text fallback.
 * Tries Evolution API sendButtons first. If it fails or the API returns
 * a non-200 status, falls back to numbered text options.
 *
 * @param {string} remoteJid - WhatsApp recipient JID
 * @param {object} options - Message options
 * @param {string} options.title - Message title (bold header)
 * @param {string} options.description - Message body text
 * @param {string} [options.footer] - Optional footer text
 * @param {Array<{text: string, id?: string}>} options.buttons - Button options (max 3 for buttons, any count for text fallback)
 */
async function sendInteractive(remoteJid, options) {
  // Try interactive buttons first (may not work on Evolution API v2.3.7)
  if (options.buttons.length <= 3) {
    try {
      const url = `${config.evolution.url}/message/sendButtons/${instanceEncoded}`;
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'apikey': config.evolution.apiKey,
        },
        body: JSON.stringify({
          number: remoteJid,
          title: options.title || '',
          description: options.description,
          footer: options.footer || '',
          buttons: options.buttons.map((b, i) => ({
            type: 'reply',
            displayText: b.text,
            id: b.id || `btn_${i}`,
          })),
        }),
      });
      if (res.ok) {
        logger.debug({ remoteJid, buttonCount: options.buttons.length }, 'Interactive buttons sent');
        return;
      }
      logger.warn({ remoteJid, status: res.status }, 'sendButtons failed, falling back to text');
    } catch (err) {
      logger.warn({ err: err.message, remoteJid }, 'sendButtons error, falling back to text');
    }
  }

  // Text fallback: numbered options
  const lines = [];
  if (options.title) lines.push(`*${options.title}*`);
  if (options.description) lines.push(options.description);
  lines.push('');
  options.buttons.forEach((b, i) => {
    lines.push(`${i + 1}. ${b.text}`);
  });
  lines.push('');
  lines.push('Reply with the number of your choice.');
  if (options.footer) lines.push(`\n_${options.footer}_`);

  await sendText(remoteJid, lines.join('\n'));
}

/**
 * Send a list message with automatic text fallback.
 * Tries Evolution API sendList first, falls back to numbered text.
 *
 * @param {string} remoteJid - WhatsApp recipient JID
 * @param {object} options - List options
 * @param {string} options.title - List title
 * @param {string} options.description - Description text
 * @param {string} options.buttonText - Button label to open list
 * @param {Array<{title: string, rows: Array<{title: string, description?: string, rowId: string}>}>} options.sections
 */
async function sendList(remoteJid, options) {
  // Try Evolution API sendList
  try {
    const url = `${config.evolution.url}/message/sendList/${instanceEncoded}`;
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': config.evolution.apiKey,
      },
      body: JSON.stringify({
        number: remoteJid,
        title: options.title,
        description: options.description,
        buttonText: options.buttonText || 'Select',
        footerText: options.footer || '',
        sections: options.sections,
      }),
    });
    if (res.ok) {
      logger.debug({ remoteJid }, 'List message sent');
      return;
    }
    logger.warn({ remoteJid, status: res.status }, 'sendList failed, falling back to text');
  } catch (err) {
    logger.warn({ err: err.message, remoteJid }, 'sendList error, falling back to text');
  }

  // Text fallback
  const lines = [];
  if (options.title) lines.push(`*${options.title}*`);
  if (options.description) lines.push(options.description);
  lines.push('');
  let counter = 1;
  for (const section of options.sections) {
    if (section.title) lines.push(`*${section.title}*`);
    for (const row of section.rows) {
      lines.push(`${counter}. ${row.title}${row.description ? ` — ${row.description}` : ''}`);
      counter++;
    }
  }
  lines.push('');
  lines.push('Reply with the number of your choice.');

  await sendText(remoteJid, lines.join('\n'));
}

module.exports = { sendText, sendPresence, sendInteractive, sendList };
