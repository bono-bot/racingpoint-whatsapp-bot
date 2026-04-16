const logger = require('../utils/logger');

// ── Constants ──
const ADMIN_JID = '917981264279@s.whatsapp.net';
const RC_API_URL = process.env.RACECONTROL_URL || 'http://localhost:8080';
const RC_TERMINAL_SECRET = process.env.RC_TERMINAL_SECRET || 'rp-terminal-2026';
const MESH_CHECK_INTERVAL = 60 * 1000; // 1 minute for time checks
const MESH_POLL_INTERVAL = 5 * 60 * 1000; // 5 minutes for mesh data poll
const BUDGET_THRESHOLD = 0.85; // 85% of daily limit

// ── Lazy-load dependencies (avoid circular deps) ──
let evoService = null;
function getEvoService() {
  if (!evoService) { evoService = require('./evolutionService'); }
  return evoService;
}

let analyticsService = null;
function getAnalyticsService() {
  if (!analyticsService) { analyticsService = require('./analyticsService'); }
  return analyticsService;
}

// ── Pending escalation state (MESH-05) ──
let pendingEscalation = null;

// ── Timer state ──
let timeCheckInterval = null;
let meshPollInterval = null;
let morningReportDate = null; // YYYY-MM-DD of last morning report
let weeklySummaryDate = null; // YYYY-MM-DD of last weekly summary

// ── IST time helper ──
function getISTDate() {
  return new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
}

function formatISTDate(date) {
  const d = date || getISTDate();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

// ── Mesh data fetch (MESH-08) ──

/**
 * Fetch customer-brief from RaceControl mesh API.
 * Returns pod availability summary or null on error.
 */
async function fetchMeshCustomerBrief() {
  try {
    const res = await fetch(`${RC_API_URL}/api/v1/mesh/customer-brief`, {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json',
        'x-terminal-secret': RC_TERMINAL_SECRET,
      },
      signal: AbortSignal.timeout(10000),
    });

    if (res.status === 404) {
      logger.warn('Mesh customer-brief endpoint not found (404) -- may not be deployed yet');
      return null;
    }

    if (!res.ok) {
      logger.warn({ status: res.status }, 'Mesh customer-brief fetch failed');
      return null;
    }

    return await res.json();
  } catch (err) {
    logger.warn({ err: err.message }, 'Failed to fetch mesh customer-brief');
    return null;
  }
}

/**
 * Fetch staff-brief from RaceControl mesh API.
 * Returns fleet summary (pod count, issues, budget) or null on error.
 */
async function fetchMeshStaffBrief() {
  try {
    const res = await fetch(`${RC_API_URL}/api/v1/mesh/staff-brief`, {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json',
        'x-terminal-secret': RC_TERMINAL_SECRET,
      },
      signal: AbortSignal.timeout(10000),
    });

    if (res.status === 404) {
      logger.warn('Mesh staff-brief endpoint not found (404) -- may not be deployed yet');
      return null;
    }

    if (!res.ok) {
      logger.warn({ status: res.status }, 'Mesh staff-brief fetch failed');
      return null;
    }

    return await res.json();
  } catch (err) {
    logger.warn({ err: err.message }, 'Failed to fetch mesh staff-brief');
    return null;
  }
}

// ── Alert functions ──

/**
 * Send morning report to Uday at 6 AM IST. (MESH-04)
 * Combines fleet status from RaceControl + bot analytics from last 24h.
 */
async function sendMorningReport() {
  try {
    const now = getISTDate();
    const dateStr = formatISTDate(now);

    // Fetch mesh data (graceful -- null if unavailable)
    const staffBrief = await fetchMeshStaffBrief();

    // Get bot analytics for last 24 hours
    let analytics = null;
    try {
      analytics = getAnalyticsService().getDashboardSummary(1);
    } catch (err) {
      logger.warn({ err: err.message }, 'Analytics unavailable for morning report');
    }

    // Build fleet section
    let fleetLine = '*Fleet:* Data unavailable';
    let overnightLine = '*Overnight:* Data unavailable';
    let budgetLine = '*AI Budget:* Data unavailable';

    if (staffBrief) {
      const available = staffBrief.pods_available || staffBrief.available || 0;
      const total = staffBrief.pods_total || staffBrief.total || 8;
      fleetLine = `*Fleet:* ${available}/${total} pods ready`;

      const issuesResolved = staffBrief.issues_resolved_today || staffBrief.issues_resolved || 0;
      overnightLine = `*Overnight:* ${issuesResolved} issues auto-fixed`;

      const spent = staffBrief.ai_budget_spent || staffBrief.budget_spent || 0;
      const limit = staffBrief.ai_budget_limit || staffBrief.budget_limit || 80;
      budgetLine = `*AI Budget:* Rs ${spent}/${limit} today`;
    }

    // Build bot stats section
    let botStats = '*Yesterday\'s Bot Stats:*\nData unavailable';
    if (analytics) {
      const funnel = analytics.funnel;
      const revenue = analytics.revenueAttribution;

      const inquiryStage = funnel.stages.find(s => s.stage === 'inquiry');
      const bookedStage = funnel.stages.find(s => s.stage === 'booked');
      const conversations = inquiryStage ? inquiryStage.count : 0;
      const bookings = revenue ? revenue.whatsapp.count : 0;
      const convRate = conversations > 0
        ? Math.round((bookings / conversations) * 100)
        : 0;

      botStats = [
        '*Yesterday\'s Bot Stats:*',
        `Conversations: ${conversations}`,
        `Bookings via WhatsApp: ${bookings}`,
        `Lead conversion: ${convRate}%`,
      ].join('\n');
    }

    const text = [
      '*Racing Point - Morning Report*',
      `Date: ${dateStr}`,
      '',
      fleetLine,
      overnightLine,
      budgetLine,
      '',
      botStats,
    ].join('\n');

    await getEvoService().sendText(ADMIN_JID, text);
    morningReportDate = dateStr;
    logger.info('Morning report sent to Uday');
  } catch (err) {
    logger.error({ err }, 'Failed to send morning report');
  }
}

