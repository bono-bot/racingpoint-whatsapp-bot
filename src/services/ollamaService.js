const config = require('../config');
const logger = require('../utils/logger');

async function chat(messages) {
  const url = `${config.ollama.url}/api/chat`;

  const payload = {
    model: config.ollama.model,
    messages,
    stream: false,
    options: {
      temperature: 0.7,
      num_predict: 512,
    },
  };

  logger.debug({ model: config.ollama.model, messageCount: messages.length }, 'Sending request to Ollama');

  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(120000), // 2 minute timeout
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Ollama API error ${response.status}: ${text}`);
  }

  const data = await response.json();
  const reply = data.message?.content?.trim();

  if (!reply) {
    throw new Error('Empty response from Ollama');
  }

  logger.debug({ totalDuration: data.total_duration }, 'Ollama response received');
  return reply;
}

module.exports = { chat };
