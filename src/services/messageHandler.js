const fs = require('fs');
const claudeService = require('./claudeService');
const config = require('../config');
const evolutionService = require('./evolutionService');
const conversationService = require('./conversationService');
const rateLimiter = require('./rateLimiter');
const googleCommandHandler = require('./googleCommandHandler');
const bookingService = require('./bookingService');
const racecontrolService = require('./racecontrolService');
const spamGuard = require('./spamGuard');
const { getCustomerContext, buildContextBlock } = require('./customerContextService');
const { buildSystemPrompt } = require('../prompts/systemPrompt');
const { buildAdminPrompt } = require('../prompts/adminPrompt');
const { enqueue } = require('../utils/queueManager');
const logger = require('../utils/logger');
const { handleRamuMessage } = require('./ramuStockHandler');

const HUMAN_HANDOFF_MARKER = '[HUMAN_HANDOFF]';
const BOOKING_MARKER = '[BOOKING]';
const RC_BOOKING_MARKER = '[RC_BOOKING]';
const REGISTRATION_MARKER = '[REGISTRATION]';
const ADMIN_JID = '917981264279@s.whatsapp.net';
const RAMU_JID  = '917981399100@s.whatsapp.net';  // Ramu Bhai — stock alerts, not a customer

// Direct mode: when enabled, admin messages are saved but not auto-replied
const DIRECT_MODE_FLAG = '/root/.bono-direct-mode';
function isDirectMode() {
  return fs.existsSync(DIRECT_MODE_FLAG);
}

// RaceControl core URL for registration page
const RACECONTROL_URL = process.env.RACECONTROL_URL || 'http://localhost:8080';

async function handleMessage(parsed) {
  const { remoteJid, text, pushName } = parsed;

  // Rate limit check
  if (rateLimiter.isRateLimited(remoteJid)) {
    return;
  }

  // Queue per user to serialize messages
  await enqueue(remoteJid, () => processMessage(remoteJid, text, pushName));
}

