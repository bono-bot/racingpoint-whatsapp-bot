/**
 * Customer Context Service
 * Reads from racecontrol.db (read-only) to enrich WhatsApp conversations
 * with customer profile, segment, visit history, and wallet data.
 */

const Database = require('better-sqlite3');
const logger = require('../utils/logger');

const RC_DB = '/root/racecontrol/data/racecontrol.db';

/**
 * Normalize a phone number to 10-digit Indian format
 */
function normalizePhone(phone) {
  if (!phone) return null;
  const digits = phone.replace(/[^0-9]/g, '');
  if (digits.length >= 10) return digits.slice(-10);
  return digits;
}

/**
 * Get customer context from RaceControl DB for a WhatsApp remoteJid.
 * Returns null if customer not found (new/unregistered).
 */
function getCustomerContext(remoteJid) {
  const jidPhone = remoteJid.replace('@s.whatsapp.net', '');
  const phone10 = normalizePhone(jidPhone);
  if (!phone10) return null;

  let db;
  try {
    db = new Database(RC_DB, { readonly: true, fileMustExist: true });
  } catch (err) {
    logger.warn({ err: err.message }, 'Cannot open racecontrol.db for customer context');
    return null;
  }

  try {
    // Find driver by phone (try multiple formats)
    const driver = db.prepare(`
      SELECT id, name, phone, total_laps, total_time_ms, last_login_at,
             has_used_trial, created_at, referral_code, nickname,
             registration_completed
      FROM drivers
      WHERE (is_employee = 0 OR is_employee IS NULL)
        AND (phone LIKE ? OR phone LIKE ? OR phone LIKE ? OR phone LIKE ?)
      LIMIT 1
    `).get(`%${phone10}`, `+91${phone10}`, `91${phone10}`, phone10);

    if (!driver) return null;

    // Wallet balance
    const wallet = db.prepare(
      'SELECT balance_paise, total_credited_paise, total_debited_paise FROM wallets WHERE driver_id = ?'
    ).get(driver.id);

    // Session stats
    const sessions = db.prepare(`
      SELECT COUNT(*) as count,
             MAX(created_at) as last_session,
             SUM(wallet_debit_paise) as total_spent,
             AVG(driving_seconds) as avg_duration
      FROM billing_sessions
      WHERE driver_id = ? AND status IN ('completed', 'in_progress')
    `).get(driver.id);

    // Membership
    const membership = db.prepare(`
      SELECT mt.name as tier, m.status, m.hours_used_minutes
      FROM memberships m
      JOIN membership_tiers mt ON m.tier_id = mt.id
      WHERE m.driver_id = ? AND m.status = 'active'
      LIMIT 1
    `).get(driver.id);

    // Recent tracks and cars (last 5 distinct)
    const recentLaps = db.prepare(`
      SELECT DISTINCT track, car FROM laps
      WHERE driver_id = ? AND track IS NOT NULL
      ORDER BY created_at DESC LIMIT 5
    `).all(driver.id);

    // Personal bests count
    const pbCount = db.prepare(
      'SELECT COUNT(*) as count FROM personal_bests WHERE driver_id = ?'
    ).get(driver.id);

    // Friend count
    const friends = db.prepare(`
      SELECT COUNT(*) as count FROM friendships
      WHERE driver_a_id = ? OR driver_b_id = ?
    `).get(driver.id, driver.id);

    // Tournament count
    const tournaments = db.prepare(
      'SELECT COUNT(*) as count FROM tournament_registrations WHERE driver_id = ?'
    ).get(driver.id);

    // Active coupon count
    const activeCoupons = db.prepare(
      "SELECT COUNT(*) as count FROM coupons WHERE is_active = 1"
    ).get();

    // Wallet transaction summary (top-up history)
    const walletTxns = db.prepare(`
      SELECT COUNT(*) as txn_count,
             SUM(CASE WHEN txn_type LIKE 'topup%' THEN amount_paise ELSE 0 END) as total_topups,
             MAX(created_at) as last_txn
      FROM wallet_transactions
      WHERE driver_id = ?
    `).get(driver.id);

    // Days since last session
    let daysSinceLastVisit = null;
    if (sessions.last_session) {
      const last = new Date(sessions.last_session);
      daysSinceLastVisit = Math.floor((Date.now() - last.getTime()) / (1000 * 60 * 60 * 24));
    }

    // Days since registration
    let customerAgeDays = null;
    if (driver.created_at) {
      const reg = new Date(driver.created_at);
      customerAgeDays = Math.floor((Date.now() - reg.getTime()) / (1000 * 60 * 60 * 24));
    }

    // Determine segment heuristic (lightweight — no full RFM)
    const segment = classifyQuick(sessions.count || 0, daysSinceLastVisit, sessions.total_spent || 0);

    return {
      name: driver.name || driver.nickname,
      isRegistered: true,
      registrationComplete: Boolean(driver.registration_completed),
      totalLaps: driver.total_laps || 0,
      totalSessions: sessions.count || 0,
      totalSpentCredits: sessions.total_spent ? Math.round(sessions.total_spent / 100) : 0,
      walletBalance: wallet ? Math.round(wallet.balance_paise / 100) : 0,
      totalTopUps: walletTxns?.total_topups ? Math.round(walletTxns.total_topups / 100) : 0,
      hasUsedTrial: Boolean(driver.has_used_trial),
      membership: membership?.tier || null,
      referralCode: driver.referral_code || null,
      lastSession: sessions.last_session,
      daysSinceLastVisit,
      customerAgeDays,
      avgSessionMinutes: sessions.avg_duration ? Math.round(sessions.avg_duration / 60) : null,
      recentTracks: [...new Set(recentLaps.map(l => l.track).filter(Boolean))],
      recentCars: [...new Set(recentLaps.map(l => l.car).filter(Boolean))],
      personalBests: pbCount?.count || 0,
      friendCount: friends?.count || 0,
      tournamentCount: tournaments?.count || 0,
      activeCouponsAvailable: (activeCoupons?.count || 0) > 0,
      segment,
    };
  } catch (err) {
    logger.error({ err, remoteJid }, 'Error fetching customer context');
    return null;
  } finally {
    db.close();
  }
}

