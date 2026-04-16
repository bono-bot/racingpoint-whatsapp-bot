'use strict';

/**
 * Conversational Flow Handlers — 4 text-based multi-step flows:
 *   BookingFlow, GroupBookingFlow, RegistrationFlow, FeedbackFlow
 *
 * Each flow is a state machine driven by numbered text options.
 * State shape: { flowType, step, data }
 * CommonJS module matching v1.0 service pattern.
 */

const { bookViaVPS, getPricingTiers, GRACEFUL_DEGRADATION_MSG, WALLET_TOPUP_MSG } = require('./vpsBookingService');

// ── IST time helpers (inline to avoid missing-module issues) ───────────
const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

function getCurrentIST() {
  const now = new Date();
  const utc = now.getTime() + now.getTimezoneOffset() * 60000;
  return new Date(utc + IST_OFFSET_MS);
}

// Registration link (public-facing URL, not localhost)
const REGISTRATION_URL = 'https://app.racingpoint.cloud';

// Cancel message
const CANCEL_MSG = "No problem! Let me know if you need anything else.";

// ── Game catalog (for optional game selection) ────────────────────────
const GAMES = [
  { id: 1, name: 'Assetto Corsa', desc: 'sim racing' },
  { id: 2, name: 'Assetto Corsa Competizione', desc: 'GT racing' },
  { id: 3, name: 'iRacing', desc: 'online competition' },
  { id: 4, name: 'F1 24', desc: 'Formula 1' },
  { id: 5, name: 'Any / Surprise me', desc: 'we\'ll pick for you' },
];

// ── Base class ─────────────────────────────────────────────────────────

class FlowHandler {
  constructor(flowType) {
    this.flowType = flowType;
  }

  /**
   * @returns {{ message: string, step: string }}
   */
  getInitialMessage() {
    throw new Error('getInitialMessage() must be overridden');
  }

  /**
   * @param {string} step
   * @param {string} input
   * @param {object} context - accumulated data
   * @param {string} [phone] - customer phone for booking
   * @returns {Promise<{message: string, complete: boolean, cancelled?: boolean, data: object, nextStep?: string}>}
   */
  async handleStep(step, input, context, phone) {
    throw new Error('handleStep() must be overridden');
  }
}

// ── Helper: validate numbered choice ───────────────────────────────────

function parseChoice(input, min, max) {
  const trimmed = (input || '').trim();
  if (trimmed === '0') return { cancel: true };
  const num = parseInt(trimmed, 10);
  if (isNaN(num) || num < min || num > max) return { invalid: true };
  return { value: num };
}

function parseNumber(input, min, max) {
  const trimmed = (input || '').trim();
  if (trimmed === '0') return { cancel: true };
  const num = parseInt(trimmed, 10);
  if (isNaN(num) || num < min || num > max) return { invalid: true };
  return { value: num };
}

// ══════════════════════════════════════════════════════════════════════
// 1. BOOKING FLOW (FLOW-01, BOOK-01, BOOK-02)
// ══════════════════════════════════════════════════════════════════════

class BookingFlow extends FlowHandler {
  constructor() {
    super('booking');
  }

  getInitialMessage() {
    // We show a loading message first, then tier_select fetches live pricing
    return { message: "Let's book you a sim racing session! Checking available options...", step: 'tier_fetch' };
  }

