// VIRAL-01: Referral program -- Rs 100 referrer + Rs 50 friend (wallet credit)
const crypto = require('crypto');
const { getDb } = require('../db/database');
const logger = require('../utils/logger');

// Characters excluding ambiguous ones (0/O, 1/I/L)
const SAFE_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

function generateCode() {
  const bytes = crypto.randomBytes(8);
  let code = '';
  for (let i = 0; i < 8; i++) {
    code += SAFE_CHARS[bytes[i] % SAFE_CHARS.length];
  }
  return code;
}

function generateReferralCode(remoteJid) {
  const db = getDb();

  // Check if customer already has an active code
  const existing = db.prepare(
    'SELECT code FROM referral_codes WHERE remote_jid = ? AND active = 1'
  ).get(remoteJid);

  if (existing) {
    return { code: existing.code, isNew: false };
  }

  // Generate unique code with collision retry
  let code;
  let attempts = 0;
  while (attempts < 5) {
    code = generateCode();
    const collision = db.prepare('SELECT id FROM referral_codes WHERE code = ?').get(code);
    if (!collision) break;
    attempts++;
  }

  // Insert into referral_codes
  db.prepare(`
    INSERT INTO referral_codes (remote_jid, code) VALUES (?, ?)
  `).run(remoteJid, code);

  // Update customer_profiles.referral_code
  db.prepare(`
    UPDATE customer_profiles SET referral_code = ? WHERE remote_jid = ?
  `).run(code, remoteJid);

  logger.info({ remoteJid, code }, 'Referral code generated');
  return { code, isNew: true };
}

function validateReferralCode(code, friendJid) {
  const db = getDb();

  // Lookup code
  const ref = db.prepare(
    'SELECT * FROM referral_codes WHERE code = ? AND active = 1'
  ).get(code);

  if (!ref) {
    return { valid: false, reason: 'invalid_code' };
  }

  // Check max uses
  if (ref.uses >= ref.max_uses) {
    return { valid: false, reason: 'max_uses_reached' };
  }

  // Check self-referral
  if (ref.remote_jid === friendJid) {
    return { valid: false, reason: 'self_referral' };
  }

  // Check if friend already redeemed any code
  const alreadyUsed = db.prepare(
    'SELECT id FROM referral_redemptions WHERE friend_jid = ?'
  ).get(friendJid);

  if (alreadyUsed) {
    return { valid: false, reason: 'already_redeemed' };
  }

  return {
    valid: true,
    referrerJid: ref.remote_jid,
    referrerCredit: ref.referrer_credit,
    friendCredit: ref.friend_credit,
    reason: null
  };
}

function redeemReferralCode(code, friendJid) {
  const db = getDb();

  const validation = validateReferralCode(code, friendJid);
  if (!validation.valid) {
    return { success: false, reason: validation.reason };
  }

  // Insert redemption record
  db.prepare(`
    INSERT INTO referral_redemptions (code, referrer_jid, friend_jid, referrer_credited, friend_credited)
    VALUES (?, ?, ?, ?, ?)
  `).run(code, validation.referrerJid, friendJid, validation.referrerCredit, validation.friendCredit);

  // Increment uses
  db.prepare('UPDATE referral_codes SET uses = uses + 1 WHERE code = ?').run(code);

  logger.info({
    code,
    referrerJid: validation.referrerJid,
    friendJid,
    referrerCredit: validation.referrerCredit,
    friendCredit: validation.friendCredit
  }, 'Referral code redeemed');

  return {
    success: true,
    referrerJid: validation.referrerJid,
    referrerCredit: validation.referrerCredit,
    friendCredit: validation.friendCredit
  };
}

function getReferralStats(remoteJid) {
  const db = getDb();

  const ref = db.prepare(
    'SELECT * FROM referral_codes WHERE remote_jid = ? AND active = 1'
  ).get(remoteJid);

  if (!ref) {
    return { code: null, totalReferrals: 0, totalEarned: 0, remaining: 0 };
  }

  const redemptions = db.prepare(
    'SELECT COUNT(*) as cnt FROM referral_redemptions WHERE code = ?'
  ).get(ref.code);

  const totalReferrals = redemptions ? redemptions.cnt : 0;
  const totalEarned = totalReferrals * ref.referrer_credit;
  const remaining = ref.max_uses - ref.uses;

  return {
    code: ref.code,
    totalReferrals,
    totalEarned,
    remaining
  };
}

module.exports = {
  generateReferralCode,
  validateReferralCode,
  redeemReferralCode,
  getReferralStats,
};
