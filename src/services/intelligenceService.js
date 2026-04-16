const { getDb } = require('../db/database');
const logger = require('../utils/logger');

// --- Intent Classification (INTEL-02) ---
// Classify intent BEFORE any AI call from raw message text
// Returns: "customer" | "partnership" | "job" | "spam"

const INTENT_PATTERNS = {
  partnership: [
    /\b(partner|partnership|collaborate|collab|sponsor|sponsorship|business\s*proposal|b2b|franchise|invest)\b/i,
    /\b(brand|marketing|promotion|co-brand|affiliate)\b/i,
  ],
  job: [
    /\b(job|hiring|vacancy|career|position|resume|cv|apply|application|work with you|looking for work|openings?)\b/i,
    /\b(salary|pay|intern|internship)\b/i,
  ],
  spam: [
    /\b(earn\s*money|make\s*money|work\s*from\s*home|mlm|forex|crypto\s*invest|free\s*money|lottery|winner)\b/i,
    /\b(click\s*here|bit\.ly|tinyurl|t\.co)\b/i,
    /(.)\1{5,}/,  // repeated characters (aaaaaaa)
  ],
};

function classifyIntent(text) {
  if (!text) return 'customer';
  for (const [intent, patterns] of Object.entries(INTENT_PATTERNS)) {
    if (patterns.some(p => p.test(text))) return intent;
  }
  return 'customer'; // default: treat as potential customer
}

// --- Lead Temperature Scoring (INTEL-01) ---
// Score 0-100 based on behavioral signals. Temperature: hot (70+), warm (30-69), cold (0-29)

const SCORING_SIGNALS = {
  // Positive signals (increase score)
  booking_intent:     { pattern: /\b(book|reserve|want to (race|play|drive)|sign me up|when can i|how do i book)\b/i, points: 25 },
  price_inquiry:      { pattern: /\b(how much|price|cost|rate|charges?|fees?|per hour|pricing)\b/i, points: 15 },
  time_inquiry:       { pattern: /\b(when|what time|today|tomorrow|this weekend|slot|available)\b/i, points: 10 },
  group_intent:       { pattern: /\b(friends|group|birthday|party|team|corporate|we)\b/i, points: 15 },
  return_visit:       { pattern: /\b(again|come back|last time|before|regular|usual)\b/i, points: 20 },
  experience_mention: { pattern: /\b(tried|drove|played|raced|session was|last visit)\b/i, points: 15 },
  location_interest:  { pattern: /\b(where|location|address|directions|how to reach|which area)\b/i, points: 10 },
  urgency:            { pattern: /\b(now|today|tonight|right now|asap|hurry)\b/i, points: 20 },
  // Negative signals (decrease score)
  just_browsing:      { pattern: /\b(just (asking|checking|looking|curious)|maybe later|not sure)\b/i, points: -10 },
};

function scoreLeadTemperature(text, existingProfile) {
  let score = existingProfile ? existingProfile.lead_score : 0;

  // Signal-based scoring from current message
  for (const [, signal] of Object.entries(SCORING_SIGNALS)) {
    if (signal.pattern.test(text)) {
      score += signal.points;
    }
  }

  // Profile-based boosts
  if (existingProfile) {
    if (existingProfile.visit_count > 0) score += 10;          // returning visitor
    if (existingProfile.total_sessions > 3) score += 10;       // regular
    if (existingProfile.total_messages > 10) score += 5;        // engaged
  }

  // Clamp 0-100
  score = Math.max(0, Math.min(100, score));

  // Temperature
  let temperature;
  if (score >= 70) temperature = 'hot';
  else if (score >= 30) temperature = 'warm';
  else temperature = 'cold';

  return { score, temperature };
}

// --- Funnel Tracking (INTEL-03) ---
// 6 stages: inquiry -> interest -> qualified -> booking_intent -> booked -> visited
// Forward-only progression, every transition logged

const FUNNEL_STAGES = ['inquiry', 'interest', 'qualified', 'booking_intent', 'booked', 'visited'];

function getFunnelStage(remoteJid) {
  const db = getDb();
  const row = db.prepare('SELECT funnel_stage FROM customer_profiles WHERE remote_jid = ?').get(remoteJid);
  return row ? row.funnel_stage : 'inquiry';
}

function updateFunnel(remoteJid, newStage, triggerMessage) {
  const db = getDb();
  const currentStage = getFunnelStage(remoteJid);
  const currentIdx = FUNNEL_STAGES.indexOf(currentStage);
  const newIdx = FUNNEL_STAGES.indexOf(newStage);

  // Only advance forward (never regress)
  if (newIdx <= currentIdx) return currentStage;

  // Log transition
  db.prepare(
    'INSERT INTO customer_funnel (remote_jid, stage, previous_stage, trigger_message) VALUES (?, ?, ?, ?)'
  ).run(remoteJid, newStage, currentStage, (triggerMessage || '').substring(0, 200));

  // Update profile
  db.prepare(
    "UPDATE customer_profiles SET funnel_stage = ?, updated_at = datetime('now') WHERE remote_jid = ?"
  ).run(newStage, remoteJid);

  logger.info({ remoteJid, from: currentStage, to: newStage }, 'Funnel stage advanced');
  return newStage;
}

function getLeadScore(remoteJid) {
  const db = getDb();
  const row = db.prepare('SELECT lead_score, lead_temperature FROM customer_profiles WHERE remote_jid = ?').get(remoteJid);
  return row ? { score: row.lead_score, temperature: row.lead_temperature } : { score: 0, temperature: 'cold' };
}

// --- Funnel auto-detection from message text ---

function detectFunnelAdvance(text, currentStage) {
  if (currentStage === 'inquiry') {
    if (/\b(price|cost|how much|rate|interested|tell me more|what games?)\b/i.test(text)) return 'interest';
  }
  if (['inquiry', 'interest'].includes(currentStage)) {
    if (/\b(how many|group size|which game|what.*experience|first time|been before)\b/i.test(text)) return 'qualified';
  }
  if (['inquiry', 'interest', 'qualified'].includes(currentStage)) {
    if (/\b(book|reserve|want to|sign up|when can|slot|available.*today)\b/i.test(text)) return 'booking_intent';
  }
  return null; // no advance
}

module.exports = {
  classifyIntent,
  scoreLeadTemperature,
  updateFunnel,
  getFunnelStage,
  getLeadScore,
  detectFunnelAdvance,
  FUNNEL_STAGES,
};
