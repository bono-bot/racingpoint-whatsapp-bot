const { BookingStateMachine, parseNumberedResponse, STATES } = require('./bookingStateMachine');
const racecontrolService = require('./racecontrolService');
const evolutionService = require('./evolutionService');
const conversationService = require('./conversationService');
const { getCustomerContext, normalizePhone } = require('./customerContextService');
const { getDb } = require('../db/database');
const logger = require('../utils/logger');

const GAME_OPTIONS = [
  { text: 'Assetto Corsa', id: 'ac', value: 'ac' },
  { text: 'F1 25', id: 'f1_25', value: 'f1_25' },
  { text: 'Forza Horizon 5', id: 'forza_horizon', value: 'forza_horizon' },
  { text: 'AC EVO', id: 'ac_evo', value: 'ac_evo' },
  { text: 'LeMans Ultimate', id: 'lmu', value: 'lmu' },
  { text: 'No preference', id: 'any', value: 'any' },
];

// Duration options will be populated from pricing API
let cachedTiers = null;
let tiersLastFetched = 0;

async function getDurationOptions() {
  // Cache pricing tiers for 5 minutes
  if (cachedTiers && Date.now() - tiersLastFetched < 5 * 60 * 1000) {
    return cachedTiers;
  }
  const tiers = await racecontrolService.getPricing();
  cachedTiers = tiers.map(t => ({
    text: `${t.name} — ${t.is_trial ? 'FREE' : '\u20B9' + (t.price_paise / 100)}`,
    id: t.id,
    value: t.id,
    price_paise: t.price_paise,
    duration_minutes: t.duration_minutes,
    is_trial: t.is_trial,
  }));
  tiersLastFetched = Date.now();
  return cachedTiers;
}

/**
 * Start a new booking flow for a user.
 * Called when Claude detects booking intent in the conversation.
 */
async function startBookingFlow(remoteJid) {
  const machine = new BookingStateMachine(getDb());
  machine.expireStaleFlows();

  // Check if there's already an active flow
  const existing = machine.getActiveFlow(remoteJid);
  if (existing) {
    return await handleBookingStep(remoteJid, '', existing);
  }

  const flow = machine.createFlow(remoteJid);

  // Send game selection
  await evolutionService.sendInteractive(remoteJid, {
    title: 'Book a Session',
    description: 'Which game would you like to play?',
    footer: 'Reply with a number or type "cancel" to cancel',
    buttons: GAME_OPTIONS,
  });

  conversationService.saveMessage(remoteJid, 'assistant',
    'Which game would you like to play?\n' +
    GAME_OPTIONS.map((g, i) => `${i+1}. ${g.text}`).join('\n') +
    '\n\nReply with a number or type "cancel".'
  );

  return true;
}

/**
 * Handle a message within an active booking flow.
 * Returns true if the message was handled, false if it should go to normal AI.
 */
async function handleBookingStep(remoteJid, text, flow) {
  const machine = new BookingStateMachine(getDb());
  const trimmed = text.trim().toLowerCase();

  // Handle cancel at any step
  if (trimmed === 'cancel' || trimmed === 'no' || trimmed === 'stop') {
    machine.cancelFlow(remoteJid);
    await evolutionService.sendText(remoteJid, 'Booking cancelled. Let me know if you want to book later!');
    conversationService.saveMessage(remoteJid, 'user', text);
    conversationService.saveMessage(remoteJid, 'assistant', 'Booking cancelled.');
    return true;
  }

  switch (flow.state) {
    case STATES.SELECT_GAME:
      return await handleGameSelection(remoteJid, text, machine);

    case STATES.SELECT_DURATION:
      return await handleDurationSelection(remoteJid, text, machine);

    case STATES.CONFIRM:
      return await handleConfirmation(remoteJid, text, machine);

    default:
      return false; // Unknown state, let normal AI handle
  }
}