async function processMessage(remoteJid, text, pushName) {
  try {
    // ── Ramu Bhai — stock tracker bypass (not a RacingPoint customer) ────
    if (remoteJid === RAMU_JID) {
      await evolutionService.sendPresence(remoteJid, 'composing');
      const reply = handleRamuMessage(text);
      await evolutionService.sendText(remoteJid, reply);
      await evolutionService.sendPresence(remoteJid, 'paused');
      logger.info({ remoteJid, pushName }, 'Ramu stock query handled');
      return;
    }

    // Blocked user check — no response, no AI cost
    if (spamGuard.isBlocked(remoteJid)) {
      logger.info({ remoteJid }, 'Blocked user message ignored');
      return;
    }

    // Spam analysis — accumulates score, auto-blocks at threshold
    if (!googleCommandHandler.isAdmin(remoteJid)) {
      const spam = spamGuard.analyzeMessage(remoteJid, text);
      if (spam.shouldBlock) {
        spamGuard.blockUser(remoteJid, 'Auto-blocked: spam score exceeded threshold');
        await evolutionService.sendText(
          remoteJid,
          'This conversation has been ended due to repeated inappropriate or off-topic messages. If you believe this is a mistake, please contact us at +91 7981264279.'
        );
        // Notify admin
        const phone = remoteJid.replace('@s.whatsapp.net', '');
        await evolutionService.sendText(
          ADMIN_JID,
          `🚫 *Auto-blocked:* ${pushName || 'Unknown'} (${phone})\n*Reason:* Spam score ${spam.score}/${5}\n*Last message:* "${text.substring(0, 100)}"`
        );
        logger.warn({ remoteJid, pushName, score: spam.score }, 'User auto-blocked by spam guard');
        return;
      }
    }

    // Handle "reset" command
    if (text.toLowerCase() === 'reset') {
      conversationService.clearHistory(remoteJid);
      await evolutionService.sendText(remoteJid, 'Conversation cleared! How can I help you? 😊');
      return;
    }

    // Direct mode: admin messages saved, wait 2min for Bono CLI reply, then fallback to AI
    if (isDirectMode() && googleCommandHandler.isAdmin(remoteJid)) {
      conversationService.saveMessage(remoteJid, 'user', text);
      logger.info({ remoteJid, pushName, textLength: text.length }, 'Direct mode: admin message saved, waiting for Bono CLI reply');

      // Fallback: if no reply sent within 2 minutes, auto-reply via AI
      const savedAt = Date.now();
      setTimeout(async () => {
        try {
          // Check if a reply was already sent after this message
          const recent = conversationService.getHistory(remoteJid);
          const lastMsg = recent.length > 0 ? recent[recent.length - 1] : null;
          if (lastMsg && lastMsg.role === 'assistant' && new Date(lastMsg.created_at).getTime() > savedAt) {
            logger.info({ remoteJid }, 'Direct mode: Bono already replied, skipping fallback');
            return;
          }

          logger.info({ remoteJid }, 'Direct mode: no reply after 15s, falling back to AI');
          const history = conversationService.getHistory(remoteJid);
          const systemPrompt = buildAdminPrompt();
          const conversationMessages = history.map(msg => ({ role: msg.role, content: msg.content }));
          const reply = await claudeService.chat(systemPrompt, conversationMessages, { model: config.claude.adminModel });

          conversationService.saveMessage(remoteJid, 'assistant', reply);
          await evolutionService.sendText(remoteJid, reply);
          logger.info({ remoteJid, replyLength: reply.length }, 'Direct mode: fallback AI reply sent');
        } catch (err) {
          logger.error({ err, remoteJid }, 'Direct mode: fallback reply failed');
        }
      }, 15 * 1000);

      return;
    }

    // Check for Google commands
    const googleCmd = googleCommandHandler.tryGoogleCommand(text);
    if (googleCmd) {
      if (!googleCommandHandler.isAdmin(remoteJid)) {
        await evolutionService.sendText(remoteJid, 'Sorry, Google commands are only available to admins.');
        return;
      }

      await evolutionService.sendPresence(remoteJid, 'composing');
      const result = await googleCommandHandler.executeGoogleCommand(googleCmd, remoteJid);
      conversationService.saveMessage(remoteJid, 'user', text);
      conversationService.saveMessage(remoteJid, 'assistant', result);
      await evolutionService.sendText(remoteJid, result);
      await evolutionService.sendPresence(remoteJid, 'paused');
      logger.info({ remoteJid, command: googleCmd.command }, 'Google command executed');
      return;
    }

    // Send "composing" presence
    await evolutionService.sendPresence(remoteJid, 'composing');

    // Load conversation history
    const history = conversationService.getHistory(remoteJid);

    // Build messages with customer context enrichment
    const isAdmin = googleCommandHandler.isAdmin(remoteJid);
    let systemPrompt;
    if (isAdmin) {
      systemPrompt = buildAdminPrompt();
    } else {
      // Enrich with customer data from RaceControl
      const ctx = getCustomerContext(remoteJid);
      const contextBlock = ctx ? buildContextBlock(ctx) : '';
      systemPrompt = buildSystemPrompt(contextBlock);
    }
    const conversationMessages = [
      ...history.map(msg => ({ role: msg.role, content: msg.content })),
      { role: 'user', content: text },
    ];

    // Get AI response
    const model = isAdmin ? config.claude.adminModel : config.claude.customerModel;
    const reply = await claudeService.chat(systemPrompt, conversationMessages, { model });

    // Check for RC booking tag (registered customers via RaceControl)
    if (reply.includes(RC_BOOKING_MARKER) && racecontrolService.isConfigured()) {
      const rcData = parseRcBookingTag(reply);
      if (rcData) {
        try {
          const result = await racecontrolService.bookSession(rcData.phone, rcData.tier_id, rcData.experience_id || null);

          let confirmationMsg;
          if (result.status === 'booked') {
            confirmationMsg =
              `Your session is booked! Here are the details:\n\n` +
              `*Name:* ${result.driver_name}\n` +
              `*Pod:* ${result.pod_number}\n` +
              `*PIN:* ${result.pin}\n` +
              `*Duration:* ${result.duration_minutes} minutes\n` +
              `*Plan:* ${result.tier_name}\n` +
              (result.wallet_debit_paise ? `*Debited:* ₹${result.wallet_debit_paise / 100}\n` : '') +
              `\nHead to your pod and enter the PIN on the lock screen. Enjoy your session!`;
          } else {
            // Booking failed — show reason
            confirmationMsg = result.message || 'Sorry, the booking could not be completed. Please visit reception for help.';
          }

          conversationService.saveMessage(remoteJid, 'user', text);
          conversationService.saveMessage(remoteJid, 'assistant', confirmationMsg);
          await evolutionService.sendText(remoteJid, confirmationMsg);
          await evolutionService.sendPresence(remoteJid, 'paused');
          logger.info({ remoteJid, bookingId: result.booking_id, status: result.status }, 'RC booking processed via WhatsApp');
          return;
        } catch (rcErr) {
          logger.error({ err: rcErr, remoteJid, rcData }, 'Failed to create RC booking');
          const errorMsg = "I'm sorry, there was an issue booking your session. Please try again, or contact us directly at +91 7981264279.";
          conversationService.saveMessage(remoteJid, 'user', text);
          conversationService.saveMessage(remoteJid, 'assistant', errorMsg);
          await evolutionService.sendText(remoteJid, errorMsg);
          await evolutionService.sendPresence(remoteJid, 'paused');
          return;
        }
      }
    }

    // Check for booking tag
    if (reply.includes(BOOKING_MARKER)) {
      const bookingData = parseBookingTag(reply);
      if (bookingData) {
        try {
          const result = await bookingService.createBooking({
            remoteJid,
            name: bookingData.name,
            phone: bookingData.phone,
            email: bookingData.email || null,
            bookingType: bookingData.type,
            date: bookingData.date,
            startTime: bookingData.start,
            endTime: bookingData.end,
          });

          const confirmationMsg =
            `Your booking is confirmed! Here are the details:\n\n` +
            `*Booking ID:* ${result.bookingId}\n` +
            `*Type:* ${bookingData.type}\n` +
            `*Date:* ${bookingData.date}\n` +
            `*Time:* ${bookingData.start} - ${bookingData.end}\n` +
            `*Name:* ${bookingData.name}\n` +
            `*Phone:* ${bookingData.phone}\n` +
            (bookingData.email ? `*Email:* ${bookingData.email}\n` : '') +
            `\nSee you at RacingPoint! For any changes, contact us at +91 7981264279.`;

          conversationService.saveMessage(remoteJid, 'user', text);
          conversationService.saveMessage(remoteJid, 'assistant', confirmationMsg);
          await evolutionService.sendText(remoteJid, confirmationMsg);
          await evolutionService.sendPresence(remoteJid, 'paused');
          logger.info({ remoteJid, bookingId: result.bookingId }, 'Booking created via WhatsApp');
          return;
        } catch (bookingErr) {
          logger.error({ err: bookingErr, remoteJid, bookingData }, 'Failed to create booking');
          const errorMsg = "I'm sorry, there was an issue creating your booking. Please try again, or contact us directly at +91 7981264279 for assistance.";
          conversationService.saveMessage(remoteJid, 'user', text);
          conversationService.saveMessage(remoteJid, 'assistant', errorMsg);
          await evolutionService.sendText(remoteJid, errorMsg);
          await evolutionService.sendPresence(remoteJid, 'paused');
          return;
        }
      }
    }

    // Check for registration tag
    if (reply.includes(REGISTRATION_MARKER)) {
      const regData = parseRegistrationTag(reply);
      if (regData) {
        try {
          // Extract phone from remoteJid (917981264279@s.whatsapp.net -> 7981264279)
          const jidPhone = remoteJid.replace('@s.whatsapp.net', '');
          const phone10 = jidPhone.length > 10 ? jidPhone.slice(-10) : jidPhone;

          // Save to local DB
          const db = require('../db/database').getDb();
          db.prepare(
            `INSERT INTO customers (remote_jid, full_name, phone, email, age, created_at)
             VALUES (?, ?, ?, ?, ?, datetime('now'))
             ON CONFLICT(remote_jid) DO UPDATE SET
               full_name = excluded.full_name,
               phone = excluded.phone,
               email = excluded.email,
               age = excluded.age`
          ).run(remoteJid, regData.name, regData.phone || phone10, regData.email || null, regData.age ? parseInt(regData.age) : null);

          // Send registration link
          const registerUrl = `${RACECONTROL_URL}/register`;
          const regMsg =
            `Great, ${regData.name}! To complete your registration and sign the liability waiver, please open this link:\n\n` +
            `${registerUrl}\n\n` +
            `You'll receive a verification code on this WhatsApp number. The process takes less than 2 minutes.\n\n` +
            (regData.age && parseInt(regData.age) < 18
              ? `Since you're under 18, a parent/guardian will need to provide their name during registration.\n\n`
              : '') +
            `Once registered, you're all set to race!`;

          conversationService.saveMessage(remoteJid, 'user', text);
          conversationService.saveMessage(remoteJid, 'assistant', regMsg);
          await evolutionService.sendText(remoteJid, regMsg);
          await evolutionService.sendPresence(remoteJid, 'paused');
          logger.info({ remoteJid, name: regData.name }, 'Registration initiated via WhatsApp');
          return;
        } catch (regErr) {
          logger.error({ err: regErr, remoteJid }, 'Failed to process registration');
          // Fall through to send the AI reply as-is
        }
      }
    }

    // Check for human handoff
    if (reply.includes(HUMAN_HANDOFF_MARKER)) {
      const handoffMsg = "I think it's best if our team helps you directly. Please contact us at +91 7981264279 — we'll be happy to assist!";
      conversationService.saveMessage(remoteJid, 'user', text);
      conversationService.saveMessage(remoteJid, 'assistant', handoffMsg);
      await evolutionService.sendText(remoteJid, handoffMsg);
      await evolutionService.sendPresence(remoteJid, 'paused');
      return;
    }

    // Save to history
    conversationService.saveMessage(remoteJid, 'user', text);
    conversationService.saveMessage(remoteJid, 'assistant', reply);

    // Send response
    await evolutionService.sendText(remoteJid, reply);
    await evolutionService.sendPresence(remoteJid, 'paused');

    logger.info({ remoteJid, pushName, textLength: text.length, replyLength: reply.length }, 'Message handled');
  } catch (err) {
    logger.error({ err, remoteJid }, 'Failed to process message');

    try {
      await evolutionService.sendText(
        remoteJid,
        "Sorry, I'm having a bit of trouble right now. Please try again in a moment, or contact us directly at +91 7981264279."
      );
    } catch (sendErr) {
      logger.error({ err: sendErr, remoteJid }, 'Failed to send error message');
    }
  }
}