  async handleStep(step, input, context, phone) {
    const data = { ...context };

    // ── tier_fetch (auto-step: fetch pricing tiers from VPS) ─────
    if (step === 'tier_fetch') {
      const tiers = await getPricingTiers();
      if (tiers.length === 0) {
        return { message: GRACEFUL_DEGRADATION_MSG, complete: true, data };
      }
      data._tiers = tiers;
      const lines = ["Here are our session options:", ''];
      tiers.forEach((t, i) => {
        const price = t.is_trial ? 'FREE' : `Rs.${t.price_paise / 100}`;
        lines.push(`${i + 1}. ${t.name} (${t.duration_minutes} min) — ${price}`);
      });
      lines.push('0. Cancel');
      return { message: lines.join('\n'), complete: false, data, nextStep: 'tier_select' };
    }

    // ── tier_select ──────────────────────────────────────────────
    if (step === 'tier_select') {
      const tiers = data._tiers || [];
      const choice = parseChoice(input, 1, tiers.length);
      if (choice.cancel) return { message: CANCEL_MSG, complete: true, cancelled: true, data };
      if (choice.invalid) {
        return {
          message: `Invalid choice. Please pick 1-${tiers.length} or 0 to cancel.`,
          complete: false, data, nextStep: 'tier_select',
        };
      }
      const tier = tiers[choice.value - 1];
      data.tierId = tier.id;
      data.tierName = tier.name;
      data.durationMinutes = tier.duration_minutes;
      data.pricePaise = tier.price_paise;
      data.isTrial = tier.is_trial;
      delete data._tiers;

      // Ask for game preference
      const lines = [
        `Great — ${tier.name}! Which game would you like?`,
        '',
      ];
      GAMES.forEach(g => lines.push(`${g.id}. ${g.name} (${g.desc})`));
      lines.push('0. Cancel');
      return { message: lines.join('\n'), complete: false, data, nextStep: 'game_select' };
    }

    // ── game_select ──────────────────────────────────────────────
    if (step === 'game_select') {
      const choice = parseChoice(input, 1, GAMES.length);
      if (choice.cancel) return { message: CANCEL_MSG, complete: true, cancelled: true, data };
      if (choice.invalid) {
        return {
          message: `Invalid choice. Please pick 1-${GAMES.length} or 0 to cancel.`,
          complete: false, data, nextStep: 'game_select',
        };
      }
      data.game = GAMES[choice.value - 1].name;

      const price = data.isTrial ? 'FREE' : `Rs.${data.pricePaise / 100}`;
      const summary = [
        "Here's your booking summary:",
        '',
        `*Session:* ${data.tierName} (${data.durationMinutes} min)`,
        `*Game:* ${data.game}`,
        `*Price:* ${price}`,
        '',
        'Reply *YES* to confirm or *0* to cancel.',
      ];
      return { message: summary.join('\n'), complete: false, data, nextStep: 'confirm' };
    }

    // ── confirm ──────────────────────────────────────────────────
    if (step === 'confirm') {
      const trimmed = (input || '').trim().toLowerCase();
      if (trimmed === '0') return { message: CANCEL_MSG, complete: true, cancelled: true, data };
      if (trimmed !== 'yes' && trimmed !== 'y') {
        return {
          message: 'Reply *YES* to confirm your booking or *0* to cancel.',
          complete: false, data, nextStep: 'confirm',
        };
      }

      // Call VPS booking API with pricing_tier_id
      const result = await bookViaVPS(phone, data.tierId);

      if (result.success) {
        const msg = [
          '🏁 Your booking is confirmed!',
          '',
          `*Session:* ${result.tierName || data.tierName}`,
          `*Game:* ${data.game}`,
          `*Pod:* ${result.podNumber}`,
          `*PIN:* ${result.pin}`,
          `*Duration:* ${result.durationMinutes || data.durationMinutes} minutes`,
          '',
          `Head to Pod ${result.podNumber} and enter PIN *${result.pin}* on the screen.`,
          '',
          'See you at Racing Point! Vantage Line Mall, 3rd Floor.',
        ].join('\n');
        data.bookingResult = result;
        return { message: msg, complete: true, data };
      }

      if (result.reason === 'insufficient_wallet') {
        return {
          message: WALLET_TOPUP_MSG(result.balance, result.required),
          complete: true, data,
        };
      }

      if (result.reason === 'not_registered') {
        return {
          message: "You need to register first! Visit https://app.racingpoint.cloud to create your account, then come back and book.",
          complete: true, data,
        };
      }

      if (result.reason === 'no_pods') {
        return {
          message: "All pods are busy right now! Try again in a few minutes, or just walk in — we'll get you racing as soon as a pod frees up.",
          complete: true, data,
        };
      }

      if (result.reason === 'active_reservation') {
        return {
          message: "You already have an active booking! Finish your current session first, then book another.",
          complete: true, data,
        };
      }

      if (result.reason === 'trial_used') {
        return {
          message: "You've already used your free trial. Choose a paid session instead — type 'book' to start over!",
          complete: true, data,
        };
      }

      // VPS unreachable or unknown error
      return { message: GRACEFUL_DEGRADATION_MSG, complete: true, data };
    }

    return { message: 'Something went wrong. Type "book" to start over.', complete: true, data };
  }
}

