// captainPactDispositionService.js
// PART 48 Vector B+C — Captain WhatsApp Q-disposition parser + delivery-ack.
//
// Vector B: ALL Captain inbound gets a delivery-ack so Captain has perception
// confirmation that the message landed (closes Layer-2 perception latency).
//
// Vector C: When Captain message matches a Q-disposition pattern (e.g.
// "Q1: RATIFY Q2: PERMIT-SIGNATURE-OPENERS Q3: TIGHT-EVERYWHERE"), parse the
// values, persist a pact_dispositions row for downstream queryability, and
// send a richer ack that confirms the parsed values.
//
// Composes-with:
//   - V2-MASTER-STATE §S-75 Captain Q1/Q2/Q3 ratify (PART 48 anchor)
//   - feedback_doorbell_pollmodel_not_pushmodel_gap.md (sibling Layer-1 gap)
//   - /root/.claude/hooks/captain-whatsapp-prompt-scan.js (Vector A — bono-side
//     hook reads Captain msgs; this service is the bot-side complement)
//
// Pattern grammar (intentionally lenient — Captain WhatsApp is human-typed):
//   - Recognizes "Q<N>" or "Q<N>." with optional ":" or "=" or whitespace separator
//   - Value runs until next "Q<N>" marker or end of message
//   - Whitespace and newlines treated as separators
//   - Case-insensitive on the Q-prefix; values preserved as-typed
//
// Examples that parse:
//   "Q1: RATIFY Q2:PERMIT-SIGNATURE-OPENERS Q3:TIGHT-EVERYWHERE"
//   "Q1 RATIFY  Q2 PERMIT-SIGNATURE-OPENERS"
//   "Q1=RATIFY\nQ2 = PERMIT-SIGNATURE-OPENERS\nQ3 = TIGHT-EVERYWHERE"
//   "q1 ratify, q2 hold-no-hype, q3 discuss"
//
// Examples that DON'T parse (intentional — return null):
//   "Updates"  (no Q-prefix)
//   "Approved" (no Q-prefix)
//   "Q1"       (no value)

const { getDb } = require('../db/database');

// Match "Q<digits>" optionally preceded by whitespace, followed by optional
// separator (":" or "=") and arbitrary whitespace. Captures Q-number + value
// up to the next Q-marker or end-of-string.
const Q_PATTERN_GLOBAL = /\bQ(\d+)\s*[:=]?\s*([^\n]*?)(?=\s*\bQ\d+\s*[:=]?|$)/gis;

/**
 * Parse Q-disposition pattern from Captain message text.
 *
 * @param {string} text - The Captain inbound message body.
 * @returns {Array<{q: number, value: string}> | null} Array of parsed
 *   dispositions, or null if no Q-pattern detected.
 */
function parseQDispositions(text) {
  if (!text || typeof text !== 'string') return null;
  const matches = [];
  // Use matchAll to avoid regex .exec stateful pitfalls
  for (const m of text.matchAll(Q_PATTERN_GLOBAL)) {
    const qNum = parseInt(m[1], 10);
    const value = (m[2] || '').trim();
    if (!value) continue;
    if (!Number.isFinite(qNum)) continue;
    matches.push({ q: qNum, value });
  }
  return matches.length > 0 ? matches : null;
}

/**
 * Persist parsed dispositions to pact_dispositions table for queryability.
 * Schema migration is in db/database.js initSchema(); this function assumes
 * the table exists.
 *
 * @param {string} remoteJid - Captain JID.
 * @param {string} sourceMessageContent - Verbatim Captain message body
 *   (for forensic traceability — schema preserves original input).
 * @param {Array<{q: number, value: string}>} dispositions - Parsed values.
 * @returns {number} Number of rows persisted.
 */
function persistDispositions(remoteJid, sourceMessageContent, dispositions) {
  if (!dispositions || dispositions.length === 0) return 0;
  const db = getDb();
  const stmt = db.prepare(`
    INSERT INTO pact_dispositions (remote_jid, source_content, q_number, q_value, parsed_at)
    VALUES (?, ?, ?, ?, datetime('now'))
  `);
  const tx = db.transaction((rows) => {
    for (const r of rows) stmt.run(remoteJid, sourceMessageContent, r.q, r.value);
  });
  tx(dispositions);
  return dispositions.length;
}

/**
 * Format a delivery-ack for Captain.
 *
 * @param {Array<{q: number, value: string}> | null} dispositions
 * @returns {string} Ack text suitable for Evolution sendText.
 */
function formatAck(dispositions) {
  if (dispositions && dispositions.length > 0) {
    // Vector C — richer ack with parsed values
    const parts = dispositions
      .sort((a, b) => a.q - b.q)
      .map(d => `Q${d.q}=${d.value}`)
      .join(' · ');
    return (
      `✓ Got it: ${parts}\n` +
      `Persisted to pact_dispositions for bono pickup. ` +
      `Locked in V2-MASTER-STATE on next bono session.`
    );
  }
  // Vector B — simple delivery-ack for non-Q-pattern Captain msgs
  return (
    `✓ Got it. Bono will pick this up on the next session start. ` +
    `(Auto-ack from racingpoint-bot — no AI processing yet.)`
  );
}

module.exports = {
  parseQDispositions,
  persistDispositions,
  formatAck,
};