async function handleGameSelection(remoteJid, text, machine) {
  const selected = parseNumberedResponse(text, GAME_OPTIONS);
  if (!selected) {
    await evolutionService.sendText(remoteJid,
      "I didn't catch that. Please reply with a number (1-6) or type the game name.\n\n" +
      GAME_OPTIONS.map((g, i) => `${i+1}. ${g.text}`).join('\n') +
      '\n\nOr type "cancel" to cancel.'
    );
    return true;
  }

  const result = machine.advance(remoteJid, 'game_selected', { game: selected.value, game_name: selected.text });
  if (result?.error) {
    logger.error({ remoteJid, error: result.error }, 'Game selection transition failed');
    return false;
  }

  // Send duration options
  const durationOptions = await getDurationOptions();
  await evolutionService.sendInteractive(remoteJid, {
    title: `${selected.text} — Pick Duration`,
    description: `Great choice! How long do you want to race?`,
    footer: 'Reply with a number or type "cancel"',
    buttons: durationOptions,
  });

  conversationService.saveMessage(remoteJid, 'user', text);
  conversationService.saveMessage(remoteJid, 'assistant',
    `${selected.text} selected! How long?\n` +
    durationOptions.map((d, i) => `${i+1}. ${d.text}`).join('\n')
  );

  return true;
}

async function handleDurationSelection(remoteJid, text, machine) {
  const durationOptions = await getDurationOptions();
  const selected = parseNumberedResponse(text, durationOptions);
  if (!selected) {
    await evolutionService.sendText(remoteJid,
      "Please select a duration:\n\n" +
      durationOptions.map((d, i) => `${i+1}. ${d.text}`).join('\n') +
      '\n\nOr type "cancel" to cancel.'
    );
    return true;
  }

  const result = machine.advance(remoteJid, 'duration_selected', {
    tier_id: selected.value,
    tier_name: selected.text,
    price_paise: selected.price_paise,
    duration_minutes: selected.duration_minutes,
    is_trial: selected.is_trial,
  });
  if (result?.error) return false;

  // Build confirmation message with wallet check
  const flowData = result.data;
  const ctx = getCustomerContext(remoteJid);

  let confirmMsg = `*Booking Summary*\n\n`;
  confirmMsg += `Game: ${flowData.game_name}\n`;
  confirmMsg += `Duration: ${selected.text}\n`;

  if (!selected.is_trial) {
    const priceRupees = selected.price_paise / 100;
    confirmMsg += `Price: \u20B9${priceRupees}\n`;

    // Wallet balance check (WA-03)
    if (ctx && ctx.isRegistered) {
      const balance = ctx.walletBalance; // in credits (1 credit = 1 rupee)
      confirmMsg += `\nYour wallet: ${balance} Credits\n`;

      if (balance < priceRupees) {
        const shortfall = priceRupees - balance;
        confirmMsg += `\n*Insufficient balance!* You need ${shortfall} more Credits.\n`;
        confirmMsg += `Top up here: app.racingpoint.cloud\n`;
        confirmMsg += `\nAfter topping up, come back and type "book" to try again.`;

        machine.cancelFlow(remoteJid);
        await evolutionService.sendText(remoteJid, confirmMsg);
        conversationService.saveMessage(remoteJid, 'user', text);
        conversationService.saveMessage(remoteJid, 'assistant', confirmMsg);
        return true;
      }

      confirmMsg += `After booking: ${balance - priceRupees} Credits remaining\n`;
    } else {
      confirmMsg += `\n_Note: You need a RacingPoint account with sufficient credits. Register at app.racingpoint.cloud_\n`;
    }
  } else {
    confirmMsg += `Price: FREE (5-min trial)\n`;
  }

  confirmMsg += `\nReply *yes* to confirm or *cancel* to cancel.`;

  await evolutionService.sendInteractive(remoteJid, {
    title: 'Confirm Booking',
    description: confirmMsg,
    buttons: [
      { text: 'Confirm', id: 'confirm' },
      { text: 'Cancel', id: 'cancel' },
    ],
  });

  conversationService.saveMessage(remoteJid, 'user', text);
  conversationService.saveMessage(remoteJid, 'assistant', confirmMsg);

  return true;
}