function parseRcBookingTag(text) {
  const match = text.match(/\[RC_BOOKING\]\s*(.+)/);
  if (!match) return null;

  const parts = match[1].split('|').map(p => p.trim());
  const data = {};
  for (const part of parts) {
    const [key, ...valueParts] = part.split('=');
    data[key.trim()] = valueParts.join('=').trim();
  }

  if (!data.phone || !data.tier_id) {
    return null;
  }

  return data;
}

function parseBookingTag(text) {
  const match = text.match(/\[BOOKING\]\s*(.+)/);
  if (!match) return null;

  const parts = match[1].split('|').map(p => p.trim());
  const data = {};
  for (const part of parts) {
    const [key, ...valueParts] = part.split('=');
    data[key.trim()] = valueParts.join('=').trim();
  }

  if (!data.type || !data.date || !data.start || !data.end || !data.name || !data.phone) {
    return null;
  }

  return data;
}

function parseRegistrationTag(text) {
  const match = text.match(/\[REGISTRATION\]\s*(.+)/);
  if (!match) return null;

  const parts = match[1].split('|').map(p => p.trim());
  const data = {};
  for (const part of parts) {
    const [key, ...valueParts] = part.split('=');
    data[key.trim()] = valueParts.join('=').trim();
  }

  if (!data.name) return null;
  return data;
}

module.exports = { handleMessage };
