const fs = require('fs');
const claudeService = require('./claudeService');
const config = require('../config');
const evolutionService = require('./evolutionService');
const conversationService = require('./conversationService');
const rateLimiter = require('./rateLimiter');
const googleCommandHandler = require('./googleCommandHandler');
const spamGuard = require('./spamGuard');
const { getCustomerContext, buildContextBlock } = require('./customerContextService');
const { buildSystemPrompt } = require('../prompts/systemPrompt');
const { buildAdminPrompt } = require('../prompts/adminPrompt');
const { enqueue } = require('../utils/queueManager');
const logger = require('../utils/logger');
const { handleRamuMessage } = require('./ramuStockHandler');
const handoffService = require('./handoffService');
const { getCachedPods, getCachedBookingCount } = require('./rcCacheService');
const { isVenueOpen, getVenueStatusMessage } = require('./istTimeService');
const { isVenueClosed, getClosureMessage, getClosureContextForPrompt } = require('./venueStatusService');
const { BookingFlow, GroupBookingFlow, RegistrationFlow, FeedbackFlow } = require('./flowHandlers');
const { isVPSReachable, GRACEFUL_DEGRADATION_MSG } = require('./vpsBookingService');
const { classifyIntent, scoreLeadTemperature, updateFunnel, detectFunnelAdvance } = require('./intelligenceService');
const { getOrCreateProfile, updateProfile, buildIntelligenceContext, eraseCustomerData } = require('./customerProfileService');
const { scheduleFollowUp, updateLastMessageTime, handleOptInResponse, isOptedIn, buildFomoLine } = require('./followUpService');
const { getCafeMenu, getCafeSpecials, getContextualCafeRecommendation, parseCafeInput } = require('./cafeService');

// ── Lazy-loaded services (VIRAL-01, VIRAL-02) ──
let _referralService = null;
function getReferralService() {
  if (!_referralService) _referralService = require('./referralService');
  return _referralService;
}
let _lapTimeCardService = null;
function getLapTimeCardService() {
  if (!_lapTimeCardService) _lapTimeCardService = require('./lapTimeCardService');
  return _lapTimeCardService;
}
let _staffAlertService = null;
function getStaffAlertService() {
  if (!_staffAlertService) _staffAlertService = require('./staffAlertService');
  return _staffAlertService;
}

const HUMAN_HANDOFF_MARKER = '[HUMAN_HANDOFF]';
const ADMIN_JID = '917981264279@s.whatsapp.net';
const RAMU_JID  = '917981399100@s.whatsapp.net';

// In-memory flow state — NO booking state in SQLite/KV (VPS is sole authority)
// Map<remoteJid, { flow: FlowHandler, step: string, data: object, startedAt: number }>
const activeFlows = new Map();
const FLOW_TIMEOUT_MS = 10 * 60 * 1000; // 10 min timeout for abandoned flows

// In-memory cafe browsing state — Map<remoteJid, { inCafeMenu: boolean, lastCafeAt: number }>
const cafeState = new Map();
const CAFE_TIMEOUT_MS = 5 * 60 * 1000; // 5 min timeout for cafe browsing

// ── First-message sizzle greeting (SIZZLE-01 + FIX-03) ──
const SIZZLE_GREETING = [
  "Hey! Welcome to *RacingPoint eSports & Cafe* — Hyderabad's top sim racing spot!",
  "",
  "8 professional racing rigs with triple monitors, force feedback wheels, and the most realistic sim racing experience in the city.",
  "",
  "Free 5-min trial for first-timers!",
  "",
  "_This is an automated assistant. Say *human* anytime to reach our team!_",
  "",
  "_We store chat data to personalize your experience (per DPDP Act 2023). Reply *YES* to consent, or *STOP* to opt out anytime. Privacy: racingpoint.cloud/privacy_",
].join('\n');

// ── Qualify-first pricing intercept (CONV-04) ──
const PRICING_PATTERNS = [
  /\b(how much|price|cost|rate|charges?|fees?|pricing|per hour|per session)\b/i,
  /\b(what.*cost|what.*price|what.*rate|what.*charge)\b/i,
  /\bkitna\b/i,           // Hindi: "how much"
  /\brate\s*card\b/i,
];

const QUALIFYING_QUESTIONS = [
  "Great question! To give you the best pricing, quick question \u2014 is this for yourself or a group?",
  "Happy to help with pricing! Are you a first-timer or have you raced with us before?",
  "Sure! To suggest the right package \u2014 how many people and what's the occasion?",
];

