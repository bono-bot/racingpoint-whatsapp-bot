const { getDb } = require('../db/database');
const logger = require('../utils/logger');

// ── Funnel stages (matches intelligenceService.FUNNEL_STAGES) ──
const FUNNEL_STAGES = ['inquiry', 'interest', 'qualified', 'booking_intent', 'booked', 'visited'];

/**
 * Get funnel conversion metrics for a given period.
 * Counts unique customers at each stage and computes stage-to-stage conversion rates.
 * (ANAL-01)
 *
 * @param {number} periodDays - Number of days to look back (default 30)
 * @returns {{ stages: Array<{stage: string, count: number, conversionFromPrevious: number|null}>, period: string, generatedAt: string }}
 */
function getFunnelMetrics(periodDays = 30) {
  const db = getDb();
  const cutoff = `-${periodDays} days`;

  // Count unique customers who reached each stage within the period
  const rows = db.prepare(`
    SELECT stage, COUNT(DISTINCT remote_jid) as cnt
    FROM customer_funnel
    WHERE created_at >= datetime('now', ?)
    GROUP BY stage
  `).all(cutoff);

  const countMap = {};
  for (const row of rows) {
    countMap[row.stage] = row.cnt;
  }

  const stages = FUNNEL_STAGES.map((stage, i) => {
    const count = countMap[stage] || 0;
    let conversionFromPrevious = null;
    if (i > 0) {
      const prevCount = countMap[FUNNEL_STAGES[i - 1]] || 0;
      conversionFromPrevious = prevCount > 0
        ? Math.round((count / prevCount) * 10000) / 100
        : 0;
    }
    return { stage, count, conversionFromPrevious };
  });

  return {
    stages,
    period: `last_${periodDays}_days`,
    generatedAt: new Date().toISOString(),
  };
}

/**
 * Get lead scoring accuracy -- how well lead temperature predicts actual bookings.
 * (ANAL-02)
 *
 * @param {number} periodDays - Number of days to look back (default 30)
 * @returns {{ hot: {total: number, converted: number, rate: number}, warm: {total: number, converted: number, rate: number}, cold: {total: number, converted: number, rate: number}, generatedAt: string }}
 */
function getLeadAccuracy(periodDays = 30) {
  const db = getDb();
  const cutoff = `-${periodDays} days`;

  const result = { hot: { total: 0, converted: 0, rate: 0 }, warm: { total: 0, converted: 0, rate: 0 }, cold: { total: 0, converted: 0, rate: 0 } };

  for (const temp of ['hot', 'warm', 'cold']) {
    // Total customers with this temperature
    const totalRow = db.prepare(`
      SELECT COUNT(*) as cnt FROM customer_profiles
      WHERE lead_temperature = ? AND updated_at >= datetime('now', ?)
    `).get(temp, cutoff);
    const total = totalRow ? totalRow.cnt : 0;

    // Of those, how many reached 'booked' or 'visited' in the funnel
    const convertedRow = db.prepare(`
      SELECT COUNT(DISTINCT cp.remote_jid) as cnt
      FROM customer_profiles cp
      INNER JOIN customer_funnel cf ON cp.remote_jid = cf.remote_jid
      WHERE cp.lead_temperature = ?
        AND cp.updated_at >= datetime('now', ?)
        AND cf.stage IN ('booked', 'visited')
        AND cf.created_at >= datetime('now', ?)
    `).get(temp, cutoff, cutoff);
    const converted = convertedRow ? convertedRow.cnt : 0;

    result[temp] = {
      total,
      converted,
      rate: total > 0 ? Math.round((converted / total) * 10000) / 100 : 0,
    };
  }

  result.generatedAt = new Date().toISOString();
  return result;
}

/**
 * Get template/campaign performance metrics.
 * (ANAL-03)
 *
 * @param {number} periodDays - Number of days to look back (default 30)
 * @returns {{ campaigns: Array<{campaign_type: string, template_name: string, total_sent: number, delivered: number, read: number, ignored: number, failed: number, suppressed: number, delivery_rate: number, read_rate: number}>, generatedAt: string }}
 */
function getTemplatePerformance(periodDays = 30) {
  const db = getDb();
  const cutoff = `-${periodDays} days`;

  const rows = db.prepare(`
    SELECT
      campaign_type,
      template_name,
      COUNT(*) as total,
      SUM(CASE WHEN status = 'sent' THEN 1 ELSE 0 END) as total_sent,
      SUM(CASE WHEN response_status = 'delivered' THEN 1 ELSE 0 END) as delivered,
      SUM(CASE WHEN response_status = 'read' THEN 1 ELSE 0 END) as read_count,
      SUM(CASE WHEN response_status = 'ignored' THEN 1 ELSE 0 END) as ignored,
      SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) as failed,
      SUM(CASE WHEN status = 'suppressed' THEN 1 ELSE 0 END) as suppressed
    FROM template_sends
    WHERE created_at >= datetime('now', ?)
    GROUP BY campaign_type, template_name
    ORDER BY total DESC
  `).all(cutoff);

  const campaigns = rows.map(row => {
    const totalSent = row.total_sent || 0;
    return {
      campaign_type: row.campaign_type,
      template_name: row.template_name,
      total_sent: totalSent,
      delivered: row.delivered || 0,
      read: row.read_count || 0,
      ignored: row.ignored || 0,
      failed: row.failed || 0,
      suppressed: row.suppressed || 0,
      delivery_rate: totalSent > 0 ? Math.round(((row.delivered || 0) / totalSent) * 10000) / 100 : 0,
      read_rate: totalSent > 0 ? Math.round(((row.read_count || 0) / totalSent) * 10000) / 100 : 0,
    };
  });

  return {
    campaigns,
    generatedAt: new Date().toISOString(),
  };
}

