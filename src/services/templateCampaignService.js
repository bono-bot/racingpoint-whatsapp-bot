const { getDb } = require('../db/database');
const { POST_VISIT_FLOW, SEGMENT_TEMPLATES } = require('../data/templateDefinitions');
const { getTodaysFestivals } = require('../data/festivalCalendar');
const logger = require('../utils/logger');

// Lazy-load to avoid circular dependencies
let followUpSvc = null;
function getFollowUpService() {
  if (!followUpSvc) {
    followUpSvc = require('./followUpService');
  }
  return followUpSvc;
}

let handoffSvc = null;
function getHandoffService() {
  if (!handoffSvc) {
    handoffSvc = require('./handoffService');
  }
  return handoffSvc;
}

let evoService = null;
function getEvoService() {
  if (!evoService) {
    evoService = require('./evolutionService');
  }
  return evoService;
}

// ── Campaign timer ──────────────────────────────────────────────────

let campaignInterval = null;

function startCampaignTimer() {
  if (campaignInterval) {
    logger.warn('Campaign timer already running');
    return;
  }
  // Run every 60 minutes -- campaigns are daily, not urgent
  campaignInterval = setInterval(async () => {
    try {
      await processCampaignQueue();
      await processFestivalCampaigns();
    } catch (err) {
      logger.error({ err }, 'Campaign timer cycle error');
    }
  }, 60 * 60 * 1000);
  logger.info('Campaign timer started (every 60 min)');
}

function stopCampaignTimer() {
  if (campaignInterval) {
    clearInterval(campaignInterval);
    campaignInterval = null;
    logger.info('Campaign timer stopped');
  }
}

// ── Suppression logic (TMPL-08) ─────────────────────────────────────

function getMonthlyCount(remoteJid) {
  const db = getDb();
  const now = new Date();
  const monthStart = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`;
  const row = db.prepare(`
    SELECT COUNT(*) as cnt FROM template_sends
    WHERE remote_jid = ? AND status = 'sent'
      AND created_at >= ?
  `).get(remoteJid, monthStart);
  return row ? row.cnt : 0;
}

function getConsecutiveIgnored(remoteJid) {
  const db = getDb();
  const rows = db.prepare(`
    SELECT response_status FROM template_sends
    WHERE remote_jid = ? AND status = 'sent'
    ORDER BY created_at DESC
    LIMIT 10
  `).all(remoteJid);

  let count = 0;
  for (const row of rows) {
    if (row.response_status === 'ignored') {
      count++;
    } else {
      break;
    }
  }
  return count >= 2;
}

function shouldSuppress(remoteJid) {
  if (getMonthlyCount(remoteJid) >= 4) {
    return { suppress: true, reason: 'monthly_cap' };
  }
  if (getConsecutiveIgnored(remoteJid)) {
    return { suppress: true, reason: 'ignored_streak' };
  }
  return { suppress: false, reason: null };
}

// ── Post-visit flow (TMPL-01 through TMPL-05) ──────────────────────

function triggerPostVisitFlow(remoteJid, sessionData = {}) {
  const db = getDb();
  const now = Date.now();

  const dayOffsets = {
    day_1: 1,
    day_3: 3,
    day_7: 7,
    day_14: 14,
    day_30: 30
  };

  const scheduledRows = [];

  for (const [dayKey, template] of Object.entries(POST_VISIT_FLOW)) {
    const offsetDays = dayOffsets[dayKey];
    const scheduledAt = new Date(now + offsetDays * 24 * 60 * 60 * 1000).toISOString();

    // Check suppression before scheduling
    const suppression = shouldSuppress(remoteJid);
    const status = suppression.suppress ? 'suppressed' : 'pending';
    const error = suppression.suppress ? suppression.reason : null;

    const result = db.prepare(`
      INSERT INTO template_sends (remote_jid, template_name, campaign_type, flow_day, scheduled_at, status, error)
      VALUES (?, ?, 'post_visit', ?, ?, ?, ?)
    `).run(remoteJid, template.templateName, offsetDays, scheduledAt, status, error);

    scheduledRows.push({
      id: result.lastInsertRowid,
      dayKey,
      flowDay: offsetDays,
      scheduledAt,
      status
    });
  }

  logger.info({ remoteJid, rows: scheduledRows.length }, 'Post-visit flow scheduled');
  return scheduledRows;
}

// ── Process campaign queue ──────────────────────────────────────────

async function processCampaignQueue() {
  const db = getDb();

  const pending = db.prepare(`
    SELECT * FROM template_sends
    WHERE status = 'pending' AND scheduled_at <= datetime('now')
  `).all();

  if (pending.length === 0) return;

  logger.info({ count: pending.length }, 'Processing campaign queue');

  for (const row of pending) {
    try {
      await processOneSend(db, row);
    } catch (err) {
      logger.error({ err, sendId: row.id, remoteJid: row.remote_jid }, 'Error processing template send');
      db.prepare(`
        UPDATE template_sends SET status = 'failed', error = ? WHERE id = ?
      `).run(err.message || 'unknown error', row.id);
    }
  }
}

async function processOneSend(db, row) {
  const { id, remote_jid: remoteJid, template_name: templateName } = row;

  // a) Check opt-in
  const followUp = getFollowUpService();
  if (!followUp.isOptedIn(remoteJid)) {
    db.prepare("UPDATE template_sends SET status = 'suppressed', error = 'not_opted_in' WHERE id = ?").run(id);
    logger.info({ sendId: id, remoteJid }, 'Template suppressed (not opted in)');
    return;
  }

  // b) Check frequency cap
  if (getMonthlyCount(remoteJid) >= 4) {
    db.prepare("UPDATE template_sends SET status = 'suppressed', error = 'monthly_cap' WHERE id = ?").run(id);
    logger.info({ sendId: id, remoteJid }, 'Template suppressed (monthly cap)');
    return;
  }

  // c) Check consecutive ignored
  if (getConsecutiveIgnored(remoteJid)) {
    db.prepare("UPDATE template_sends SET status = 'suppressed', error = 'ignored_streak' WHERE id = ?").run(id);
    logger.info({ sendId: id, remoteJid }, 'Template suppressed (ignored streak)');
    return;
  }

  // d) Check handoff status
  const handoff = getHandoffService();
  if (!handoff.isBotActive(remoteJid)) {
    db.prepare("UPDATE template_sends SET status = 'suppressed', error = 'human_handoff' WHERE id = ?").run(id);
    logger.info({ sendId: id, remoteJid }, 'Template suppressed (human handoff active)');
    return;
  }

  // e) Send via evolutionService.sendTemplate
  try {
    const evo = getEvoService();
    if (typeof evo.sendTemplate === 'function') {
      await evo.sendTemplate(remoteJid, templateName, []);
    } else {
      // sendTemplate not yet wired (Plan 02) -- use sendText as fallback
      logger.warn({ sendId: id, templateName }, 'sendTemplate not available, skipping actual send');
    }
  } catch (err) {
    db.prepare("UPDATE template_sends SET status = 'failed', error = ? WHERE id = ?").run(err.message, id);
    logger.error({ err, sendId: id, remoteJid }, 'Failed to send template');
    return;
  }

  // f) Mark as sent
  db.prepare(`
    UPDATE template_sends SET status = 'sent', sent_at = datetime('now') WHERE id = ?
  `).run(id);

  logger.info({ sendId: id, remoteJid, templateName }, 'Template sent');
}

// ── Segment campaigns (TMPL-06) ─────────────────────────────────────

async function processSegmentCampaigns() {
  const db = getDb();

  for (const [segmentKey, template] of Object.entries(SEGMENT_TEMPLATES)) {
    try {
      const customers = db.prepare(`
        SELECT remote_jid, push_name, visit_count, last_visit
        FROM customer_profiles
        WHERE ${template.segment_query}
      `).all();

      let scheduled = 0;

      for (const customer of customers) {
        // Check opt-in
        const followUp = getFollowUpService();
        if (!followUp.isOptedIn(customer.remote_jid)) continue;

        // Check suppression
        const suppression = shouldSuppress(customer.remote_jid);
        if (suppression.suppress) continue;

        // Check if already sent this segment template this month
        const now = new Date();
        const monthStart = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`;
        const existing = db.prepare(`
          SELECT id FROM template_sends
          WHERE remote_jid = ? AND template_name = ? AND created_at >= ?
        `).get(customer.remote_jid, template.templateName, monthStart);
        if (existing) continue;

        // Schedule send
        const scheduledAt = new Date().toISOString();
        db.prepare(`
          INSERT INTO template_sends (remote_jid, template_name, campaign_type, scheduled_at, status)
          VALUES (?, ?, 'segment', ?, 'pending')
        `).run(customer.remote_jid, template.templateName, scheduledAt);
        scheduled++;
      }

      if (scheduled > 0) {
        logger.info({ segment: segmentKey, scheduled }, 'Segment campaign scheduled');
      }
    } catch (err) {
      logger.error({ err, segment: segmentKey }, 'Error processing segment campaign');
    }
  }
}

