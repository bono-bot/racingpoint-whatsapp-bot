const logger = require('../utils/logger');

// Phase 446 dual-read PACT-010: canonical OPENROUTER_KEY first; OPENROUTER_API_KEY deprecated-fallback (Phase 448 absorbs)
const OPENROUTER_API_KEY = process.env.OPENROUTER_KEY || process.env.OPENROUTER_API_KEY;
if (process.env.OPENROUTER_API_KEY && !process.env.OPENROUTER_KEY) {
  console.warn('[deprecation] OPENROUTER_API_KEY env var is Phase 446 deprecated; rename to OPENROUTER_KEY (Phase 448 will hard-cut). PACT-010 mirror.');
}
const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';

// ── PII redaction before sending to external AI ──────────────────────
// Masks Indian phone numbers and email addresses in message content
function redactPII(text) {
  if (!text) return text;
  // Indian phone numbers (10-digit, with optional +91/91 prefix)
  let redacted = text.replace(/(?:\+?91[-\s]?)?[6-9]\d{9}/g, '[PHONE]');
  // Email addresses
  redacted = redacted.replace(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g, '[EMAIL]');
  return redacted;
}

// ── Prompt injection guard: strip known attack patterns from user messages ──
function sanitizeInput(text) {
  if (!text) return text;
  // Strip attempts to override system prompt
  return text
    .replace(/ignore\s*(all\s*)?(previous|prior|above)\s*(instructions?|prompts?|rules?)/gi, '[filtered]')
    .replace(/you\s*are\s*now\s*(a|an|the)\s/gi, '[filtered]')
    .replace(/system\s*prompt\s*[:=]/gi, '[filtered]')
    .replace(/\[SYSTEM\]/gi, '[filtered]')
    .replace(/<\/?system>/gi, '[filtered]');
}

// ── Output guard: ensure AI response doesn't leak internal data ──
function sanitizeOutput(reply) {
  if (!reply) return reply;
  // Strip any leaked system prompt fragments, API keys, internal JIDs
  let cleaned = reply
    .replace(/sk-or-v1-[a-zA-Z0-9]+/g, '[REDACTED]')
    .replace(/OPENROUTER_(API_)?KEY/g, '[REDACTED]')  // Phase 446 PACT-010: redact both legacy + canonical names
    .replace(/\d{10,}@s\.whatsapp\.net/g, '[REDACTED]')
    .replace(/rp-terminal-\d+/g, '[REDACTED]');
  return cleaned;
}

const AI_TIMEOUT_MS = 10000; // 10s timeout for DeepSeek calls
const FALLBACK_REPLY = "I'm taking a moment to process that. Can you try again in a few seconds? Or say *human* to reach our team directly!";

async function chat(systemPrompt, conversationMessages, options = {}) {
  const model = options.model || process.env.AI_MODEL || 'deepseek/deepseek-v3-0324';

  logger.debug({
    model,
    messageCount: conversationMessages.length,
    systemLength: systemPrompt.length,
  }, 'Sending request to OpenRouter');

  const messages = [
    { role: 'system', content: systemPrompt },
    ...conversationMessages.map(msg => ({
      role: msg.role,
      content: sanitizeInput(redactPII(msg.content)),
    })),
  ];

  // Timeout controller for DeepSeek latency spikes
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), AI_TIMEOUT_MS);

  try {
    const response = await fetch(OPENROUTER_URL, {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + OPENROUTER_API_KEY,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'https://racingpoint.cloud',
        'X-Title': 'RacingPoint WhatsApp Bot',
      },
      body: JSON.stringify({
        model,
        messages,
        max_tokens: 1024,
        temperature: 0.7,
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      const errText = await response.text();
      logger.warn({ model, status: response.status }, 'OpenRouter error — using fallback');
      return FALLBACK_REPLY;
    }

    const data = await response.json();
    const reply = data.choices?.[0]?.message?.content;

    if (!reply) {
      logger.warn({ model }, 'Empty OpenRouter response — using fallback');
      return FALLBACK_REPLY;
    }

    logger.debug({
      model,
      replyLength: reply.length,
      promptTokens: data.usage?.prompt_tokens || 0,
      completionTokens: data.usage?.completion_tokens || 0,
    }, 'OpenRouter response received');

    return sanitizeOutput(reply);
  } catch (err) {
    if (err.name === 'AbortError') {
      logger.warn({ model, timeoutMs: AI_TIMEOUT_MS }, 'OpenRouter request timed out — using fallback');
    } else {
      logger.error({ err: err.message, model }, 'OpenRouter request failed — using fallback');
    }
    return FALLBACK_REPLY;
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { chat };