/**
 * Get revenue attribution -- WhatsApp bookings vs walk-ins.
 * (ANAL-04)
 *
 * @param {number} periodDays - Number of days to look back (default 30)
 * @returns {{ whatsapp: {count: number, percentage: number}, walkin: {count: number, percentage: number}, total: number, period: string, generatedAt: string }}
 */
function getRevenueAttribution(periodDays = 30) {
  const db = getDb();
  const cutoff = `-${periodDays} days`;

  // Total bookings in period
  const totalRow = db.prepare(`
    SELECT COUNT(*) as cnt FROM bookings
    WHERE created_at >= datetime('now', ?) AND status = 'confirmed'
  `).get(cutoff);
  const total = totalRow ? totalRow.cnt : 0;

  // WhatsApp-originated bookings (remote_jid exists in customer_profiles)
  const waRow = db.prepare(`
    SELECT COUNT(*) as cnt FROM bookings b
    INNER JOIN customer_profiles cp ON b.remote_jid = cp.remote_jid
    WHERE b.created_at >= datetime('now', ?) AND b.status = 'confirmed'
  `).get(cutoff);
  const whatsappCount = waRow ? waRow.cnt : 0;

  const walkinCount = total - whatsappCount;

  return {
    whatsapp: {
      count: whatsappCount,
      percentage: total > 0 ? Math.round((whatsappCount / total) * 10000) / 100 : 0,
    },
    walkin: {
      count: walkinCount,
      percentage: total > 0 ? Math.round((walkinCount / total) * 10000) / 100 : 0,
    },
    total,
    period: `last_${periodDays}_days`,
    generatedAt: new Date().toISOString(),
  };
}

/**
 * Get viral/referral metrics.
 * (VIRAL-04)
 *
 * @returns {{ codes_generated: number, total_uses: number, redemptions: number, unique_referrers: number, unique_friends: number, conversion_rate: number, generatedAt: string }}
 */
function getViralMetrics() {
  const db = getDb();

  // Referral codes stats
  const codesRow = db.prepare(`
    SELECT COUNT(*) as codes_generated, COALESCE(SUM(uses), 0) as total_uses
    FROM referral_codes
  `).get();

  // Redemptions stats
  const redemptionsRow = db.prepare(`
    SELECT
      COUNT(*) as redemptions,
      COUNT(DISTINCT referrer_jid) as unique_referrers,
      COUNT(DISTINCT friend_jid) as unique_friends
    FROM referral_redemptions
  `).get();

  const codesGenerated = codesRow ? codesRow.codes_generated : 0;
  const totalUses = codesRow ? codesRow.total_uses : 0;
  const redemptions = redemptionsRow ? redemptionsRow.redemptions : 0;

  return {
    codes_generated: codesGenerated,
    total_uses: totalUses,
    redemptions,
    unique_referrers: redemptionsRow ? redemptionsRow.unique_referrers : 0,
    unique_friends: redemptionsRow ? redemptionsRow.unique_friends : 0,
    conversion_rate: codesGenerated > 0 ? Math.round((redemptions / codesGenerated) * 10000) / 100 : 0,
    generatedAt: new Date().toISOString(),
  };
}

/**
 * Get combined dashboard summary for WhatsApp reports.
 * Calls all 5 analytics functions and returns a combined object.
 *
 * @param {number} periodDays - Number of days to look back (default 30)
 * @returns {{ funnel: object, leadAccuracy: object, templatePerformance: object, revenueAttribution: object, viralMetrics: object, generatedAt: string }}
 */
function getDashboardSummary(periodDays = 30) {
  return {
    funnel: getFunnelMetrics(periodDays),
    leadAccuracy: getLeadAccuracy(periodDays),
    templatePerformance: getTemplatePerformance(periodDays),
    revenueAttribution: getRevenueAttribution(periodDays),
    viralMetrics: getViralMetrics(),
    generatedAt: new Date().toISOString(),
  };
}

module.exports = {
  getFunnelMetrics,
  getLeadAccuracy,
  getTemplatePerformance,
  getRevenueAttribution,
  getViralMetrics,
  getDashboardSummary,
};