// ══════════════════════════════════════════════════════════════════════
// 2. GROUP BOOKING FLOW (FLOW-02)
// ══════════════════════════════════════════════════════════════════════

const OCCASIONS = [
  'Birthday party',
  'Corporate team building',
  'Friends hangout',
  'Tournament',
  'Other',
];

const PACKAGES = [
  { id: 1, name: 'Standard', price: 'Rs.500/person/hour', desc: '' },
  { id: 2, name: 'Premium', price: 'Rs.800/person/hour', desc: 'dedicated pods + drinks' },
  { id: 3, name: 'Tournament', price: 'Rs.1000/person', desc: '3 hours + prizes' },
];

class GroupBookingFlow extends FlowHandler {
  constructor() {
    super('group_booking');
  }

  getInitialMessage() {
    const lines = [
      "Awesome — let's plan a group session! What's the occasion?",
      '',
    ];
    OCCASIONS.forEach((o, i) => lines.push(`${i + 1}. ${o}`));
    lines.push('0. Cancel');
    return { message: lines.join('\n'), step: 'occasion' };
  }

  async handleStep(step, input, context) {
    const data = { ...context };

    // ── occasion ─────────────────────────────────────────────────
    if (step === 'occasion') {
      const choice = parseChoice(input, 1, OCCASIONS.length);
      if (choice.cancel) return { message: CANCEL_MSG, complete: true, cancelled: true, data };
      if (choice.invalid) {
        return {
          message: `Invalid choice. Please pick 1-${OCCASIONS.length} or 0 to cancel.`,
          complete: false, data, nextStep: 'occasion',
        };
      }
      data.occasion = OCCASIONS[choice.value - 1];
      return {
        message: 'How many people in your group? (2-20)',
        complete: false, data, nextStep: 'group_size',
      };
    }

    // ── group_size ───────────────────────────────────────────────
    if (step === 'group_size') {
      const parsed = parseNumber(input, 2, 20);
      if (parsed.cancel) return { message: CANCEL_MSG, complete: true, cancelled: true, data };
      if (parsed.invalid) {
        return {
          message: 'Please enter a number between 2 and 20, or 0 to cancel.',
          complete: false, data, nextStep: 'group_size',
        };
      }
      data.groupSize = parsed.value;
      const lines = [
        'When would you like to come?',
        '',
        '1. Today',
        '2. Tomorrow',
        '3. This weekend',
        '4. Type a date (DD/MM)',
        '0. Cancel',
      ];
      return { message: lines.join('\n'), complete: false, data, nextStep: 'date_select' };
    }

    // ── date_select ──────────────────────────────────────────────
    if (step === 'date_select') {
      const trimmed = (input || '').trim();
      if (trimmed === '0') return { message: CANCEL_MSG, complete: true, cancelled: true, data };

      const num = parseInt(trimmed, 10);
      if (num === 1) { data.date = 'Today'; }
      else if (num === 2) { data.date = 'Tomorrow'; }
      else if (num === 3) { data.date = 'This weekend'; }
      else if (/^\d{1,2}\/\d{1,2}$/.test(trimmed)) {
        data.date = trimmed;
      } else {
        return {
          message: 'Please pick 1-3, type a date as DD/MM, or 0 to cancel.',
          complete: false, data, nextStep: 'date_select',
        };
      }

      const lines = [
        'Select a package:',
        '',
      ];
      PACKAGES.forEach(p => {
        const extra = p.desc ? ` (${p.desc})` : '';
        lines.push(`${p.id}. ${p.name} - ${p.price}${extra}`);
      });
      lines.push('0. Cancel');
      return { message: lines.join('\n'), complete: false, data, nextStep: 'package_select' };
    }

    // ── package_select ───────────────────────────────────────────
    if (step === 'package_select') {
      const choice = parseChoice(input, 1, PACKAGES.length);
      if (choice.cancel) return { message: CANCEL_MSG, complete: true, cancelled: true, data };
      if (choice.invalid) {
        return {
          message: `Invalid choice. Please pick 1-${PACKAGES.length} or 0 to cancel.`,
          complete: false, data, nextStep: 'package_select',
        };
      }
      const pkg = PACKAGES[choice.value - 1];
      data.package = pkg.name;
      data.packagePrice = pkg.price;

      const summary = [
        'Here\'s your group booking summary:',
        '',
        `*Occasion:* ${data.occasion}`,
        `*Group size:* ${data.groupSize} people`,
        `*Date:* ${data.date}`,
        `*Package:* ${data.package} (${data.packagePrice})`,
        '',
        'Reply *YES* to confirm or *0* to cancel.',
      ];
      return { message: summary.join('\n'), complete: false, data, nextStep: 'confirm' };
    }

    // ── confirm ──────────────────────────────────────────────────
    if (step === 'confirm') {
      const trimmed = (input || '').trim().toLowerCase();
      if (trimmed === '0') return { message: CANCEL_MSG, complete: true, cancelled: true, data };
      if (trimmed !== 'yes' && trimmed !== 'y') {
        return {
          message: 'Reply *YES* to confirm or *0* to cancel.',
          complete: false, data, nextStep: 'confirm',
        };
      }

      const msg = [
        "Your group booking request has been noted!",
        '',
        `*Occasion:* ${data.occasion}`,
        `*Group size:* ${data.groupSize} people`,
        `*Date:* ${data.date}`,
        `*Package:* ${data.package}`,
        '',
        'To finalize your group booking, please call us at *+91 7981264279*.',
        'Our staff will coordinate pod assignments, F&B, and any special arrangements for your group.',
      ].join('\n');
      return { message: msg, complete: true, data };
    }

    return { message: 'Something went wrong. Type "group booking" to start over.', complete: true, data };
  }
}

