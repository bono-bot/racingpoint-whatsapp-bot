const { getDb } = require('../db/database');
const logger = require('../utils/logger');

// --- Profile CRUD (INTEL-04) ---

function getProfile(remoteJid) {
  const db = getDb();
  const row = db.prepare('SELECT * FROM customer_profiles WHERE remote_jid = ?').get(remoteJid);
  if (!row) return null;
  // Parse JSON fields
  return {
    ...row,
    intent_history: JSON.parse(row.intent_history || '[]'),
    preferences: JSON.parse(row.preferences || '{}'),
    tags: JSON.parse(row.tags || '[]'),
  };
}

function createProfile(remoteJid, pushName) {
  const db = getDb();
  const phone = remoteJid.replace('@s.whatsapp.net', '');
  db.prepare(
    'INSERT OR IGNORE INTO customer_profiles (remote_jid, phone, push_name) VALUES (?, ?, ?)'
  ).run(remoteJid, phone, pushName || null);
  return getProfile(remoteJid);
}

function getOrCreateProfile(remoteJid, pushName) {
  let profile = getProfile(remoteJid);
  if (!profile) {
    profile = createProfile(remoteJid, pushName);
  }
  return profile;
}

// --- Profile update after each interaction ---

function updateProfile(remoteJid, updates) {
  const db = getDb();
  const profile = getProfile(remoteJid);
  if (!profile) return null;

  const sets = [];
  const params = [];

  // Standard fields
  if (updates.lead_score !== undefined) { sets.push('lead_score = ?'); params.push(updates.lead_score); }
  if (updates.lead_temperature !== undefined) { sets.push('lead_temperature = ?'); params.push(updates.lead_temperature); }
  if (updates.funnel_stage !== undefined) { sets.push('funnel_stage = ?'); params.push(updates.funnel_stage); }
  if (updates.push_name !== undefined) { sets.push('push_name = ?'); params.push(updates.push_name); }
  if (updates.visit_count !== undefined) { sets.push('visit_count = ?'); params.push(updates.visit_count); }
  if (updates.total_sessions !== undefined) { sets.push('total_sessions = ?'); params.push(updates.total_sessions); }
  if (updates.last_visit !== undefined) { sets.push('last_visit = ?'); params.push(updates.last_visit); }

  // JSON fields -- merge, don't replace
  if (updates.preferences) {
    const merged = { ...profile.preferences, ...updates.preferences };
    sets.push('preferences = ?');
    params.push(JSON.stringify(merged));
  }
  if (updates.intent) {
    // Append to intent_history, keep last 10
    const history = [...profile.intent_history, updates.intent].slice(-10);
    sets.push('intent_history = ?');
    params.push(JSON.stringify(history));
  }
  if (updates.tag) {
    // Add tag if not already present
    const tags = profile.tags.includes(updates.tag) ? profile.tags : [...profile.tags, updates.tag];
    sets.push('tags = ?');
    params.push(JSON.stringify(tags));
  }

  // Always update interaction timestamp and message count
  sets.push("last_interaction = datetime('now')");
  sets.push('total_messages = total_messages + 1');
  sets.push("updated_at = datetime('now')");

  if (sets.length === 0) return profile;

  params.push(remoteJid);
  db.prepare(`UPDATE customer_profiles SET ${sets.join(', ')} WHERE remote_jid = ?`).run(...params);

  return getProfile(remoteJid);
}

// --- Build context block for AI prompt enrichment (INTEL-04 + INTEL-05 guidance) ---

function buildIntelligenceContext(profile) {
  if (!profile) return '';

  const parts = [];
  parts.push('[Customer Profile]');
  if (profile.push_name) parts.push(`Name: ${profile.push_name}`);
  parts.push(`Lead: ${profile.lead_temperature} (score: ${profile.lead_score}/100)`);
  parts.push(`Funnel: ${profile.funnel_stage}`);
  parts.push(`Messages: ${profile.total_messages}, Visits: ${profile.visit_count}`);

  if (profile.total_sessions > 0) {
    parts.push(`Sessions: ${profile.total_sessions}`);
  }

  if (profile.preferences && Object.keys(profile.preferences).length > 0) {
    const prefs = profile.preferences;
    if (prefs.preferredGame) parts.push(`Preferred game: ${prefs.preferredGame}`);
    if (prefs.groupSize) parts.push(`Typical group: ${prefs.groupSize} people`);
  }

  if (profile.tags.length > 0) {
    parts.push(`Tags: ${profile.tags.join(', ')}`);
  }

  // Behavioral guidance based on temperature
  if (profile.lead_temperature === 'hot') {
    parts.push('[GUIDANCE: Customer is HOT lead -- ready to book. Be direct, offer booking flow immediately. Do not over-explain.]');
  } else if (profile.lead_temperature === 'warm') {
    parts.push('[GUIDANCE: Customer is WARM lead -- interested but needs nurturing. Answer questions thoroughly, share social proof, suggest booking when natural.]');
  } else {
    parts.push('[GUIDANCE: Customer is COLD lead -- just browsing. Be informative, share exciting details, mention free trial, do not push booking.]');
  }

  return parts.join('\n');
}

/**
 * DPDP Right to Erasure — delete all customer data for a given JID.
 * Called when user sends STOP/DELETE/opt-out.
 */
function eraseCustomerData(remoteJid) {
  const db = getDb();
  const tables = [
    { table: 'customer_profiles', column: 'remote_jid' },
    { table: 'customer_funnel', column: 'remote_jid' },
    { table: 'customer_nudges', column: 'remote_jid' },
    { table: 'customer_optins', column: 'remote_jid' },
    { table: 'messages', column: 'remote_jid' },
  ];
  let deletedRows = 0;
  for (const { table, column } of tables) {
    try {
      const result = db.prepare(`DELETE FROM ${table} WHERE ${column} = ?`).run(remoteJid);
      deletedRows += result.changes;
    } catch (err) {
      logger.warn({ err: err.message, table, remoteJid }, 'DPDP erasure: table skip');
    }
  }
  logger.info({ remoteJid, deletedRows }, 'DPDP: customer data erased');
  return deletedRows;
}

module.exports = {
  getProfile,
  createProfile,
  getOrCreateProfile,
  updateProfile,
  buildIntelligenceContext,
  eraseCustomerData,
};
