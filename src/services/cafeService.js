const { CAFE_MENU, CAFE_CATEGORIES, DAILY_SPECIALS } = require('../data/cafeMenu');

/**
 * Get cafe menu formatted for WhatsApp.
 * @param {string|null} category - Category name or null for root menu
 * @returns {string} Formatted menu text
 */
function getCafeMenu(category) {
  if (!category) {
    // Root menu — list categories
    const lines = CAFE_CATEGORIES.map((cat, i) => {
      const label = cat.charAt(0).toUpperCase() + cat.slice(1);
      return `${i + 1}. ${label}`;
    });
    return lines.join('\n') + '\n\nReply with a number to browse!';
  }

  const cat = category.toLowerCase();
  const items = CAFE_MENU[cat];
  if (!items) {
    return `Category "${category}" not found. Reply *MENU* to see all categories.`;
  }

  const label = cat.charAt(0).toUpperCase() + cat.slice(1);
  const lines = items.map((item, i) => {
    const suffix = item.veg ? '' : ' (non-veg)';
    return `${i + 1}. ${item.name} - Rs.${item.price}${suffix}`;
  });

  return `*${label}*\n${lines.join('\n')}`;
}

/**
 * Get today's daily special based on IST day of week.
 * @returns {string} Formatted special text
 */
function getCafeSpecials() {
  // Get IST day of week
  const istDate = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
  const dayOfWeek = istDate.getDay();

  const special = DAILY_SPECIALS.find(s => s.day === dayOfWeek);
  if (!special) {
    return "Check out our full cafe menu! Reply *MENU* to browse.";
  }

  return `Today's Cafe Special: ${special.item} for just Rs.${special.price}! (Save Rs.${special.savings})`;
}

/**
 * Get a contextual cafe recommendation.
 * @param {string} context - 'waiting', 'post_session', 'browsing', or default
 * @returns {string} Recommendation text
 */
function getContextualCafeRecommendation(context) {
  switch (context) {
    case 'waiting':
      return "Grab a cold coffee while you wait! Check our cafe menu -- reply *MENU* anytime.";
    case 'post_session':
      return `Great session! Treat yourself to today's special -- ${getCafeSpecials()}`;
    case 'browsing':
    default:
      return "Did you know we have a cafe? Reply *MENU* to check out our food and drinks!";
  }
}

/**
 * Parse user input for cafe commands.
 * @param {string} text - User message text
 * @returns {{ type: string, category?: string }|null} Parsed cafe input or null
 */
function parseCafeInput(text) {
  const trimmed = text.trim();

  // Menu root keywords
  if (/^(menu|cafe|food|snacks|drinks|eat|hungry)$/i.test(trimmed)) {
    return { type: 'menu_root' };
  }

  // Category selection (1-4)
  if (/^[1-4]$/.test(trimmed)) {
    const idx = parseInt(trimmed, 10) - 1;
    return { type: 'category', category: CAFE_CATEGORIES[idx] };
  }

  // Specials
  if (/^(specials?|today.?s?\s*special|deal)$/i.test(trimmed)) {
    return { type: 'specials' };
  }

  return null;
}

module.exports = {
  getCafeMenu,
  getCafeSpecials,
  getContextualCafeRecommendation,
  parseCafeInput,
};