// ══════════════════════════════════════════════════════════════════════
// 3. REGISTRATION FLOW (FLOW-03)
// ══════════════════════════════════════════════════════════════════════

class RegistrationFlow extends FlowHandler {
  constructor() {
    super('registration');
  }

  getInitialMessage() {
    return {
      message: "Let's get you registered! What's your full name?",
      step: 'name',
    };
  }

  async handleStep(step, input, context) {
    const data = { ...context };
    const trimmed = (input || '').trim();

    // ── name ─────────────────────────────────────────────────────
    if (step === 'name') {
      if (trimmed === '0') return { message: CANCEL_MSG, complete: true, cancelled: true, data };
      if (trimmed.length < 2) {
        return {
          message: 'Please enter your full name (at least 2 characters).',
          complete: false, data, nextStep: 'name',
        };
      }
      data.name = trimmed;
      return {
        message: 'How old are you? (We need this for our safety waiver)',
        complete: false, data, nextStep: 'age',
      };
    }

    // ── age ──────────────────────────────────────────────────────
    if (step === 'age') {
      if (trimmed === '0') return { message: CANCEL_MSG, complete: true, cancelled: true, data };
      const age = parseInt(trimmed, 10);
      if (isNaN(age) || age < 5 || age > 99) {
        return {
          message: 'Please enter a valid age between 5 and 99, or 0 to cancel.',
          complete: false, data, nextStep: 'age',
        };
      }
      data.age = age;

      const lines = [
        'What games interest you?',
        '',
        '1. Sim Racing (Assetto Corsa, iRacing)',
        '2. Formula 1 games',
        '3. Both',
        "4. I'll try everything!",
        '0. Cancel',
      ];
      return { message: lines.join('\n'), complete: false, data, nextStep: 'preferences' };
    }

    // ── preferences ──────────────────────────────────────────────
    if (step === 'preferences') {
      const choice = parseChoice(input, 1, 4);
      if (choice.cancel) return { message: CANCEL_MSG, complete: true, cancelled: true, data };
      if (choice.invalid) {
        return {
          message: 'Please pick 1-4 or 0 to cancel.',
          complete: false, data, nextStep: 'preferences',
        };
      }
      const prefs = ['Sim Racing', 'Formula 1', 'Both', 'Everything'];
      data.preferences = prefs[choice.value - 1];

      const summary = [
        'Here\'s what we have:',
        '',
        `*Name:* ${data.name}`,
        `*Age:* ${data.age}`,
        `*Interests:* ${data.preferences}`,
        '',
        'Reply *YES* to confirm or *0* to cancel.',
      ];
      return { message: summary.join('\n'), complete: false, data, nextStep: 'confirm' };
    }

    // ── confirm ──────────────────────────────────────────────────
    if (step === 'confirm') {
      if (trimmed === '0') return { message: CANCEL_MSG, complete: true, cancelled: true, data };
      if (trimmed.toLowerCase() !== 'yes' && trimmed.toLowerCase() !== 'y') {
        return {
          message: 'Reply *YES* to confirm or *0* to cancel.',
          complete: false, data, nextStep: 'confirm',
        };
      }

      const registerUrl = `${REGISTRATION_URL}/register`;
      const underAge = data.age < 18
        ? "\n\nSince you're under 18, a parent/guardian will need to sign the waiver during registration."
        : '';

      const msg = [
        `Thanks, ${data.name}! To complete your registration and sign the liability waiver, open this link:`,
        '',
        registerUrl,
        '',
        "You'll get a verification code on this WhatsApp number. Takes less than 2 minutes!",
        underAge,
        '',
        'Once registered, you\'re all set to race!',
      ].filter(Boolean).join('\n');

      return { message: msg, complete: true, data };
    }

    return { message: 'Something went wrong. Type "register" to start over.', complete: true, data };
  }
}

