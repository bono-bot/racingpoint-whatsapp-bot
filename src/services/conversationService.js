const { getDb } = require('../db/database');
const logger = require('../utils/logger');

const MAX_HISTORY = 20;

function getHistory(remoteJid) {
  const db = getDb();
  const rows = db.prepare(`
    SELECT role, content, created_at FROM messages
    WHERE remote_jid = ?
    ORDER BY created_at DESC
    LIMIT ?
  `).all(remoteJid, MAX_HISTORY);

  // Reverse to get chronological order
  return rows.reverse();
}

function saveMessage(remoteJid, role, content) {
  const db = getDb();
  db.prepare(`
    INSERT INTO messages (remote_jid, role, content)
    VALUES (?, ?, ?)
  `).run(remoteJid, role, content);
}

function clearHistory(remoteJid) {
  const db = getDb();
  const result = db.prepare(`
    DELETE FROM messages WHERE remote_jid = ?
  `).run(remoteJid);
  logger.info({ remoteJid, deleted: result.changes }, 'Conversation history cleared');
}

module.exports = { getHistory, saveMessage, clearHistory };
