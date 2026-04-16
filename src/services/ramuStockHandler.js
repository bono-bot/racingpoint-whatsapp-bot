/**
 * Ramu Bhai Stock Handler
 * Handles all incoming WhatsApp messages from Ramu's number.
 * Completely separate from RacingPoint customer logic.
 *
 * Reads live top-2 OI state from /tmp/ramu_top2.json (written by oi_alert.py every 30s)
 */

const fs = require('fs');

const STATE_FILE = '/tmp/ramu_top2.json';
const MARKET_OPEN_HOUR  = 9;
const MARKET_OPEN_MIN   = 15;
const MARKET_CLOSE_HOUR = 15;
const MARKET_CLOSE_MIN  = 30;

function isMarketOpen() {
  const now = new Date();
  const day = now.getDay(); // 0=Sun, 6=Sat
  if (day === 0 || day === 6) return false;
  const mins = now.getHours() * 60 + now.getMinutes();
  const open  = MARKET_OPEN_HOUR  * 60 + MARKET_OPEN_MIN;
  const close = MARKET_CLOSE_HOUR * 60 + MARKET_CLOSE_MIN;
  return mins >= open && mins <= close;
}

function readState() {
  try {
    if (!fs.existsSync(STATE_FILE)) return null;
    const raw = fs.readFileSync(STATE_FILE, 'utf8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function formatStock(s, idx) {
  return (
    `#${idx} *${s.symbol}* — ${s.change_oi_pct.toFixed(2)}% ΔOI\n` +
    `   Chg OI: ${s.change_oi.toLocaleString('en-IN')}`
  );
}

function buildReply(state) {
  const time = state.updated_at || '—';
  const stocks = state.top2 || [];

  let msg = `📊 *Live OI Top 2* — ${time}\n━━━━━━━━━━━━━━━━━━━\n`;
  stocks.forEach((s, i) => {
    msg += formatStock(s, i + 1);
    if (i < stocks.length - 1) msg += '\n─────────────────\n';
  });
  msg += '\n━━━━━━━━━━━━━━━━━━━';
  msg += '\n_Step 1: Top 10 by Change in OI → Step 2: Top 2 by ΔOI%_';
  return msg;
}

/**
 * Main handler — called when any message arrives from Ramu's number.
 * Returns the reply string to send back.
 */
function handleRamuMessage(text) {
  const lower = text.trim().toLowerCase();

  // Help / greeting
  if (['hi', 'hello', 'hey', 'help'].includes(lower)) {
    return (
      `Hey Ramu Bhai! 👋\n\n` +
      `I track *NSE F&O OI* data live for you.\n\n` +
      `Commands:\n` +
      `• *update* — live top 2 stocks right now\n` +
      `• *top2* — same as update\n` +
      `• *status* — market open/closed?\n` +
      `\nYou also get:\n` +
      `📌 Opening alert at 9:15 AM\n` +
      `🔄 Alert when top 2 changes\n` +
      `📊 EOD virtual trade report at 3:20 PM`
    );
  }

  // Market status
  if (lower === 'status') {
    const open = isMarketOpen();
    const state = readState();
    if (open && state) {
      return `✅ Market is *OPEN*\nLast data: ${state.updated_at}`;
    } else if (open) {
      return `✅ Market is *OPEN* but data not yet loaded. Try again in 30s.`;
    } else {
      return `🔴 Market is *CLOSED*\nOpens Mon–Fri at 9:15 AM IST`;
    }
  }

  // Stock update — any message asking for data
  const updateTriggers = ['update', 'top2', 'stocks', 'oi', 'data', 'send', 'show', 'give', 'what', '?'];
  const wantsUpdate = updateTriggers.some(t => lower.includes(t)) || lower.length < 10;

  if (wantsUpdate) {
    if (!isMarketOpen()) {
      return `🔴 Market is closed right now.\nData updates resume Monday–Friday at 9:15 AM.\n\nType *help* for all commands.`;
    }

    const state = readState();
    if (!state || !state.top2 || state.top2.length === 0) {
      return `⏳ Fetching live data... Try again in 30 seconds.\n(Data refreshes every 30s during market hours)`;
    }

    return buildReply(state);
  }

  // Fallback — any other message
  return `Send *update* for live top 2 stocks, or *help* for all commands.`;
}

module.exports = { handleRamuMessage };
