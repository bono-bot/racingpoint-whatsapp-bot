/**
 * Patch script to add first-message sizzle greeting to messageHandler.js on VPS.
 * Run: node patch-sizzle.js
 */
const fs = require('fs');
const path = '/root/racingpoint-whatsapp-bot/src/services/messageHandler.js';

let code = fs.readFileSync(path, 'utf-8');

// Check if already patched
if (code.includes('SIZZLE_GREETING')) {
  console.log('Already patched — sizzle greeting exists');
  process.exit(0);
}

// Add sizzle constants after existing constants
const constantsMarker = "const RAMU_JID  = '917981399100@s.whatsapp.net';";
const sizzleConstants = `${constantsMarker}

// ── First-message sizzle greeting (SIZZLE-01 + FIX-03) ──
const SIZZLE_GREETING = [
  "Hey! Welcome to *RacingPoint eSports & Cafe* — Hyderabad's top sim racing spot!",
  "",
  "8 professional racing rigs with triple monitors, force feedback wheels, and the most realistic sim racing experience in the city.",
  "",
  "Free 5-min trial for first-timers!",
  "",
  "_This is an automated assistant. Say *human* anytime to reach our team!_",
].join('\\n');`;

code = code.replace(constantsMarker, sizzleConstants);

// Add first-message detection and sizzle greeting send after history load
const historyMarker = `    // Build messages with customer context enrichment
    const isAdmin = googleCommandHandler.isAdmin(remoteJid);`;
const sizzleDetection = `    // ── First-message sizzle greeting (SIZZLE-01 + FIX-03) ──
    const isFirstMessage = history.length === 0;

    // Build messages with customer context enrichment
    const isAdmin = googleCommandHandler.isAdmin(remoteJid);`;

code = code.replace(historyMarker, sizzleDetection);

// Add first-message system prompt enhancement
const systemPromptMarker = `      systemPrompt = buildSystemPrompt(contextBlock);
    }`;
const enhancedSystemPrompt = `      systemPrompt = buildSystemPrompt(contextBlock);
      // Enhance system prompt for first-time users
      if (isFirstMessage) {
        systemPrompt += "\\n\\nThis is the customer's FIRST ever message. You MUST include AI disclosure: 'I\\'m Racing Point Bot, your automated assistant. Say HUMAN anytime to reach our team!' and send an engaging welcome. Keep it warm and excited. Mention the free 5-min trial for first-timers.";
      }
    }`;

code = code.replace(systemPromptMarker, enhancedSystemPrompt);

// Add sizzle greeting send before the normal reply
const normalReplyMarker = `    // Save to history
    conversationService.saveMessage(remoteJid, 'user', text);
    conversationService.saveMessage(remoteJid, 'assistant', reply);

    // Send response
    await evolutionService.sendText(remoteJid, reply);`;
const sizzleReply = `    // ── Send sizzle greeting for first-time users (SIZZLE-01) ──
    if (isFirstMessage && !isAdmin) {
      await evolutionService.sendText(remoteJid, SIZZLE_GREETING);
      conversationService.saveMessage(remoteJid, 'assistant', SIZZLE_GREETING);
      logger.info({ remoteJid, pushName }, 'First-message sizzle greeting sent');
    }

    // Save to history
    conversationService.saveMessage(remoteJid, 'user', text);
    conversationService.saveMessage(remoteJid, 'assistant', reply);

    // Send response
    await evolutionService.sendText(remoteJid, reply);`;

code = code.replace(normalReplyMarker, sizzleReply);

fs.writeFileSync(path, code);
console.log('Patched successfully — sizzle greeting added');
