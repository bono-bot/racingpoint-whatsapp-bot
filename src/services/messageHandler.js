const ollamaService = require('./ollamaService');
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
    const reply = await ollamaService.chat(messages);

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

module.exports = { handleMessage };
