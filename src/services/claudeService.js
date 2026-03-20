const Anthropic = require('@anthropic-ai/sdk');
const logger = require('../utils/logger');

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

async function chat(systemPrompt, conversationMessages, options = {}) {
  const model = options.model || process.env.CLAUDE_MODEL_CUSTOMER || 'claude-haiku-4-5-20251001';

  logger.debug({
    model,
    messageCount: conversationMessages.length,
    systemLength: systemPrompt.length,
  }, 'Sending request to Claude SDK');

  const response = await client.messages.create({
    model,
    max_tokens: 1024,
    system: [{
      type: 'text',
      text: systemPrompt,
      cache_control: { type: 'ephemeral' },
    }],
    messages: conversationMessages.map(msg => ({
      role: msg.role,
      content: msg.content,
    })),
  });

  const reply = response.content[0].text;

  if (!reply) {
    throw new Error('Empty response from Claude SDK');
  }

  logger.debug({
    model,
    replyLength: reply.length,
    inputTokens: response.usage.input_tokens,
    outputTokens: response.usage.output_tokens,
    cacheCreation: response.usage.cache_creation_input_tokens || 0,
    cacheRead: response.usage.cache_read_input_tokens || 0,
  }, 'Claude SDK response received');

  return reply;
}

module.exports = { chat };
