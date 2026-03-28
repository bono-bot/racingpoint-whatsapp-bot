const { WhatsAppClient } = require('@kapso/whatsapp-cloud-api');
const logger = require('../utils/logger');

/**
 * KapsoClient - Adapter wrapping @kapso/whatsapp-cloud-api SDK.
 * Exposes the same method signatures used by evolutionService.js so the
 * integration layer can swap transports via USE_KAPSO flag.
 *
 * Each instance is bound to a single phoneNumberId (staff or customer).
 */
class KapsoClient {
  /**
   * @param {object} opts
   * @param {string} opts.apiKey       - Kapso API key
   * @param {string} opts.phoneNumberId - WhatsApp phone number ID from Meta
   * @param {string} opts.instanceName  - Human label (for logging only)
   */
  constructor({ apiKey, phoneNumberId, instanceName }) {
    if (!apiKey) throw new Error('KapsoClient: apiKey is required');
    if (!phoneNumberId) throw new Error('KapsoClient: phoneNumberId is required');

    this.phoneNumberId = phoneNumberId;
    this.instanceName = instanceName || 'kapso';
    this.sdk = new WhatsAppClient({ kapsoApiKey: apiKey });
  }

  /**
   * Send a plain text message.
   * @param {string} number - Recipient phone (digits, e.g. "919059833001")
   * @param {string} text   - Message body
   */
  async sendText(number, text) {
    try {
      const result = await this.sdk.messages.textSender.send({
        phoneNumberId: this.phoneNumberId,
        to: this._normalizeNumber(number),
        body: text,
      });
      logger.debug({ number, instance: this.instanceName }, 'Kapso: text message sent');
      return result;
    } catch (err) {
      logger.error({ err: err.message, number, instance: this.instanceName }, 'Kapso: sendText failed');
      return null;
    }
  }

  /**
   * Send interactive buttons (max 3 per Meta rules).
   * Falls back to numbered text menu if >3 buttons or SDK error.
   *
   * @param {string} number  - Recipient phone
   * @param {string} title   - Message body text (used as bodyText)
   * @param {Array<{id?: string, text: string}>} buttons - Button options
   */
  async sendButtons(number, title, buttons) {
    // Native interactive buttons for <= 3
    if (buttons.length <= 3) {
      try {
        const result = await this.sdk.messages.sendButtons({
          phoneNumberId: this.phoneNumberId,
          to: this._normalizeNumber(number),
          bodyText: title,
          buttons: buttons.map((b, i) => ({
            id: b.id || `btn_${i}`,
            title: b.text.substring(0, 20), // Meta limit: 20 chars per button title
          })),
        });
        logger.debug({ number, buttonCount: buttons.length, instance: this.instanceName }, 'Kapso: interactive buttons sent');
        return result;
      } catch (err) {
        logger.warn({ err: err.message, number, instance: this.instanceName }, 'Kapso: sendButtons failed, falling back to text');
      }
    }

    // Text fallback for >3 buttons or SDK error
    const lines = [];
    if (title) lines.push(`*${title}*`);
    lines.push('');
    buttons.forEach((b, i) => {
      lines.push(`${i + 1}. ${b.text}`);
    });
    lines.push('');
    lines.push('Reply with the number of your choice.');
    return this.sendText(number, lines.join('\n'));
  }

  /**
   * Send an interactive list message.
   * Falls back to numbered text menu on SDK error.
   *
   * @param {string} number   - Recipient phone
   * @param {string} title    - List body text
   * @param {Array<{title: string, rows: Array<{rowId: string, title: string, description?: string}>}>} sections
   */
  async sendList(number, title, sections) {
    try {
      const result = await this.sdk.messages.sendList({
        phoneNumberId: this.phoneNumberId,
        to: this._normalizeNumber(number),
        bodyText: title,
        buttonText: 'Select',
        sections: sections.map(s => ({
          title: s.title || undefined,
          rows: s.rows.map(r => ({
            id: r.rowId,
            title: r.title.substring(0, 24), // Meta limit: 24 chars per row title
            description: r.description ? r.description.substring(0, 72) : undefined, // Meta limit: 72 chars
          })),
        })),
      });
      logger.debug({ number, instance: this.instanceName }, 'Kapso: list message sent');
      return result;
    } catch (err) {
      logger.warn({ err: err.message, number, instance: this.instanceName }, 'Kapso: sendList failed, falling back to text');
    }

    // Text fallback
    const lines = [];
    if (title) lines.push(`*${title}*`);
    lines.push('');
    let counter = 1;
    for (const section of sections) {
      if (section.title) lines.push(`*${section.title}*`);
      for (const row of section.rows) {
        lines.push(`${counter}. ${row.title}${row.description ? ` - ${row.description}` : ''}`);
        counter++;
      }
    }
    lines.push('');
    lines.push('Reply with the number of your choice.');
    return this.sendText(number, lines.join('\n'));
  }

  /**
   * Send a menu as plain text (menus are pre-rendered by existing code).
   * @param {string} number   - Recipient phone
   * @param {string} menuText - Already-formatted menu text
   */
  async sendMenu(number, menuText) {
    return this.sendText(number, menuText);
  }

  /**
   * Check instance status. Cloud API is always connected if API key is valid.
   * @returns {{ connected: boolean }}
   */
  async getInstanceStatus() {
    return { connected: true };
  }

  /**
   * Send presence/typing indicator.
   * Cloud API does not support typing indicators the same way.
   * No-op with debug log.
   * @param {string} number - Recipient phone
   * @param {string} type   - Presence type ("composing" or "paused")
   */
  async sendPresence(number, type) {
    logger.debug({ number, type, instance: this.instanceName }, 'Kapso: sendPresence no-op (Cloud API)');
  }

  /**
   * Normalize phone number: strip @s.whatsapp.net suffix if present,
   * strip leading '+'. Cloud API expects plain digits.
   * @param {string} number
   * @returns {string}
   */
  _normalizeNumber(number) {
    return number
      .replace('@s.whatsapp.net', '')
      .replace(/^\+/, '');
  }
}

module.exports = { KapsoClient };
