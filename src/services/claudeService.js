const Anthropic = require('@anthropic-ai/sdk');
const config = require('../config');
const logger = require('../utils/logger');

const client = new Anthropic({ apiKey: config.claude.apiKey });

async function chat(messages, options = {}) {
  // Extract system prompt (first message with role 'system')
  let systemPrompt = '';
  const conversationMessages = [];

  for (const msg of messages) {
    if (msg.role === 'system') {
      systemPrompt += (systemPrompt ? '\n\n' : '') + msg.content;
    } else {
      conversationMessages.push({ role: msg.role, content: msg.content });
    }
  }

  // Sanitize: Claude requires messages to alternate user/assistant and start with 'user'
  const sanitized = [];
  for (const msg of conversationMessages) {
    const last = sanitized[sanitized.length - 1];
    if (last && last.role === msg.role) {
      last.content += '\n\n' + msg.content;
    } else {
      sanitized.push({ ...msg });
    }
  }

  if (sanitized.length > 0 && sanitized[0].role === 'assistant') {
    sanitized.unshift({ role: 'user', content: '(conversation continued)' });
  }

  // Claude API requires conversation to end with a user message
  if (sanitized.length > 0 && sanitized[sanitized.length - 1].role === 'assistant') {
    sanitized.push({ role: 'user', content: '(please continue)' });
  }

  const model = options.model || config.claude.customerModel;

  logger.debug(
    { model, messageCount: sanitized.length, hasSystem: !!systemPrompt },
    'Sending request to Claude'
  );

  const response = await client.messages.create({
    model,
    max_tokens: 1024,
    system: systemPrompt || undefined,
    messages: sanitized,
  });

  const reply = response.content[0]?.text?.trim();

  if (!reply) {
    throw new Error('Empty response from Claude');
  }

  logger.debug(
    {
      model: response.model,
      inputTokens: response.usage?.input_tokens,
      outputTokens: response.usage?.output_tokens,
      stopReason: response.stop_reason,
    },
    'Claude response received'
  );

  return reply;
}

module.exports = { chat };