// ══════════════════════════════════════════════════════════════════════
// 4. FEEDBACK FLOW (FLOW-04)
// ══════════════════════════════════════════════════════════════════════

const STAR_LABELS = ['Terrible', 'Poor', 'Average', 'Great', 'Amazing!'];

class FeedbackFlow extends FlowHandler {
  constructor() {
    super('feedback');
  }

  getInitialMessage() {
    const lines = [
      'How was your experience at Racing Point? (1-5 stars)',
      '',
    ];
    STAR_LABELS.forEach((label, i) => lines.push(`${i + 1}. ${label}`));
    return { message: lines.join('\n'), step: 'rating' };
  }

  async handleStep(step, input, context) {
    const data = { ...context };
    const trimmed = (input || '').trim();

    // ── rating ───────────────────────────────────────────────────
    if (step === 'rating') {
      if (trimmed === '0') return { message: CANCEL_MSG, complete: true, cancelled: true, data };
      const parsed = parseNumber(input, 1, 5);
      if (parsed.invalid) {
        return {
          message: 'Please rate 1-5 (1 = Terrible, 5 = Amazing!) or 0 to cancel.',
          complete: false, data, nextStep: 'rating',
        };
      }
      data.rating = parsed.value;
      data.ratingLabel = STAR_LABELS[parsed.value - 1];

      const lines = [
        'How likely are you to recommend us to a friend? (0-10)',
        '',
        '0 = Not at all ... 10 = Definitely!',
      ];
      return { message: lines.join('\n'), complete: false, data, nextStep: 'nps' };
    }

    // ── nps ──────────────────────────────────────────────────────
    if (step === 'nps') {
      const num = parseInt(trimmed, 10);
      if (isNaN(num) || num < 0 || num > 10) {
        return {
          message: 'Please enter a number from 0 to 10.',
          complete: false, data, nextStep: 'nps',
        };
      }
      data.nps = num;
      return {
        message: "Any additional comments? (Type your feedback or 'skip' to finish)",
        complete: false, data, nextStep: 'comments',
      };
    }

    // ── comments ─────────────────────────────────────────────────
    if (step === 'comments') {
      if (trimmed.toLowerCase() === 'skip' || trimmed === '') {
        data.comments = null;
      } else {
        data.comments = trimmed;
      }

      // Build thank-you message
      const lines = [
        `Thank you for your feedback! You rated us ${data.rating}/5 (${data.ratingLabel}).`,
      ];

      if (data.rating >= 4) {
        lines.push('');
        lines.push("We're glad you enjoyed it! If you have a moment, a Google review would mean the world to us:");
        lines.push('https://g.page/r/racingpoint-esports/review');
      } else if (data.rating <= 2) {
        lines.push('');
        lines.push("We're sorry to hear that. Would you like us to connect you with our team to make things right? Just say *human* and we'll get someone on it.");
      }

      return { message: lines.join('\n'), complete: true, data };
    }

    return { message: 'Something went wrong. Type "feedback" to start over.', complete: true, data };
  }
}

// ── Exports (CommonJS) ─────────────────────────────────────────────────

module.exports = {
  BookingFlow,
  GroupBookingFlow,
  RegistrationFlow,
  FeedbackFlow,
};