async function handleConfirmation(remoteJid, text, machine) {
  const trimmed = text.trim().toLowerCase();

  if (!['yes', 'confirm', 'ok', 'sure', 'y', '1'].includes(trimmed)) {
    if (['no', 'cancel', 'stop', '2'].includes(trimmed)) {
      machine.cancelFlow(remoteJid);
      await evolutionService.sendText(remoteJid, 'Booking cancelled. Let me know when you want to book!');
      conversationService.saveMessage(remoteJid, 'user', text);
      conversationService.saveMessage(remoteJid, 'assistant', 'Booking cancelled.');
      return true;
    }
    await evolutionService.sendText(remoteJid, 'Please reply *yes* to confirm or *cancel* to cancel your booking.');
    return true;
  }

  // Execute the booking
  const flow = machine.getActiveFlow(remoteJid);
  const flowData = JSON.parse(flow.data_json || '{}');
  const phone10 = flow.phone; // Derived from JID at flow creation (SECURE)

  // Look up customer by phone (try multiple formats)
  const phone91 = `91${phone10}`;
  let customer = await racecontrolService.lookupCustomer(phone91);
  if (!customer?.registered) {
    customer = await racecontrolService.lookupCustomer(phone10);
  }
  if (!customer?.registered) {
    customer = await racecontrolService.lookupCustomer(`+91${phone10}`);
  }

  if (!customer?.registered) {
    machine.cancelFlow(remoteJid);
    const regMsg = "You need a RacingPoint account to book. Register in 2 minutes at:\n\napp.racingpoint.cloud\n\nOnce registered, come back and type \"book\" to try again!";
    await evolutionService.sendText(remoteJid, regMsg);
    conversationService.saveMessage(remoteJid, 'user', text);
    conversationService.saveMessage(remoteJid, 'assistant', regMsg);
    return true;
  }

  // Final wallet check (WA-03 — real-time, not cached context)
  if (!flowData.is_trial && customer.wallet_balance_paise < flowData.price_paise) {
    const shortfall = (flowData.price_paise - customer.wallet_balance_paise) / 100;
    machine.cancelFlow(remoteJid);
    const balMsg = `*Insufficient balance!*\n\nYou have \u20B9${customer.wallet_balance_paise / 100} but need \u20B9${flowData.price_paise / 100}.\nShortfall: \u20B9${shortfall}\n\nTop up at: app.racingpoint.cloud\n\nAfter topping up, type "book" to try again.`;
    await evolutionService.sendText(remoteJid, balMsg);
    conversationService.saveMessage(remoteJid, 'user', text);
    conversationService.saveMessage(remoteJid, 'assistant', balMsg);
    return true;
  }

  // Book the session — phone from JID (never from AI output)
  try {
    const bookingPhone = customer.registered ? (phone91.length === 12 ? phone91 : phone10) : phone10;
    const result = await racecontrolService.bookSession(bookingPhone, flowData.tier_id, null);

    if (result.status === 'booked' || result.status === 'ok') {
      machine.advance(remoteJid, 'confirmed', { booking_result: result });

      let confirmationMsg =
        `Your session is booked!\n\n` +
        `*Pod:* ${result.pod_number}\n` +
        `*PIN:* ${result.pin}\n` +
        `*Duration:* ${result.duration_minutes || flowData.duration_minutes} minutes\n` +
        `*Game:* ${flowData.game_name}\n`;
      if (result.wallet_debit_paise) {
        confirmationMsg += `*Debited:* ${result.wallet_debit_paise / 100} Credits\n`;
      }
      confirmationMsg += `\nHead to your pod and enter the PIN on the lock screen. Enjoy your race!`;

      await evolutionService.sendText(remoteJid, confirmationMsg);
      conversationService.saveMessage(remoteJid, 'user', text);
      conversationService.saveMessage(remoteJid, 'assistant', confirmationMsg);
      return true;
    } else {
      machine.cancelFlow(remoteJid);
      const errorMsg = result.message || "Sorry, the booking couldn't be completed. Please try again or contact us at +91 7981264279.";
      await evolutionService.sendText(remoteJid, errorMsg);
      conversationService.saveMessage(remoteJid, 'user', text);
      conversationService.saveMessage(remoteJid, 'assistant', errorMsg);
      return true;
    }
  } catch (err) {
    logger.error({ err, remoteJid }, 'Booking API call failed');
    machine.cancelFlow(remoteJid);
    await evolutionService.sendText(remoteJid, "Sorry, there was an issue booking your session. Please try again or contact us at +91 7981264279.");
    return true;
  }
}

module.exports = { startBookingFlow, handleBookingStep };