/**
 * Quick segment classification without full RFM scoring.
 * Used for real-time conversation enrichment.
 */
function classifyQuick(sessionCount, daysSinceLastVisit, totalSpentPaise) {
  if (sessionCount === 0) return 'New';
  if (sessionCount === 1 && daysSinceLastVisit > 30) return 'One-and-Done';
  if (sessionCount === 1) return 'New / Promising';
  if (daysSinceLastVisit !== null && daysSinceLastVisit > 60 && sessionCount >= 3) return 'At Risk';
  if (daysSinceLastVisit !== null && daysSinceLastVisit > 30 && sessionCount >= 2) return 'Cooling Off';
  if (sessionCount >= 8 && totalSpentPaise >= 500000) return 'Champion';
  if (sessionCount >= 5) return 'Loyal';
  if (sessionCount >= 3) return 'Regular';
  return 'Casual';
}

/**
 * Build a context string for injection into the system prompt.
 */
function buildContextBlock(ctx) {
  if (!ctx) return '';

  const lines = [
    `\n## Customer Context (this person is messaging you right now)`,
    `- *Name:* ${ctx.name}`,
    `- *Registered:* Yes`,
    `- *Sessions:* ${ctx.totalSessions}`,
    `- *Wallet Balance:* ${ctx.walletBalance} Credits`,
  ];

  if (ctx.membership) lines.push(`- *Membership:* ${ctx.membership}`);
  if (ctx.totalSpentCredits > 0) lines.push(`- *Total Spent:* ${ctx.totalSpentCredits} Credits`);
  if (ctx.totalTopUps > 0) lines.push(`- *Total Top-Ups:* ${ctx.totalTopUps} Credits`);
  if (ctx.totalLaps > 0) lines.push(`- *Total Laps:* ${ctx.totalLaps}`);
  if (ctx.daysSinceLastVisit !== null) lines.push(`- *Last Visit:* ${ctx.daysSinceLastVisit} days ago`);
  if (ctx.recentTracks.length > 0) lines.push(`- *Recent Tracks:* ${ctx.recentTracks.slice(0, 3).join(', ')}`);
  if (ctx.recentCars.length > 0) lines.push(`- *Recent Cars:* ${ctx.recentCars.slice(0, 3).join(', ')}`);
  if (ctx.personalBests > 0) lines.push(`- *Personal Bests:* ${ctx.personalBests}`);
  if (ctx.friendCount > 0) lines.push(`- *Friends on Platform:* ${ctx.friendCount}`);
  if (ctx.tournamentCount > 0) lines.push(`- *Tournaments Entered:* ${ctx.tournamentCount}`);
  if (ctx.referralCode) lines.push(`- *Referral Code:* ${ctx.referralCode}`);
  if (ctx.activeCouponsAvailable) lines.push(`- *Coupons Available:* Yes — ask if they want to use one!`);
  lines.push(`- *Segment:* ${ctx.segment}`);
  if (ctx.hasUsedTrial) lines.push(`- *Has Used Free Trial:* Yes`);

  lines.push('');
  lines.push('### How to use this context:');

  // Segment-specific conversation tips
  switch (ctx.segment) {
    case 'Champion':
      lines.push('- Greet them like a VIP. Reference their experience and skill.');
      lines.push('- Mention exclusive events, tournaments, or new tracks they might enjoy.');
      lines.push('- If they have no membership, suggest Champion tier as a natural fit.');
      lines.push('- Ask if they want to host a group session or bring friends (Squad/Corporate packages).');
      if (ctx.referralCode) lines.push(`- Remind them to share their referral code for free credits: "${ctx.referralCode}".`);
      break;
    case 'Loyal':
      lines.push('- Greet warmly by name. Acknowledge they are a valued regular.');
      lines.push('- If they have no membership, mention Pro membership saves ~30% (₹625/hr vs ₹900/hr).');
      lines.push('- Suggest trying new tracks or cars they haven\'t driven yet.');
      lines.push('- Mention the referral program — they could earn free credits by inviting friends.');
      break;
    case 'At Risk':
      lines.push('- Be extra warm and welcoming. Do NOT guilt them about not visiting.');
      lines.push('- Mention what\'s new since their last visit (new games, events, packages).');
      lines.push('- If they have wallet balance, casually mention it ("Your credits are still waiting!").');
      lines.push('- Suggest a group session — coming with friends might re-spark interest.');
      break;
    case 'Cooling Off':
      lines.push('- Friendly check-in vibe. Mention new packages and events.');
      lines.push('- If they have wallet balance, mention it.');
      lines.push('- Suggest bringing friends for the Squad package — makes it a social outing.');
      break;
    case 'One-and-Done':
      lines.push('- They came once and didn\'t return. Be encouraging, not pushy.');
      lines.push('- Highlight the value: ₹900/hr is less than half the price of go-karting.');
      lines.push('- Suggest bringing friends (Squad package = ₹800/person for an hour — great for groups of 4).');
      lines.push('- Mention the Student Special (₹600/hr weekdays) if they might be a student.');
      break;
    case 'New / Promising':
      lines.push('- They just started! Be enthusiastic and helpful.');
      lines.push('- If they haven\'t used the free trial, mention it.');
      lines.push('- Explain what makes the experience great (direct drive wheels, triple screens).');
      lines.push('- Suggest trying a 30-min session (₹700) to start — no commitment.');
      break;
    case 'Regular':
      lines.push('- Solid regular. Keep it friendly and efficient.');
      lines.push('- If they visit 2+ times per month, suggest Rookie membership (₹3K for 4 hrs).');
      lines.push('- If they visit weekly, Pro membership (₹5K for 8 hrs) saves them ~30%.');
      lines.push('- Mention referral program — they likely have friends who\'d enjoy it too.');
      break;
    default:
      lines.push('- Be friendly and helpful. Personalize based on their name and history.');
      lines.push('- If they have wallet balance > 0, mention it. If 0, suggest topping up for their next visit.');
  }

  // Universal upsell hints based on data
  if (ctx.walletBalance > 0 && ctx.totalSessions === 0) {
    lines.push('');
    lines.push('IMPORTANT: This customer has loaded ' + ctx.walletBalance + ' credits but has NEVER raced. Their credits are sitting idle. Gently encourage them to come in and use them!');
  }
  if (!ctx.membership && ctx.totalSessions >= 4) {
    lines.push('');
    lines.push('UPSELL: This customer has done ' + ctx.totalSessions + ' sessions without a membership. Mention that memberships could save them money.');
  }

  return lines.join('\n');
}

module.exports = { getCustomerContext, buildContextBlock, normalizePhone };
