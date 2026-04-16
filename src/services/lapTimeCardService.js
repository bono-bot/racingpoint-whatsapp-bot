// VIRAL-02: Shareable lap time cards -- text-based session summary
// Image generation is out of scope for v2.0 per CONTEXT.md
const { getDb } = require('../db/database');
const logger = require('../utils/logger');

function buildLapTimeCard(sessionData) {
  const {
    customerName,
    game,
    duration,
    fastestLap,
    averageLap,
    totalLaps,
    date,
    podNumber
  } = sessionData || {};

  const lines = [];
  lines.push('============================');
  lines.push('   RACINGPOINT LAP CARD');
  lines.push('============================');

  if (customerName) lines.push(`Driver: ${customerName}`);
  if (date) lines.push(`Date: ${date}`);
  if (game) lines.push(`Game: ${game}`);
  if (podNumber) lines.push(`Pod: #${podNumber}`);

  lines.push('----------------------------');

  if (fastestLap) lines.push(`Fastest Lap: ${fastestLap}`);
  if (averageLap) lines.push(`Average Lap: ${averageLap}`);
  if (totalLaps) lines.push(`Total Laps: ${totalLaps}`);
  if (duration) lines.push(`Session: ${duration} min`);

  lines.push('----------------------------');
  lines.push('Share this with friends!');
  lines.push('Book at: wa.me/919059833001');
  lines.push('============================');

  return lines.join('\n');
}

function buildShareMessage(sessionData, referralCode) {
  const card = buildLapTimeCard(sessionData);

  let message = `Check out my lap time at RacingPoint!\n\n${card}`;

  if (referralCode) {
    message += `\n\nUse code ${referralCode} for Rs 50 off your first session!`;
  }

  return message;
}

// VIRAL-03: Monthly challenge entry recording (leaderboard display deferred to v2.1)
function recordChallengeEntry(remoteJid, challengeId, scoreValue) {
  const db = getDb();

  db.prepare(`
    INSERT INTO challenge_entries (challenge_id, remote_jid, score_value)
    VALUES (?, ?, ?)
  `).run(challengeId, remoteJid, scoreValue);

  // Calculate rank
  const rank = db.prepare(`
    SELECT COUNT(*) + 1 as rank FROM challenge_entries
    WHERE challenge_id = ? AND score_value < ?
  `).get(challengeId, scoreValue);

  logger.info({ remoteJid, challengeId, scoreValue, rank: rank.rank }, 'Challenge entry recorded');
  return { rank: rank.rank };
}

module.exports = {
  buildLapTimeCard,
  buildShareMessage,
  recordChallengeEntry,
};
