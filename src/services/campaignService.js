/**
 * Campaign Service
 * Segment-based WhatsApp campaign engine.
 * Runs consumer segmentation, matches to WhatsApp JIDs, sends targeted messages.
 */

const { execFileSync } = require('child_process');
const Database = require('better-sqlite3');
const evolutionService = require('./evolutionService');
const { normalizePhone } = require('./customerContextService');
const { getDb } = require('../db/database');
const logger = require('../utils/logger');

const SEGMENT_SCRIPT = '/root/.claude/skills/consumer-segments/scripts/analyze_segments.py';
const RC_DB = '/root/racecontrol/data/racecontrol.db';
const SEND_DELAY_MS = 3000; // 3 seconds between messages (safe for WhatsApp)

// ─── Campaign Templates ──────────────────────────────────────

const TEMPLATES = {
  'Champion': {
    label: 'VIP Recognition',
    message: (name) =>
      `Hey ${name}! 🏆\n\nAs one of RacingPoint's top racers, you get early access to our upcoming events and tournaments. Come by this week — we'd love to have you test our newest track setups!\n\nYour credits are ready and waiting. See you on the grid! 🏁`,
  },
  'Loyal': {
    label: 'Membership Nudge',
    message: (name) =>
      `Hey ${name}!\n\nThanks for being a regular at RacingPoint! Did you know our membership plans can save you up to 20% per session? Based on your visits, a membership would pay for itself quickly.\n\nAsk us about Rookie, Pro, or Champion tiers next time you're in! 🏎️`,
  },
  'At Risk': {
    label: 'Win-Back',
    message: (name) =>
      `Hey ${name}! We miss you at RacingPoint! 🏎️\n\nIt's been a while since your last session. We've been upgrading — new games, better rigs, and our cafe has some great new additions.\n\nCome back and experience the difference. Walk-ins welcome anytime 12 PM – 12 AM!\n\nSee you soon! 🏁`,
  },
  "Can't Lose Them": {
    label: 'Priority Win-Back',
    message: (name) =>
      `Hey ${name}! 🏁\n\nWe noticed it's been a while since your last visit. As one of our most valued racers, we wanted to personally invite you back.\n\nWe've got new tracks and competitions lined up. Your wallet credits are still here waiting for you!\n\nHope to see you soon! 🏎️`,
  },
  'Lost': {
    label: 'Re-engagement',
    message: (name) =>
      `Hey ${name}!\n\nRemember the thrill of sim racing? 🏎️ We've upgraded our rigs with triple 32" monitors, direct-drive wheelbases, and added new games since your last visit.\n\nCome try the new setup — first 5 minutes free for returning racers! Walk in anytime 12 PM - 12 AM.\n\nWe'd love to have you back! 🏁`,
  },
  'New / Promising': {
    label: 'Second Visit Push',
    message: (name) =>
      `Hey ${name}! 👋\n\nGreat meeting you at RacingPoint! Ready for round 2?\n\nTip: Bring a friend along — sim racing is even more fun head-to-head! Our 60-minute session at ₹900 is amazing value (less than half the price of go-karting!).\n\nWalk-ins welcome anytime 12 PM – 12 AM. See you on track! 🏁`,
  },
  'Casual': {
    label: 'Engagement Boost',
    message: (name) =>
      `Hey ${name}!\n\nJust wanted to remind you — RacingPoint is here whenever you want an adrenaline fix! 🏎️\n\nWhether it's 30 minutes (₹700) or a full hour (₹900), every session is a blast. Plus, our cafe has great food to fuel your racing.\n\nWalk-ins welcome, 12 PM – 12 AM, every day! 🏁`,
  },
  'Dormant Wallet': {
    label: 'Wallet Reminder',
    message: (name, ctx) =>
      `Hey ${name}! 💰\n\nJust a friendly reminder — you have *${ctx.walletBalance || 'some'} credits* sitting in your RacingPoint wallet!\n\nThat's enough for a session. Don't let them go to waste — come use them anytime!\n\nWe're open 12 PM – 12 AM, every day. See you soon! 🏎️`,
  },
  'Reciprocity Offer': {
    label: 'Reciprocity — Free Value First',
    message: (name) =>
      `Hey ${name}!\n\n` +
      `Quick tip from our pro drivers: on Spa-Francorchamps, brake 10 meters later into La Source than you think — the car can handle it.\n\n` +
      `We put together a free "Top 5 Beginner Mistakes" guide based on data from 21,000+ laps at our venue. Want a copy? Just reply "yes" and we'll send it over.\n\n` +
      `See you on track! Your RacingPoint crew`,
  },
  'Social Proof': {
    label: 'Social Proof — Crowd Validation',
    message: (name) =>
      `Hey ${name}!\n\n` +
      `This week alone, 127 RacingPoint Drivers hit the track — and 23 of them set personal bests.\n\n` +
      `The most popular combo right now? Spa-Francorchamps in the Porsche 911 GT3 R. Drivers are averaging 2:21 — think you can beat that?\n\n` +
      `Walk-ins welcome, 12 PM - 12 AM every day.\n\n` +
      `See you on the grid!`,
  },
  'Scarcity Alert': {
    label: 'Scarcity — Limited Availability',
    message: (name) =>
      `Hey ${name}!\n\n` +
      `Heads up — this Saturday evening (6 PM - 10 PM) is filling up fast. Last Saturday we were fully booked by 7 PM and had to turn away walk-ins.\n\n` +
      `If you're planning to come this weekend, we'd recommend booking ahead or coming before 6 PM when pods are more available.\n\n` +
      `Book: https://app.racingpoint.cloud/book\n` +
      `Or just walk in — we're open 12 PM to 12 AM!\n\n` +
      `See you soon!`,
  },
};

