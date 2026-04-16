const fs = require('fs');
const path = require('path');
const logger = require('../utils/logger');

const BLOCKLIST_PATH = path.join(__dirname, '../../data/blocklist.json');
const SPAM_SCORES_PATH = path.join(__dirname, '../../data/spam_scores.json');

// Ensure data directory exists
const dataDir = path.dirname(BLOCKLIST_PATH);
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

// Load blocklist from disk
let blocklist = {};
try {
  if (fs.existsSync(BLOCKLIST_PATH)) {
    blocklist = JSON.parse(fs.readFileSync(BLOCKLIST_PATH, 'utf8'));
  }
} catch (e) {
  logger.warn('Failed to load blocklist, starting fresh');
}

// Spam score tracker: accumulates per user across messages
let spamScores = {};
try {
  if (fs.existsSync(SPAM_SCORES_PATH)) {
    spamScores = JSON.parse(fs.readFileSync(SPAM_SCORES_PATH, 'utf8'));
  }
} catch (e) { /* fresh start */ }

function saveBlocklist() {
  fs.writeFileSync(BLOCKLIST_PATH, JSON.stringify(blocklist, null, 2));
}

function saveSpamScores() {
  fs.writeFileSync(SPAM_SCORES_PATH, JSON.stringify(spamScores, null, 2));
}

// --- Blocklist ---

function isBlocked(remoteJid) {
  return !!blocklist[remoteJid];
}

function blockUser(remoteJid, reason) {
  blocklist[remoteJid] = {
    reason,
    blocked_at: new Date().toISOString(),
  };
  saveBlocklist();
  // Clear spam score
  delete spamScores[remoteJid];
  saveSpamScores();
  logger.warn({ remoteJid, reason }, 'User BLOCKED');
}

function unblockUser(remoteJid) {
  delete blocklist[remoteJid];
  saveBlocklist();
  delete spamScores[remoteJid];
  saveSpamScores();
  logger.info({ remoteJid }, 'User UNBLOCKED');
}

function getBlocklist() {
  return { ...blocklist };
}

// --- Spam Detection ---

// Patterns that indicate zero purchase intent / inappropriate messages
const SPAM_PATTERNS = [
  // Inappropriate / sexual
  /ladki|ladkiy|girlfriend|gf\b|bf\b|dating|sex|sexy|hot\s*girl|call\s*girl/i,
  // Pure trolling / nonsense repetition
  /^(ha+|ji+|ok+|hmm+|yrr+|bhai+|kr\s*denge|batao|helo+|hi+)\s*$/i,
  // Completely off-topic location spam (not asking about visiting)
  /^(raipur|mumbai|delhi|pune|chennai|bangalore|kolkata|jaipur|lucknow|patna|bhopal|indore)\s*(ka|ki|ke|se|me|hai)?\s*$/i,
  // Abusive language (Hindi)
  /madarchod|bhenchod|chutiya|gaand|lund|bhosdike|mc\b|bc\b/i,
];

// Messages that are just filler / zero-content (low-effort spam indicators)
const FILLER_PATTERNS = [
  /^(haa?|ji|ok|hmm|accha|theek|sahi|kr|krdo|batao|yrr|bro|bhai)\s*$/i,
  /^.{1,3}$/,  // 1-3 character messages
];

const SPAM_THRESHOLD = 5;       // Score to auto-block
const FILLER_SCORE = 1;         // Per filler message
const SPAM_PATTERN_SCORE = 3;   // Per spam pattern hit
const DECAY_MS = 30 * 60 * 1000; // 30 min decay window

function analyzeMessage(remoteJid, text) {
  const now = Date.now();

  if (!spamScores[remoteJid]) {
    spamScores[remoteJid] = { score: 0, lastMessage: now, messageCount: 0, fillerCount: 0 };
  }

  const entry = spamScores[remoteJid];

  // Decay score over time
  const elapsed = now - entry.lastMessage;
  if (elapsed > DECAY_MS) {
    entry.score = Math.max(0, entry.score - 2);
    entry.fillerCount = 0;
  }

  entry.lastMessage = now;
  entry.messageCount++;

  // Check hard spam patterns
  for (const pattern of SPAM_PATTERNS) {
    if (pattern.test(text)) {
      entry.score += SPAM_PATTERN_SCORE;
      logger.info({ remoteJid, pattern: pattern.toString(), score: entry.score }, 'Spam pattern detected');
      break;
    }
  }

  // Check filler messages
  for (const pattern of FILLER_PATTERNS) {
    if (pattern.test(text)) {
      entry.fillerCount++;
      entry.score += FILLER_SCORE;
      break;
    }
  }

  // High filler ratio = spam (e.g., 5+ filler messages out of 7 total)
  if (entry.messageCount >= 6 && entry.fillerCount / entry.messageCount > 0.6) {
    entry.score += 2;
  }

  saveSpamScores();

  return {
    score: entry.score,
    shouldBlock: entry.score >= SPAM_THRESHOLD,
    isSpamPattern: SPAM_PATTERNS.some(p => p.test(text)),
    isFiller: FILLER_PATTERNS.some(p => p.test(text)),
  };
}

function getSpamScore(remoteJid) {
  return spamScores[remoteJid]?.score || 0;
}

module.exports = {
  isBlocked,
  blockUser,
  unblockUser,
  getBlocklist,
  analyzeMessage,
  getSpamScore,
};