// ── Non-text message replies (FIX-02) ──
const NON_TEXT_REPLIES = {
  image: "Nice pic! If you're sharing something about RacingPoint, I'd love to help. Looking to book a session?",
  video: "Cool video! How can I help you with RacingPoint today?",
  audio: "Got your voice note! Can you type your question? It's easier for me to help you book a session!",
  document: "Got your file! What can I help you with? Looking to book a sim racing session?",
  location: "Thanks for sharing your location! We're at Vantage Line Mall, 3rd Floor, Kalimandir, Hyderabad. Need directions or want to book?",
  sticker: "What can I help you with at RacingPoint today?",
  contacts: "Got your contact! How can I help you with RacingPoint?",
};

// Direct mode: when enabled, admin messages are saved but not auto-replied
const DIRECT_MODE_FLAG = '/root/.bono-direct-mode';
function isDirectMode() {
  return fs.existsSync(DIRECT_MODE_FLAG);
}

async function handleMessage(parsed) {
  const { remoteJid, text, pushName, messageType } = parsed;

  // Rate limit check
  if (rateLimiter.isRateLimited(remoteJid)) {
    return;
  }

  // Queue per user to serialize messages
  await enqueue(remoteJid, () => processMessage(remoteJid, text, pushName, messageType || 'text'));
}

