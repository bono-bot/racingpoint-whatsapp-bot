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

module.exports = { sendText, sendPresence };