// ─── Segment Data ────────────────────────────────────────────

/**
 * Run the segmentation script and get per-customer data.
 */
function getSegmentData() {
  try {
    const output = execFileSync('python3', [SEGMENT_SCRIPT, 'customers'], {
      timeout: 30000,
      encoding: 'utf-8',
    });
    return JSON.parse(output);
  } catch (err) {
    logger.error({ err: err.message }, 'Failed to run segmentation script');
    return [];
  }
}

/**
 * Get all known WhatsApp JIDs from conversation history.
 */
function getKnownJids() {
  const db = getDb();
  const rows = db.prepare(
    `SELECT DISTINCT remote_jid FROM messages WHERE remote_jid LIKE '%@s.whatsapp.net'`
  ).all();
  return new Set(rows.map(r => r.remote_jid));
}

/**
 * Get dormant wallet customers directly from racecontrol.db
 */
function getDormantWalletCustomers() {
  let db;
  try {
    db = new Database(RC_DB, { readonly: true, fileMustExist: true });
  } catch {
    return [];
  }

  try {
    const rows = db.prepare(`
      SELECT d.name, d.phone, w.balance_paise
      FROM drivers d
      JOIN wallets w ON d.id = w.driver_id
      LEFT JOIN billing_sessions bs ON d.id = bs.driver_id
        AND bs.status IN ('completed', 'in_progress')
      WHERE (d.is_employee = 0 OR d.is_employee IS NULL)
        AND w.balance_paise >= 50000
      GROUP BY d.id
      HAVING MAX(bs.created_at) < datetime('now', '-30 days')
         OR MAX(bs.created_at) IS NULL
    `).all();
    return rows.map(r => ({
      name: r.name,
      phone: r.phone,
      walletBalance: Math.round(r.balance_paise / 100),
      segment: 'Dormant Wallet',
    }));
  } catch (err) {
    logger.error({ err: err.message }, 'Failed to get dormant wallet customers');
    return [];
  } finally {
    db.close();
  }
}

/**
 * Convert phone to WhatsApp JID.
 */
function phoneToJid(phone) {
  if (!phone) return null;
  const digits = phone.replace(/[^0-9]/g, '');
  // Ensure 91 prefix
  if (digits.length === 10) return `91${digits}@s.whatsapp.net`;
  if (digits.length === 12 && digits.startsWith('91')) return `${digits}@s.whatsapp.net`;
  if (digits.length > 10) return `${digits.slice(-12)}@s.whatsapp.net`;
  return null;
}

// ─── Campaign Operations ─────────────────────────────────────

/**
 * List available segments and customer counts.
 */
function listSegments() {
  const customers = getSegmentData();
  const knownJids = getKnownJids();
  const dormant = getDormantWalletCustomers();

  // Count per segment
  const counts = {};
  for (const c of customers) {
    const seg = c.segment;
    if (!counts[seg]) counts[seg] = { total: 0, reachable: 0 };
    counts[seg].total++;
    const jid = phoneToJid(c.phone);
    if (jid && knownJids.has(jid)) counts[seg].reachable++;
  }

  // Add dormant wallet
  if (dormant.length > 0) {
    counts['Dormant Wallet'] = { total: dormant.length, reachable: 0 };
    for (const d of dormant) {
      const jid = phoneToJid(d.phone);
      if (jid && knownJids.has(jid)) counts['Dormant Wallet'].reachable++;
    }
  }

  return counts;
}

/**
 * Preview a campaign message for a segment.
 */
function previewCampaign(segmentName) {
  const template = TEMPLATES[segmentName];
  if (!template) return null;
  return {
    segment: segmentName,
    label: template.label,
    preview: template.message('{{Customer Name}}', { walletBalance: '{{Balance}}' }),
  };
}

/**
 * Get the list of available template names.
 */
function getAvailableTemplates() {
  return Object.keys(TEMPLATES);
}

// Pending campaign confirmation (in-memory, keyed by admin JID)
const pendingCampaigns = new Map();