async function processMessage(remoteJid, text, pushName, messageType) {
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

    // ── Escalation response handler (MESH-05) ──
    // If Uday replies with FIX/DISABLE/IGNORE (or 1/2/3), route to RaceControl
    if (remoteJid === ADMIN_JID && text) {
      const escalationResult = await handleEscalationResponse(text);
      if (escalationResult) {
        return;
      }
    }

    // Blocked user check — no response, no AI cost
    if (spamGuard.isBlocked(remoteJid)) {
      logger.info({ remoteJid }, 'Blocked user message ignored');
      return;
    }

    // ── Venue closure intercept — before ANY AI/intelligence processing ──
    if (isVenueClosed() && !googleCommandHandler.isAdmin(remoteJid)) {
      const closureMsg = getClosureMessage();
      conversationService.saveMessage(remoteJid, 'user', text);
      conversationService.saveMessage(remoteJid, 'assistant', closureMsg);
      await evolutionService.sendText(remoteJid, closureMsg);
      await evolutionService.sendPresence(remoteJid, 'paused');
      logger.info({ remoteJid, pushName, reason: 'venue_closed' }, 'Venue closure message sent');
      return;
    }

    // Spam analysis — accumulates score, auto-blocks at threshold
    if (!googleCommandHandler.isAdmin(remoteJid)) {
      const spam = spamGuard.analyzeMessage(remoteJid, text || '');
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
          `🚫 *Auto-blocked:* ${pushName || 'Unknown'} (${phone})\n*Reason:* Spam score ${spam.score}/${5}\n*Last message:* "${(text || '').substring(0, 100)}"`
        );
        logger.warn({ remoteJid, pushName, score: spam.score }, 'User auto-blocked by spam guard');
        return;
      }
    }


    // ── Ownership gate: if human is active, bot stays silent ──────────
    if (!handoffService.isBotActive(remoteJid) && !googleCommandHandler.isAdmin(remoteJid)) {
      logger.info({ remoteJid, pushName }, 'Bot silent — human_active ownership');
      // Still save the message so human sees context in conversation history
      conversationService.saveMessage(remoteJid, 'user', text || `[${messageType}]`);
      return;
    }

    // ── Track last message time for 24h window (CONV-03) ──
    if (!googleCommandHandler.isAdmin(remoteJid)) {
      updateLastMessageTime(remoteJid);
    }

    // ── Non-text message handling (FIX-02) ──
    if (messageType !== 'text') {
      const nonTextReply = NON_TEXT_REPLIES[messageType] || `Got your ${messageType}! How can I help you with RacingPoint?`;
      await evolutionService.sendText(remoteJid, nonTextReply);
      logger.info({ remoteJid, pushName, messageType }, 'Non-text message handled');
      return;
    }

    // ── Opt-in/out response check (CONV-05) ──
    if (!googleCommandHandler.isAdmin(remoteJid) && text) {
      const wasOptResponse = handleOptInResponse(remoteJid, text);
      if (wasOptResponse) {
        const isOptOut = /^(no|nah|stop|no thanks|opt.?out|unsubscribe|delete.*(my|all).*data|delete everything)$/i.test(text);
      let confirmMsg;
      if (isOptOut) {
        // DPDP Right to Erasure — delete all stored personal data
        const deleted = eraseCustomerData(remoteJid);
        confirmMsg = `Your data has been deleted (${deleted} records removed). You won't receive any more messages. Just message anytime to start fresh!`;
        logger.info({ remoteJid, deleted }, 'DPDP: data erased on opt-out');
      } else {
        // Consent timestamp logged for audit trail
        const db = require('../db/database').getDb();
        try {
          db.prepare("INSERT OR REPLACE INTO customer_optins (remote_jid, opted_in, consent_text, consent_at) VALUES (?, 1, ?, datetime('now'))").run(remoteJid, text);
        } catch (e) { /* consent_text/consent_at columns may not exist yet */ }
        confirmMsg = "Awesome! You're opted in for deals, events, and cafe specials. You can say *stop* anytime to opt out.";
      }
        conversationService.saveMessage(remoteJid, 'user', text);
        conversationService.saveMessage(remoteJid, 'assistant', confirmMsg);
        await evolutionService.sendText(remoteJid, confirmMsg);
        await evolutionService.sendPresence(remoteJid, 'paused');
        logger.info({ remoteJid, optedIn: !/^(no|nah|stop)/i.test(text) }, 'Opt-in/out response handled');
        return;
      }
    }

    // ── Referral code detection (VIRAL-01) ──
    if (!googleCommandHandler.isAdmin(remoteJid) && text) {
      // Check if message looks like a referral code (8-char alphanumeric, no ambiguous chars)
      const referralMatch = text.match(/^([A-Z0-9]{8})$/i);
      if (referralMatch) {
        const refSvc = getReferralService();
        const result = refSvc.validateReferralCode(referralMatch[1].toUpperCase(), remoteJid);
        if (result.valid) {
          const redemption = refSvc.redeemReferralCode(referralMatch[1].toUpperCase(), remoteJid);
          if (redemption.success) {
            const reply = `Referral code applied! You get Rs ${redemption.friendCredit} wallet credit. Welcome to RacingPoint! Ready to book your first session?`;
            conversationService.saveMessage(remoteJid, 'user', text);
            conversationService.saveMessage(remoteJid, 'assistant', reply);
            await evolutionService.sendText(remoteJid, reply);
            await evolutionService.sendPresence(remoteJid, 'paused');
            logger.info({ remoteJid, code: referralMatch[1].toUpperCase() }, 'Referral code redeemed');
            return;
          }
        }
        // If code looks like referral but invalid, fall through to normal processing
      }

      // ── Referral stats request (VIRAL-01) ──
      if (/\b(my referral|referral code|refer a friend|share code)\b/i.test(text)) {
        const refSvc = getReferralService();
        const { code } = refSvc.generateReferralCode(remoteJid);
        const stats = refSvc.getReferralStats(remoteJid);
        let reply = `Your referral code: *${code}*\nShare with friends -- they get Rs 50, you get Rs 100 wallet credit!`;
        if (stats.totalReferrals > 0) {
          reply += `\n\nYou've referred ${stats.totalReferrals} friends and earned Rs ${stats.totalEarned}!`;
        }
        conversationService.saveMessage(remoteJid, 'user', text);
        conversationService.saveMessage(remoteJid, 'assistant', reply);
        await evolutionService.sendText(remoteJid, reply);
        await evolutionService.sendPresence(remoteJid, 'paused');
        logger.info({ remoteJid, code }, 'Referral code/stats served');
        return;
      }

      // ── Lap time card request (VIRAL-02) ──
      if (/\b(my lap time|lap card|session card|race card|my times|share my lap)\b/i.test(text)) {
        const lapSvc = getLapTimeCardService();
        const profile = getOrCreateProfile(remoteJid, pushName);
        const cardData = {
          customerName: profile?.push_name || 'Racer',
          game: 'Assetto Corsa',
          date: profile?.last_visit || new Date().toISOString().split('T')[0],
        };
        const refSvc = getReferralService();
        const { code } = refSvc.generateReferralCode(remoteJid);
        const shareMsg = lapSvc.buildShareMessage(cardData, code);
        conversationService.saveMessage(remoteJid, 'user', text);
        conversationService.saveMessage(remoteJid, 'assistant', shareMsg);
        await evolutionService.sendText(remoteJid, shareMsg);
        await evolutionService.sendPresence(remoteJid, 'paused');
        logger.info({ remoteJid }, 'Lap time card served');
        return;
      }
    }

    // ── Cafe menu browsing (CAFE-01, CAFE-03) ──
    if (!googleCommandHandler.isAdmin(remoteJid) && text) {
      // Check if user is already browsing cafe menu
      const existingCafe = cafeState.get(remoteJid);
      if (existingCafe && (Date.now() - existingCafe.lastCafeAt < CAFE_TIMEOUT_MS)) {
        // Category selection (1-4)
        const num = parseInt(text.trim());
        if (num >= 1 && num <= 4) {
          const categories = ['starters', 'burgers', 'drinks', 'desserts'];
          const menuReply = getCafeMenu(categories[num - 1]);
          conversationService.saveMessage(remoteJid, 'user', text);
          conversationService.saveMessage(remoteJid, 'assistant', menuReply);
          await evolutionService.sendText(remoteJid, menuReply);
          cafeState.set(remoteJid, { inCafeMenu: true, lastCafeAt: Date.now() });
          await evolutionService.sendPresence(remoteJid, 'paused');
          logger.info({ remoteJid, category: categories[num - 1] }, 'Cafe category browsed');
          return;
        }
        // "specials" while browsing
        const cafeInput = parseCafeInput(text);
        if (cafeInput && cafeInput.type === 'specials') {
          const specialsReply = getCafeSpecials();
          conversationService.saveMessage(remoteJid, 'user', text);
          conversationService.saveMessage(remoteJid, 'assistant', specialsReply);
          await evolutionService.sendText(remoteJid, specialsReply);
          await evolutionService.sendPresence(remoteJid, 'paused');
          return;
        }
        // Any other text exits cafe browsing
        cafeState.delete(remoteJid);
      }

      // Check for cafe trigger keywords
      const cafeInput = parseCafeInput(text);
      if (cafeInput && cafeInput.type === 'menu_root') {
        const menuReply = getCafeMenu();
        conversationService.saveMessage(remoteJid, 'user', text);
        conversationService.saveMessage(remoteJid, 'assistant', menuReply);
        await evolutionService.sendText(remoteJid, menuReply);
        cafeState.set(remoteJid, { inCafeMenu: true, lastCafeAt: Date.now() });
        await evolutionService.sendPresence(remoteJid, 'paused');
        logger.info({ remoteJid }, 'Cafe menu opened');
        return;
      }
    }

    // ── "Are you open?" IST-based response — BEFORE intelligence to save tokens (FIX-01) ──
    const openPatterns = [
      /\b(are you|you|is it|is the|is racing\s?point)\s*(open|closed|shut)\b/i,
      /\b(open|closed)\s*(now|today|right now|yet|already)\b/i,
      /\bwhat.*(time|hour).*open\b/i,
      /\bwhen.*open\b/i,
      /\boperating\s*hours?\b/i,
      /\btiming\b/i,
    ];
    if (openPatterns.some(p => p.test(text))) {
      const statusMsg = getVenueStatusMessage();
      conversationService.saveMessage(remoteJid, 'user', text);
      conversationService.saveMessage(remoteJid, 'assistant', statusMsg);
      await evolutionService.sendText(remoteJid, statusMsg);
      await evolutionService.sendPresence(remoteJid, 'paused');
      logger.info({ remoteJid, isOpen: isVenueOpen() }, 'Venue hours query answered (pre-intelligence)');
      return;
    }

    // ── Pod availability — BEFORE intelligence to save tokens (KAPSO-05, BOOK-03) ──
    const availabilityPatterns = [
      /\b(any|are|how many).*(rig|pod|sim|station|available|free|open)\b/i,
      /\b(rig|pod|sim|station).*(free|available|open)\b/i,
      /\bavailability\b/i,
    ];
    if (availabilityPatterns.some(p => p.test(text))) {
      const pods = getCachedPods();
      let availMsg;
      if (pods.unavailable) {
        availMsg = "I can't check availability right now. Please call +91 7981264279 or just walk in — we're at Vantage Line Mall, 3rd Floor!";
      } else if (pods.stale) {
        const d = pods.data;
        availMsg = `Last I checked, ${d.available} of ${d.total} rigs were free. For the most current availability, give us a call at +91 7981264279 or just walk in!`;
      } else {
        const d = pods.data;
        availMsg = d.available > 0
          ? `${d.available} of ${d.total} rigs are free right now! Walk-ins are welcome, or I can help you book.`
          : `All ${d.total} rigs are currently in use. Walk-ins are first-come-first-served — rigs usually free up within 30 minutes.`;
      }
      const bookingCount = getCachedBookingCount();
      if (bookingCount.count > 0 && !bookingCount.stale) {
        availMsg += `\n\n${bookingCount.count} ${bookingCount.count === 1 ? 'person has' : 'people have'} booked today!`;
      }
      const fomoLine = buildFomoLine();
      if (fomoLine && !availMsg.includes(fomoLine)) availMsg += `\n${fomoLine}`;
      conversationService.saveMessage(remoteJid, 'user', text);
      conversationService.saveMessage(remoteJid, 'assistant', availMsg);
      await evolutionService.sendText(remoteJid, availMsg);
      await evolutionService.sendPresence(remoteJid, 'paused');
      logger.info({ remoteJid, available: pods.data?.available }, 'Pod availability served (pre-intelligence)');
      return;
    }

    // ── Active conversational flow check (BEFORE intelligence — saves 3-5 calls per in-flow msg) ──
    const existingFlow = activeFlows.get(remoteJid);
    if (existingFlow) {
      // Check for timeout
      if (Date.now() - existingFlow.startedAt > FLOW_TIMEOUT_MS) {
        activeFlows.delete(remoteJid);
        // Fall through to normal processing
      } else if (text.trim() === '0' || text.trim().toLowerCase() === 'cancel') {
        activeFlows.delete(remoteJid);
        await evolutionService.sendText(remoteJid, 'No problem! Let me know if you need anything else.');
        await evolutionService.sendPresence(remoteJid, 'paused');
        return;
      } else {
        await evolutionService.sendPresence(remoteJid, 'composing');
        const phone = remoteJid.replace('@s.whatsapp.net', '');
        const result = await existingFlow.flow.handleStep(existingFlow.step, text, existingFlow.data, phone);
        if (result.complete) {
          activeFlows.delete(remoteJid);
          conversationService.saveMessage(remoteJid, 'user', text);
          conversationService.saveMessage(remoteJid, 'assistant', result.message);
          await evolutionService.sendText(remoteJid, result.message);
        } else {
          existingFlow.step = result.nextStep || result.step;
          existingFlow.data = { ...existingFlow.data, ...result.data };
          await evolutionService.sendText(remoteJid, result.message);
        }
        await evolutionService.sendPresence(remoteJid, 'paused');
        return;
      }
    }

    // ── Intelligence pipeline (INTEL-01 through INTEL-05, CONV-04) ──────
    // Runs AFTER flow check to avoid wasted calls on in-flow messages
    // DPDP: only profile consenting users — non-consenting get stateless service
    let customerProfile = null;
    let intentType = 'customer';
    const hasConsent = isOptedIn(remoteJid);
    if (!googleCommandHandler.isAdmin(remoteJid) && text && hasConsent) {
      // 1. Get or create profile (INTEL-04) — only for consenting users
      customerProfile = getOrCreateProfile(remoteJid, pushName);

      // 2. Classify intent (INTEL-02) — runs before AI call
      intentType = classifyIntent(text);

      // 3. Non-customer intent handling — route away from normal flow
      if (intentType === 'partnership') {
        const partnerMsg = "Thanks for your interest in partnering with RacingPoint! Please email us at usingh@racingpoint.in with your proposal, and our team will get back to you.";
        conversationService.saveMessage(remoteJid, 'user', text);
        conversationService.saveMessage(remoteJid, 'assistant', partnerMsg);
        await evolutionService.sendText(remoteJid, partnerMsg);
        updateProfile(remoteJid, { intent: 'partnership' });
        logger.info({ remoteJid, intent: 'partnership' }, 'Partnership inquiry routed');
        await evolutionService.sendPresence(remoteJid, 'paused');
        return;
      }
      if (intentType === 'job') {
        const jobMsg = "Thanks for your interest in working at RacingPoint! Send your resume to usingh@racingpoint.in and we'll review it.";
        conversationService.saveMessage(remoteJid, 'user', text);
        conversationService.saveMessage(remoteJid, 'assistant', jobMsg);
        await evolutionService.sendText(remoteJid, jobMsg);
        updateProfile(remoteJid, { intent: 'job' });
        logger.info({ remoteJid, intent: 'job' }, 'Job inquiry routed');
        await evolutionService.sendPresence(remoteJid, 'paused');
        return;
      }
      if (intentType === 'spam') {
        logger.info({ remoteJid, intent: 'spam' }, 'Spam intent detected by intelligence');
      }

      // 4. Score lead temperature (INTEL-01)
      const { score, temperature } = scoreLeadTemperature(text, customerProfile);

      // 5. Detect funnel advance (INTEL-03)
      const newStage = detectFunnelAdvance(text, customerProfile.funnel_stage);
      if (newStage) {
        updateFunnel(remoteJid, newStage, text);
      }

      // 6. Update profile with new score + intent
      updateProfile(remoteJid, {
        lead_score: score,
        lead_temperature: temperature,
        intent: intentType,
        push_name: pushName,
      });

      // Refresh profile after update
      customerProfile = getOrCreateProfile(remoteJid, pushName);

      // 7. Qualify-first pricing intercept (CONV-04)
      if (PRICING_PATTERNS.some(p => p.test(text)) && customerProfile.funnel_stage === 'inquiry') {
        const qualifyQ = QUALIFYING_QUESTIONS[Math.floor(Math.random() * QUALIFYING_QUESTIONS.length)];
        conversationService.saveMessage(remoteJid, 'user', text);
        conversationService.saveMessage(remoteJid, 'assistant', qualifyQ);
        await evolutionService.sendText(remoteJid, qualifyQ);
        updateFunnel(remoteJid, 'interest', text);
        logger.info({ remoteJid, temperature }, 'Qualify-first pricing: question sent before prices');
        await evolutionService.sendPresence(remoteJid, 'paused');
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

    // IST time + pod availability checks moved to pre-intelligence block (above flow check)

    // Send "composing" presence
    await evolutionService.sendPresence(remoteJid, 'composing');

    // Load conversation history
    const history = conversationService.getHistory(remoteJid);

    // ── First-message sizzle greeting (SIZZLE-01 + FIX-03) ──
    const isFirstMessage = history.length === 0;

    // Build messages with customer context enrichment
    const isAdmin = googleCommandHandler.isAdmin(remoteJid);
    let systemPrompt;
    if (isAdmin) {
      systemPrompt = buildAdminPrompt();
    } else {
      // Enrich with customer data from RaceControl
      const ctx = getCustomerContext(remoteJid);
      const contextBlock = ctx ? buildContextBlock(ctx) : '';
      // Intelligence context (INTEL-04 + INTEL-05)
      const intelligenceContext = customerProfile ? buildIntelligenceContext(customerProfile) : '';
      systemPrompt = buildSystemPrompt(contextBlock + '\n' + intelligenceContext);
      // Enhance system prompt for first-time users
      if (isFirstMessage) {
        systemPrompt += "\n\nThis is the customer's FIRST ever message. You MUST include AI disclosure: 'I\'m Racing Point Bot, your automated assistant. Say HUMAN anytime to reach our team!' and send an engaging welcome. Keep it warm and excited. Mention the free 5-min trial for first-timers.";
      }
    }
    const conversationMessages = [
      ...history.map(msg => ({ role: msg.role, content: msg.content })),
      { role: 'user', content: text },
    ];

    // Get AI response
    const model = isAdmin ? config.claude.adminModel : config.claude.customerModel;
    const reply = await claudeService.chat(systemPrompt, conversationMessages, { model });

    // ── Handoff detection: check BEFORE sending AI reply ──────────────
    const recentHistory = conversationService.getHistory(remoteJid);
    const handoffCheck = handoffService.shouldHandoff(remoteJid, text, recentHistory);
    if (handoffCheck.trigger) {
      await handoffService.executeHandoff(remoteJid, pushName, handoffCheck.reason, text);
      conversationService.saveMessage(remoteJid, 'user', text);
      logger.info({ remoteJid, pushName, reason: handoffCheck.reason }, 'Handoff triggered');
      await evolutionService.sendPresence(remoteJid, 'paused');
      return;
    }

    // ── Flow triggers (FLOW-01 through FLOW-04) ──────────────────
    const bookingTriggers = [
      /\b(book|booking|reserve|session)\b/i,
      /\bwant to (race|play|drive)\b/i,
      /\bbook (a|me|my)\b/i,
    ];
    const groupBookingTriggers = [
      /\bgroup\s*(book|session|party|event)\b/i,
      /\b(birthday|corporate|team\s*building)\b.*\b(book|party|event)\b/i,
      /\bparty\b/i,
    ];
    const registrationTriggers = [
      /\b(register|sign\s*up|new\s*here|first\s*time)\b/i,
    ];
    const feedbackTriggers = [
      /\b(feedback|review|rate|rating)\b/i,
      /\bhow was\b/i,
    ];

    const aiBookingPatterns = [
      /which game would you like/i,
      /let me help you book/i,
      /let's start your booking/i,
      /i can book a session/i,
      /would you like to book/i,
    ];
    const aiSuggestsBooking = aiBookingPatterns.some(p => p.test(reply));

    // Check triggers in priority order: group > booking > registration > feedback
    let triggeredFlow = null;
    if (groupBookingTriggers.some(p => p.test(text))) {
      triggeredFlow = new GroupBookingFlow();
    } else if (bookingTriggers.some(p => p.test(text)) || aiSuggestsBooking) {
      // Check VPS before starting booking flow
      const vpsUp = await isVPSReachable();
      if (!vpsUp) {
        const degradeMsg = GRACEFUL_DEGRADATION_MSG;
        conversationService.saveMessage(remoteJid, 'user', text);
        conversationService.saveMessage(remoteJid, 'assistant', degradeMsg);
        await evolutionService.sendText(remoteJid, degradeMsg);
        await evolutionService.sendPresence(remoteJid, 'paused');
        return;
      }
      triggeredFlow = new BookingFlow();
    } else if (registrationTriggers.some(p => p.test(text))) {
      triggeredFlow = new RegistrationFlow();
    } else if (feedbackTriggers.some(p => p.test(text))) {
      triggeredFlow = new FeedbackFlow();
    }

    if (triggeredFlow) {
      const initial = triggeredFlow.getInitialMessage();
      let flowStep = initial.step;
      let flowData = initial.data || {};
      let flowMessage = initial.message;

      // Auto-advance through fetch steps (no user input needed)
      if (flowStep === 'tier_fetch') {
        const phone = remoteJid.replace(/@.*/, '');
        const autoResult = await triggeredFlow.handleStep(flowStep, '', flowData, phone);
        if (autoResult.complete) {
          // Flow ended during fetch (e.g., VPS unreachable)
          await evolutionService.sendText(remoteJid, autoResult.message);
          await evolutionService.sendPresence(remoteJid, 'paused');
          return;
        }
        flowStep = autoResult.nextStep;
        flowData = autoResult.data;
        flowMessage = autoResult.message;
      }

      activeFlows.set(remoteJid, {
        flow: triggeredFlow,
        step: flowStep,
        data: flowData,
        startedAt: Date.now(),
      });
      // Send AI reply first (if we have one), then flow message
      if (reply && !aiSuggestsBooking) {
        conversationService.saveMessage(remoteJid, 'user', text);
        conversationService.saveMessage(remoteJid, 'assistant', reply);
        await evolutionService.sendText(remoteJid, reply);
      }
      await evolutionService.sendText(remoteJid, flowMessage);
      await evolutionService.sendPresence(remoteJid, 'paused');
      return;
    }

    // Check for human handoff (now routes through handoff service)
    if (reply.includes(HUMAN_HANDOFF_MARKER)) {
      await handoffService.executeHandoff(remoteJid, pushName, 'ai_suggested_handoff', text);
      conversationService.saveMessage(remoteJid, 'user', text);
      await evolutionService.sendPresence(remoteJid, 'paused');
      return;
    }

    // ── Send sizzle greeting for first-time users (SIZZLE-01) ──
    if (isFirstMessage && !isAdmin) {
      await evolutionService.sendText(remoteJid, SIZZLE_GREETING);
      conversationService.saveMessage(remoteJid, 'assistant', SIZZLE_GREETING);
      logger.info({ remoteJid, pushName }, 'First-message sizzle greeting sent');
    }

    // ── Social proof injection for booking context (SOCIAL-01) ──
    let finalReply = reply;
    const bookingContext = /\b(book|session|rig|pod|race|play)\b/i.test(text);
    if (bookingContext && !isAdmin) {
      const bookingCount = getCachedBookingCount();
      if (bookingCount.count >= 3 && !bookingCount.stale) {
        // Only inject if count is meaningful (3+) and not already mentioned
        if (!reply.includes('booked today') && !reply.includes('people have')) {
          finalReply += `\n\n_${bookingCount.count} people have booked today!_`;
        }
      }
    }

    // ── Contextual cafe recommendation (CAFE-01) ──
    if (!isAdmin && bookingContext) {
      const cafeRec = getContextualCafeRecommendation('browsing');
      // Only suggest once per conversation
      const recentMsgs = conversationService.getHistory(remoteJid);
      const alreadySuggested = recentMsgs.some(m => m.role === 'assistant' && m.content.includes('MENU'));
      if (!alreadySuggested && Math.random() < 0.3) { // 30% chance to avoid being pushy
        setTimeout(async () => {
          try {
            await evolutionService.sendText(remoteJid, cafeRec);
            conversationService.saveMessage(remoteJid, 'assistant', cafeRec);
          } catch (err) {
            logger.error({ err, remoteJid }, 'Failed to send cafe recommendation');
          }
        }, 3000); // 3s delay so it feels natural
      }
    }

    // Save to history
    conversationService.saveMessage(remoteJid, 'user', text);
    conversationService.saveMessage(remoteJid, 'assistant', finalReply);

    // Send response
    await evolutionService.sendText(remoteJid, finalReply);

    // ── Contextual referral sharing (WA-05) ────────────────────────
    // Share referral code when conversation is positive and customer is a regular+
    if (!isAdmin) {
      const ctx = getCustomerContext(remoteJid);
      if (ctx && ctx.referralCode && ctx.totalSessions >= 3) {
        const positivePatterns = [
          /\b(thanks|thank you|awesome|great|loved|amazing|fun|enjoyed|best)\b/i,
          /\b(will come|see you|next time|come back|coming back)\b/i,
        ];
        if (positivePatterns.some(p => p.test(text))) {
          const referralMsg = `By the way, share your referral code *${ctx.referralCode}* with friends — you get 100 Credits and they get 50 Credits!`;
          // Only share once per conversation (check recent messages)
          const recentHistory = conversationService.getHistory(remoteJid);
          const alreadyShared = recentHistory.some(m =>
            m.role === 'assistant' && m.content.includes(ctx.referralCode) && m.content.includes('referral')
          );
          if (!alreadyShared) {
            await evolutionService.sendText(remoteJid, referralMsg);
            conversationService.saveMessage(remoteJid, 'assistant', referralMsg);
            logger.info({ remoteJid, referralCode: ctx.referralCode }, 'Referral code shared contextually');
          }
        }
      }
    }

    // ── Schedule follow-up nudges (CONV-01, CONV-02, CONV-03) ──
    if (!isAdmin && customerProfile) {
      // CONV-01: Pricing inquiry without commitment → 30-60 min follow-up
      if (PRICING_PATTERNS.some(p => p.test(text)) && customerProfile.funnel_stage !== 'booked' && customerProfile.funnel_stage !== 'visited') {
        scheduleFollowUp(remoteJid, 'pricing_followup', { temperature: customerProfile.lead_temperature });
      }

      // CONV-02: Booking intent without actual booking → 3-5 hour slot nudge
      const hasBookingIntent = /\b(book|reserve|want to (race|play|drive)|this weekend|tomorrow|tonight|slot)\b/i.test(text);
      if (hasBookingIntent && customerProfile.funnel_stage !== 'booked' && !activeFlows.has(remoteJid)) {
        scheduleFollowUp(remoteJid, 'slot_nudge', { temperature: customerProfile.lead_temperature });
      }

      // CONV-03: Schedule opt-in request (22h after last message, before 24h window closes)
      if (customerProfile.total_messages <= 3 && !isOptedIn(remoteJid)) {
        scheduleFollowUp(remoteJid, 'optin_request', {});
      }
    }

    await evolutionService.sendPresence(remoteJid, 'paused');

    logger.info({ remoteJid, pushName, textLength: text.length, replyLength: finalReply.length }, 'Message handled');
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

// ── Escalation response handler (MESH-05) ──
async function handleEscalationResponse(text) {
  if (!text) return null;
  const normalized = text.trim().toUpperCase();

  // Map numbered replies and text replies to actions
  const actionMap = {
    '1': 'fix', 'FIX': 'fix',
    '2': 'disable', 'DISABLE': 'disable',
    '3': 'ignore', 'IGNORE': 'ignore',
  };

  const action = actionMap[normalized];
  if (!action) return null; // Not an escalation response

  // Check if there's a pending escalation (stored in staffAlertService)
  const alertSvc = getStaffAlertService();
  const pending = alertSvc.getPendingEscalation ? alertSvc.getPendingEscalation() : null;
  if (!pending) return null; // No pending escalation, treat as normal message

  const RC_API_URL = process.env.RACECONTROL_URL || 'http://localhost:8080';

  try {
    // Route action to RaceControl
    const res = await fetch(`${RC_API_URL}/api/v1/mesh/escalation-response`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        pod_id: pending.pod_id,
        action: action,
        issue_id: pending.issue_id,
        responded_by: 'uday_whatsapp',
      }),
    });

    if (res.ok) {
      await evolutionService.sendText(ADMIN_JID, `Done. Action "${action}" applied to Pod ${pending.pod_id}.`);
    } else {
      await evolutionService.sendText(ADMIN_JID, `Failed to apply "${action}" to Pod ${pending.pod_id}. RaceControl returned ${res.status}. Check admin dashboard.`);
    }

    // Clear pending escalation
    if (alertSvc.clearPendingEscalation) alertSvc.clearPendingEscalation();
    return true;
  } catch (err) {
    logger.error({ err, action, pod: pending.pod_id }, 'Escalation response failed');
    await evolutionService.sendText(ADMIN_JID, `Error applying "${action}": ${err.message}. Check admin dashboard.`);
    return true; // Still handled (don't pass to normal flow)
  }
}

module.exports = { handleMessage };
