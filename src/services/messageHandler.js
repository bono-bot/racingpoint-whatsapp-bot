const fs = require('fs');
const claudeService = require('./claudeService');
const config = require('../config');
const evolutionService = require('./evolutionService');
const conversationService = require('./conversationService');
const rateLimiter = require('./rateLimiter');
const googleCommandHandler = require('./googleCommandHandler');
const bookingService = require('./bookingService');
const { buildSystemPrompt } = require('../prompts/systemPrompt');
const { buildAdminPrompt } = require('../prompts/adminPrompt');
const { enqueue } = require('../utils/queueManager');
const logger = require('../utils/logger');

const HUMAN_HANDOFF_MARKER = '[HUMAN_HANDOFF]';
const BOOKING_MARKER = '[BOOKING]';
const REGISTRATION_MARKER = '[REGISTRATION]';

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

          logger.info({ remoteJid }, 'Direct mode: no reply after 2min, falling back to AI');
          const history = conversationService.getHistory(remoteJid);
          const systemPrompt = buildAdminPrompt();
          const messages = [
            { role: 'system', content: systemPrompt },
            ...history.map(msg => ({ role: msg.role, content: msg.content })),
          ];
          const model = config.claude.adminModel;
          const reply = await claudeService.chat(messages, { model });

          conversationService.saveMessage(remoteJid, 'assistant', reply);
          await evolutionService.sendText(remoteJid, reply);
          logger.info({ remoteJid, replyLength: reply.length }, 'Direct mode: fallback AI reply sent');
        } catch (err) {
          logger.error({ err, remoteJid }, 'Direct mode: fallback reply failed');
        }
      }, 2 * 60 * 1000);

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

    // Build messages array for Ollama
    const isAdmin = googleCommandHandler.isAdmin(remoteJid);
    const systemPrompt = isAdmin ? buildAdminPrompt() : buildSystemPrompt();
    const messages = [
      { role: 'system', content: systemPrompt },
      ...history.map(msg => ({ role: msg.role, content: msg.content })),
      { role: 'user', content: text },
    ];

    // Get AI response
    const model = isAdmin ? config.claude.adminModel : config.claude.customerModel;
    const reply = await claudeService.chat(messages, { model });

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