/**
 * Prepare a campaign for sending. Returns summary for confirmation.
 */
function prepareCampaign(segmentName) {
  const template = TEMPLATES[segmentName];
  if (!template) return { error: `No template for segment "${segmentName}". Available: ${Object.keys(TEMPLATES).join(', ')}` };

  const knownJids = getKnownJids();
  let recipients;

  if (segmentName === 'Dormant Wallet') {
    const dormant = getDormantWalletCustomers();
    recipients = dormant
      .map(d => ({ ...d, jid: phoneToJid(d.phone) }))
      .filter(d => d.jid && knownJids.has(d.jid));
  } else {
    const allCustomers = getSegmentData();
    recipients = allCustomers
      .filter(c => c.segment === segmentName)
      .map(c => ({ ...c, jid: phoneToJid(c.phone), walletBalance: null }))
      .filter(c => c.jid && knownJids.has(c.jid));
  }

  if (recipients.length === 0) {
    return { error: `No reachable customers in segment "${segmentName}" (they need to have messaged us on WhatsApp first).` };
  }

  return {
    segment: segmentName,
    label: template.label,
    recipientCount: recipients.length,
    recipients,
    preview: template.message(recipients[0]?.name || 'Customer', recipients[0] || {}),
  };
}

/**
 * Store a pending campaign for confirmation.
 */
function setPending(adminJid, campaignData) {
  pendingCampaigns.set(adminJid, {
    ...campaignData,
    preparedAt: Date.now(),
  });
}

/**
 * Get and clear pending campaign.
 */
function getPending(adminJid) {
  const pending = pendingCampaigns.get(adminJid);
  if (!pending) return null;
  // Expire after 5 minutes
  if (Date.now() - pending.preparedAt > 5 * 60 * 1000) {
    pendingCampaigns.delete(adminJid);
    return null;
  }
  pendingCampaigns.delete(adminJid);
  return pending;
}

/**
 * Execute a campaign — send messages with rate limiting.
 */
async function executeCampaign(campaignData) {
  const db = getDb();
  const template = TEMPLATES[campaignData.segment];

  // Create campaign record
  const result = db.prepare(`
    INSERT INTO campaigns (segment, template_label, total_recipients, status)
    VALUES (?, ?, ?, 'sending')
  `).run(campaignData.segment, campaignData.label, campaignData.recipients.length);
  const campaignId = result.lastInsertRowid;

  // Insert recipient records
  const insertMsg = db.prepare(`
    INSERT INTO campaign_messages (campaign_id, remote_jid, customer_name, status)
    VALUES (?, ?, ?, 'pending')
  `);
  for (const r of campaignData.recipients) {
    insertMsg.run(campaignId, r.jid, r.name);
  }

  // Send with delays
  let sentCount = 0;
  let failedCount = 0;

  for (let i = 0; i < campaignData.recipients.length; i++) {
    const recipient = campaignData.recipients[i];
    try {
      const message = template.message(recipient.name || 'there', recipient);
      await evolutionService.sendText(recipient.jid, message);

      db.prepare(`
        UPDATE campaign_messages SET status = 'sent', sent_at = datetime('now')
        WHERE campaign_id = ? AND remote_jid = ?
      `).run(campaignId, recipient.jid);
      sentCount++;

      logger.info({ campaignId, jid: recipient.jid, name: recipient.name }, 'Campaign message sent');
    } catch (err) {
      db.prepare(`
        UPDATE campaign_messages SET status = 'failed', error = ?
        WHERE campaign_id = ? AND remote_jid = ?
      `).run(err.message, campaignId, recipient.jid);
      failedCount++;

      logger.error({ err: err.message, campaignId, jid: recipient.jid }, 'Campaign message failed');
    }

    // Rate limit delay between messages
    if (i < campaignData.recipients.length - 1) {
      await new Promise(resolve => setTimeout(resolve, SEND_DELAY_MS));
    }
  }

  // Update campaign record
  db.prepare(`
    UPDATE campaigns SET sent_count = ?, failed_count = ?, status = 'completed', completed_at = datetime('now')
    WHERE id = ?
  `).run(sentCount, failedCount, campaignId);

  logger.info({ campaignId, sentCount, failedCount, segment: campaignData.segment }, 'Campaign completed');

  return { campaignId, sentCount, failedCount };
}

/**
 * Get recent campaign stats.
 */
function getCampaignStats() {
  const db = getDb();
  return db.prepare(`
    SELECT id, segment, template_label, total_recipients, sent_count, failed_count, status, created_at, completed_at
    FROM campaigns
    ORDER BY created_at DESC
    LIMIT 10
  `).all();
}

module.exports = {
  listSegments,
  previewCampaign,
  getAvailableTemplates,
  prepareCampaign,
  setPending,
  getPending,
  executeCampaign,
  getCampaignStats,
};