/**
 * Send budget warning when pod AI spend exceeds threshold. (MESH-06)
 *
 * @param {{ pod_id: string|number, spent: number, limit: number }} budgetData
 */
async function sendBudgetWarning(budgetData) {
  try {
    const { pod_id, spent, limit } = budgetData;
    const pct = limit > 0 ? Math.round((spent / limit) * 100) : 0;
    const text = `*Budget Alert* Pod ${pod_id}: Rs ${spent}/${limit} (${pct}%) daily AI budget used`;

    await getEvoService().sendText(ADMIN_JID, text);
    logger.info({ pod_id, pct }, 'Budget warning sent');
  } catch (err) {
    logger.error({ err }, 'Failed to send budget warning');
  }
}

/**
 * Send Tier 5 escalation alert with action options. (MESH-05)
 *
 * @param {{ pod_id: string|number, description: string, duration: string }} escalation
 */
async function sendEscalationAlert(escalation) {
  try {
    const { pod_id, description, duration } = escalation;

    // Try interactive buttons first, with text fallback
    const options = {
      title: 'ESCALATION - Tier 5',
      description: [
        `Pod: ${pod_id}`,
        `Issue: ${description}`,
        `Since: ${duration || 'unknown'}`,
        '',
        'Choose an action:',
      ].join('\n'),
      buttons: [
        { text: 'FIX', id: `esc_fix_${pod_id}` },
        { text: 'DISABLE', id: `esc_disable_${pod_id}` },
        { text: 'IGNORE', id: `esc_ignore_${pod_id}` },
      ],
    };

    try {
      await getEvoService().sendInteractive(ADMIN_JID, options);
    } catch (interactiveErr) {
      // Fallback to plain text if interactive fails
      const text = [
        '*ESCALATION - Tier 5*',
        `Pod: ${pod_id}`,
        `Issue: ${description}`,
        `Since: ${duration || 'unknown'}`,
        '',
        'Reply:',
        '1. FIX - attempt auto-fix',
        '2. DISABLE - take pod offline',
        '3. IGNORE - suppress for 24h',
      ].join('\n');
      await getEvoService().sendText(ADMIN_JID, text);
    }

    // Track pending escalation for response handling
    pendingEscalation = {
      pod_id: pod_id,
      issue_id: escalation.issue_id || `esc_${pod_id}_${Date.now()}`,
      sentAt: new Date(),
    };

    logger.info({ pod_id }, 'Escalation alert sent');
  } catch (err) {
    logger.error({ err }, 'Failed to send escalation alert');
  }
}

/**
 * Send weekly summary on Mondays at 9 AM IST. (MESH-07)
 * Combines 7-day analytics + current fleet status.
 */
async function sendWeeklySummary() {
  try {
    const now = getISTDate();
    const dateStr = formatISTDate(now);

    // Fetch current fleet status
    const staffBrief = await fetchMeshStaffBrief();

    // Get 7-day analytics
    let analytics = null;
    try {
      analytics = getAnalyticsService().getDashboardSummary(7);
    } catch (err) {
      logger.warn({ err: err.message }, 'Analytics unavailable for weekly summary');
    }

    // Fleet learning section
    let fleetSection = '*Fleet Learning:*\nData unavailable';
    if (staffBrief) {
      const newSolutions = staffBrief.new_solutions || staffBrief.solutions_discovered || 0;
      const falsePositives = staffBrief.false_positives_reduced || 0;
      const totalSpend = staffBrief.weekly_ai_spend || staffBrief.ai_budget_spent || 0;
      fleetSection = [
        '*Fleet Learning:*',
        `New solutions discovered: ${newSolutions}`,
        `False positives reduced: ${falsePositives}`,
        `Total AI spend: Rs ${totalSpend}`,
      ].join('\n');
    }

    // Bot performance section
    let botSection = '*Bot Performance:*\nData unavailable';
    if (analytics) {
      const funnel = analytics.funnel;
      const template = analytics.templatePerformance;
      const viral = analytics.viralMetrics;
      const revenue = analytics.revenueAttribution;

      const inquiryStage = funnel.stages.find(s => s.stage === 'inquiry');
      const bookedStage = funnel.stages.find(s => s.stage === 'booked');
      const inquiries = inquiryStage ? inquiryStage.count : 0;
      const booked = bookedStage ? bookedStage.count : 0;
      const funnelRate = inquiries > 0 ? Math.round((booked / inquiries) * 100) : 0;

      const totalSent = template.campaigns.reduce((sum, c) => sum + c.total_sent, 0);
      const totalRead = template.campaigns.reduce((sum, c) => sum + c.read, 0);
      const readRate = totalSent > 0 ? Math.round((totalRead / totalSent) * 100) : 0;

      botSection = [
        '*Bot Performance:*',
        `Funnel: ${inquiries} inquiries -> ${booked} bookings (${funnelRate}%)`,
        `Templates: ${totalSent} sent, ${readRate}% read rate`,
        `Referrals: ${viral.codes_generated} new, ${viral.redemptions} redeemed`,
        `Revenue via WhatsApp: ${revenue.whatsapp.count} bookings`,
      ].join('\n');
    }

    const text = [
      '*Weekly Fleet & Bot Summary*',
      `Week of ${dateStr}`,
      '',
      fleetSection,
      '',
      botSection,
    ].join('\n');

    await getEvoService().sendText(ADMIN_JID, text);
    weeklySummaryDate = dateStr;
    logger.info('Weekly summary sent to Uday');
  } catch (err) {
    logger.error({ err }, 'Failed to send weekly summary');
  }
}