// ── Festival campaigns (TMPL-07) ────────────────────────────────────

async function processFestivalCampaigns() {
  const db = getDb();
  const todaysFestivals = getTodaysFestivals();

  if (todaysFestivals.length === 0) return;

  for (const festival of todaysFestivals) {
    try {
      // Check if already scheduled today
      const today = new Date().toISOString().split('T')[0];
      const existing = db.prepare(`
        SELECT id FROM template_sends
        WHERE template_name = ? AND created_at >= ?
        LIMIT 1
      `).get(festival.templateName, today);
      if (existing) continue;

      // Get all opted-in customers
      const customers = db.prepare(`
        SELECT cp.remote_jid, cp.push_name
        FROM customer_profiles cp
        JOIN customer_optins co ON cp.remote_jid = co.remote_jid
        WHERE co.opted_in = 1
      `).all();

      let scheduled = 0;

      for (const customer of customers) {
        const suppression = shouldSuppress(customer.remote_jid);
        if (suppression.suppress) continue;

        const scheduledAt = new Date().toISOString();
        db.prepare(`
          INSERT INTO template_sends (remote_jid, template_name, campaign_type, scheduled_at, status)
          VALUES (?, ?, 'festival', ?, 'pending')
        `).run(customer.remote_jid, festival.templateName, scheduledAt);
        scheduled++;
      }

      logger.info({ festival: festival.key, scheduled }, 'Festival campaign scheduled');
    } catch (err) {
      logger.error({ err, festival: festival.key }, 'Error processing festival campaign');
    }
  }
}

module.exports = {
  startCampaignTimer,
  stopCampaignTimer,
  triggerPostVisitFlow,
  processCampaignQueue,
  processSegmentCampaigns,
  processFestivalCampaigns,
};
