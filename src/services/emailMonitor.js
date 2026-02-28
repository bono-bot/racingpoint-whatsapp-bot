const { gmail } = require('@racingpoint/google');
const { getGoogleAuth } = require('./googleAuth');
const ollamaService = require('./ollamaService');
const { buildAdminPrompt } = require('../prompts/adminPrompt');
const conversationService = require('./conversationService');
const logger = require('../utils/logger');

const POLL_INTERVAL = 60 * 1000; // Check every 60 seconds
const OWNER_EMAIL = 'usingh@racingpoint.in';
const BOT_EMAIL = 'bono@racingpoint.in';
const CONVERSATION_ID = `email:${OWNER_EMAIL}`;

let lastCheckedAt = null;
let polling = false;

async function processEmail(email) {
  try {
    const userMessage = email.subject
      ? `[Subject: ${email.subject}]\n\n${email.body}`
      : email.body;

    // Load conversation history for email thread
    const history = conversationService.getHistory(CONVERSATION_ID);

    const messages = [
      { role: 'system', content: buildAdminPrompt() },
      ...history.map(msg => ({ role: msg.role, content: msg.content })),
      { role: 'user', content: userMessage },
    ];

    const reply = await ollamaService.chat(messages);

    // Save to conversation history
    conversationService.saveMessage(CONVERSATION_ID, 'user', userMessage);
    conversationService.saveMessage(CONVERSATION_ID, 'assistant', reply);

    // Reply via email
    const auth = getGoogleAuth();
    const reSubject = email.subject?.startsWith('Re:')
      ? email.subject
      : `Re: ${email.subject || 'Your message'}`;

    await gmail.sendEmail({
      auth,
      to: OWNER_EMAIL,
      subject: reSubject,
      body: reply,
    });

    logger.info({
      emailId: email.id,
      subject: email.subject,
      replyLength: reply.length,
    }, 'Email prompt processed and replied');
  } catch (err) {
    logger.error({ err, emailId: email.id }, 'Failed to process email prompt');
  }
}

async function checkInbox() {
  if (polling) return;
  polling = true;

  try {
    const auth = getGoogleAuth();

    // Search for unread emails from the owner
    const query = `from:${OWNER_EMAIL} is:unread`;
    const emails = await gmail.listInbox({ auth, maxResults: 5, query });

    if (emails.length === 0) {
      polling = false;
      return;
    }

    for (const emailSummary of emails) {
      // Read the full email
      const email = await gmail.readEmail({ auth, messageId: emailSummary.id });

      // Process as a prompt
      await processEmail(email);

      // Mark as read
      await gmail.markAsRead({ auth, messageId: email.id });
    }

    logger.info({ count: emails.length }, 'Processed email prompts');
  } catch (err) {
    logger.error({ err }, 'Email monitor check failed');
  }

  polling = false;
}

let intervalId = null;

function start() {
  logger.info({ interval: POLL_INTERVAL }, 'Email monitor started');
  // Initial check after 10 seconds (let the bot fully start)
  setTimeout(() => checkInbox(), 10000);
  intervalId = setInterval(checkInbox, POLL_INTERVAL);
}

function stop() {
  if (intervalId) {
    clearInterval(intervalId);
    intervalId = null;
    logger.info('Email monitor stopped');
  }
}

module.exports = { start, stop };