// ── Timer management ──

/**
 * Start alert timers:
 * - Time check every 60s (morning report at 6AM IST, weekly at Monday 9AM IST)
 * - Mesh poll every 5 min (budget warnings, escalation alerts)
 */
function startAlertTimers() {
  if (timeCheckInterval) {
    logger.warn('Alert timers already running');
    return;
  }

  // Time-based check every minute
  timeCheckInterval = setInterval(async () => {
    try {
      const now = getISTDate();
      const hour = now.getHours();
      const minute = now.getMinutes();
      const dayOfWeek = now.getDay(); // 0=Sun, 1=Mon
      const todayStr = formatISTDate(now);

      // 6:00 AM IST -- morning report
      if (hour === 6 && minute === 0 && morningReportDate !== todayStr) {
        await sendMorningReport();
      }

      // Monday 9:00 AM IST -- weekly summary
      if (dayOfWeek === 1 && hour === 9 && minute === 0 && weeklySummaryDate !== todayStr) {
        await sendWeeklySummary();
      }
    } catch (err) {
      logger.error({ err }, 'Alert time check error');
    }
  }, MESH_CHECK_INTERVAL);

  // Mesh poll every 5 minutes
  meshPollInterval = setInterval(async () => {
    try {
      const staffBrief = await fetchMeshStaffBrief();
      if (!staffBrief) return;

      // Check for budget warnings
      const pods = staffBrief.pods || [];
      for (const pod of pods) {
        const spent = pod.ai_budget_spent || pod.budget_spent || 0;
        const limit = pod.ai_budget_limit || pod.budget_limit || 10;
        if (limit > 0 && (spent / limit) >= BUDGET_THRESHOLD) {
          await sendBudgetWarning({
            pod_id: pod.pod_id || pod.id,
            spent,
            limit,
          });
        }
      }

      // Check for Tier 5 escalations
      const escalations = staffBrief.escalations || staffBrief.tier5_escalations || [];
      for (const esc of escalations) {
        await sendEscalationAlert({
          pod_id: esc.pod_id || esc.id,
          description: esc.description || esc.issue || 'Unknown issue',
          duration: esc.duration || esc.since || 'unknown',
        });
      }
    } catch (err) {
      logger.error({ err }, 'Mesh poll error');
    }
  }, MESH_POLL_INTERVAL);

  logger.info('Staff alert timers started (time check: 60s, mesh poll: 5min)');
}

/**
 * Stop all alert timers.
 */
function stopAlertTimers() {
  if (timeCheckInterval) {
    clearInterval(timeCheckInterval);
    timeCheckInterval = null;
  }
  if (meshPollInterval) {
    clearInterval(meshPollInterval);
    meshPollInterval = null;
  }
  logger.info('Staff alert timers stopped');
}

/**
 * Get pending escalation if still valid (< 1 hour old).
 * Returns { pod_id, issue_id, sentAt } or null.
 */
function getPendingEscalation() {
  if (!pendingEscalation) return null;
  const ageMs = Date.now() - pendingEscalation.sentAt.getTime();
  if (ageMs > 60 * 60 * 1000) {
    // Expired after 1 hour
    pendingEscalation = null;
    return null;
  }
  return pendingEscalation;
}

/**
 * Clear pending escalation after it's been handled.
 */
function clearPendingEscalation() {
  pendingEscalation = null;
}

module.exports = {
  fetchMeshCustomerBrief,
  fetchMeshStaffBrief,
  sendMorningReport,
  sendBudgetWarning,
  sendEscalationAlert,
  sendWeeklySummary,
  startAlertTimers,
  stopAlertTimers,
  getPendingEscalation,
  clearPendingEscalation,
};
