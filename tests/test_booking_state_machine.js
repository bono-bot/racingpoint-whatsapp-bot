const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

describe('BookingStateMachine', () => {
  let db;
  let BookingStateMachine;
  let parseNumberedResponse;
  let STATES;
  let machine;

  beforeEach(() => {
    // Create in-memory SQLite database
    db = new Database(':memory:');
    db.pragma('journal_mode = WAL');

    // Create the booking_flows table (same schema as database.js)
    db.exec(`
      CREATE TABLE IF NOT EXISTS booking_flows (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        remote_jid TEXT NOT NULL,
        state TEXT NOT NULL DEFAULT 'select_game',
        data_json TEXT DEFAULT '{}',
        phone TEXT NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        expires_at DATETIME DEFAULT (datetime('now', '+10 minutes'))
      );
      CREATE INDEX IF NOT EXISTS idx_booking_flows_jid
        ON booking_flows(remote_jid, state);
    `);

    // Load module
    const mod = require('../src/services/bookingStateMachine');
    BookingStateMachine = mod.BookingStateMachine;
    parseNumberedResponse = mod.parseNumberedResponse;
    STATES = mod.STATES;

    machine = new BookingStateMachine(db);
  });

  afterEach(() => {
    db.close();
  });

  const TEST_JID = '917981264279@s.whatsapp.net';

  // Test 1: createFlow creates a row with state='select_game' and phone derived from JID
  it('createFlow creates a row with state=select_game and phone from JID', () => {
    const flow = machine.createFlow(TEST_JID);
    assert.equal(flow.state, 'select_game');
    assert.equal(flow.phone, '7981264279');
    assert.equal(flow.remote_jid, TEST_JID);
  });

  // Test 2: getActiveFlow returns active flow
  it('getActiveFlow returns active flow (not expired, not booked/cancelled)', () => {
    machine.createFlow(TEST_JID);
    const flow = machine.getActiveFlow(TEST_JID);
    assert.ok(flow);
    assert.equal(flow.state, 'select_game');
    assert.equal(flow.remote_jid, TEST_JID);
  });

  // Test 3: getActiveFlow returns null for expired flows
  it('getActiveFlow returns null for expired flows', () => {
    // Create a flow and manually set expires_at to the past
    machine.createFlow(TEST_JID);
    db.prepare(
      "UPDATE booking_flows SET expires_at = datetime('now', '-1 minute') WHERE remote_jid = ?"
    ).run(TEST_JID);

    const flow = machine.getActiveFlow(TEST_JID);
    assert.equal(flow, null);
  });

  // Test 4: advance with game_selected transitions select_game -> select_duration
  it('advance(game_selected) transitions select_game -> select_duration', () => {
    machine.createFlow(TEST_JID);
    const result = machine.advance(TEST_JID, 'game_selected', { game: 'ac' });
    assert.equal(result.state, 'select_duration');
    assert.ok(!result.error);
    // Verify data is merged
    const flow = machine.getActiveFlow(TEST_JID);
    const data = JSON.parse(flow.data_json);
    assert.equal(data.game, 'ac');
  });

  // Test 5: advance with duration_selected transitions select_duration -> confirm
  it('advance(duration_selected) transitions select_duration -> confirm', () => {
    machine.createFlow(TEST_JID);
    machine.advance(TEST_JID, 'game_selected', { game: 'ac' });
    const result = machine.advance(TEST_JID, 'duration_selected', { tier_id: 'tier_30min' });
    assert.equal(result.state, 'confirm');
    assert.ok(!result.error);
    // Verify data is merged
    const flow = machine.getActiveFlow(TEST_JID);
    const data = JSON.parse(flow.data_json);
    assert.equal(data.game, 'ac');
    assert.equal(data.tier_id, 'tier_30min');
  });

  // Test 6: advance with confirmed transitions confirm -> booked
  it('advance(confirmed) transitions confirm -> booked', () => {
    machine.createFlow(TEST_JID);
    machine.advance(TEST_JID, 'game_selected', { game: 'ac' });
    machine.advance(TEST_JID, 'duration_selected', { tier_id: 'tier_30min' });
    const result = machine.advance(TEST_JID, 'confirmed', {});
    assert.equal(result.state, 'booked');
    assert.ok(!result.error);
    // After booking, no active flow
    const flow = machine.getActiveFlow(TEST_JID);
    assert.equal(flow, null);
  });

  // Test 7: advance with cancel transitions any active state -> cancelled
  it('advance(cancel) transitions any active state -> cancelled', () => {
    machine.createFlow(TEST_JID);
    const result = machine.advance(TEST_JID, 'cancel', {});
    assert.equal(result.state, 'cancelled');
    assert.ok(!result.error);
    const flow = machine.getActiveFlow(TEST_JID);
    assert.equal(flow, null);
  });

  // Test 8: advance with invalid event returns error
  it('advance with invalid event returns { error: invalid_transition }', () => {
    machine.createFlow(TEST_JID);
    const result = machine.advance(TEST_JID, 'confirmed', {}); // can't confirm from select_game
    assert.equal(result.error, 'invalid_transition');
  });

  // Test 9: cancelFlow sets state to cancelled
  it('cancelFlow sets state to cancelled', () => {
    machine.createFlow(TEST_JID);
    machine.advance(TEST_JID, 'game_selected', { game: 'f1' });
    machine.cancelFlow(TEST_JID);
    const flow = machine.getActiveFlow(TEST_JID);
    assert.equal(flow, null);
  });

  // Test 10: expireStaleFlows marks old flows as expired
  it('expireStaleFlows marks flows older than 10 minutes as expired', () => {
    machine.createFlow(TEST_JID);
    // Set expires_at to the past
    db.prepare(
      "UPDATE booking_flows SET expires_at = datetime('now', '-1 minute') WHERE remote_jid = ?"
    ).run(TEST_JID);

    const count = machine.expireStaleFlows();
    assert.ok(count >= 1);

    // Verify state is now expired
    const row = db.prepare('SELECT state FROM booking_flows WHERE remote_jid = ?').get(TEST_JID);
    assert.equal(row.state, 'expired');
  });

  // Test 11: Phone is derived from JID, not user input
  it('phone is derived from JID (91XXXXXXXXXX@s.whatsapp.net -> last 10 digits)', () => {
    const flow = machine.createFlow('919876543210@s.whatsapp.net');
    assert.equal(flow.phone, '9876543210');
  });

  // Test 12: parseNumberedResponse('2', options) returns 2nd option
  it('parseNumberedResponse("2", options) returns the 2nd option', () => {
    const options = [
      { text: 'Assetto Corsa', value: 'ac' },
      { text: 'F1 25', value: 'f1' },
      { text: 'Forza Motorsport', value: 'forza' },
    ];
    const result = parseNumberedResponse('2', options);
    assert.deepEqual(result, { text: 'F1 25', value: 'f1' });
  });

  // Test 13: parseNumberedResponse('F1 25', options) returns matching text
  it('parseNumberedResponse("F1 25", options) returns matching text', () => {
    const options = [
      { text: 'Assetto Corsa', value: 'ac' },
      { text: 'F1 25', value: 'f1' },
      { text: 'Forza Motorsport', value: 'forza' },
    ];
    const result = parseNumberedResponse('F1 25', options);
    assert.deepEqual(result, { text: 'F1 25', value: 'f1' });
  });
});

describe('messageParser interactive messages', () => {
  let parseWebhookPayload;

  beforeEach(() => {
    delete require.cache[require.resolve('../src/utils/messageParser')];
    parseWebhookPayload = require('../src/utils/messageParser').parseWebhookPayload;
  });

  // Test 14: messageParser extracts text from buttonsResponseMessage.selectedDisplayText
  it('extracts text from buttonsResponseMessage.selectedDisplayText', () => {
    const body = {
      data: {
        key: { remoteJid: '917981264279@s.whatsapp.net', id: 'msg1', fromMe: false },
        message: {
          buttonsResponseMessage: {
            selectedButtonId: 'btn_ac',
            selectedDisplayText: 'Assetto Corsa',
          },
        },
        pushName: 'Test User',
      },
    };
    const parsed = parseWebhookPayload(body);
    assert.ok(parsed);
    assert.equal(parsed.text, 'Assetto Corsa');
  });

  // Test 15: messageParser extracts text from listResponseMessage.singleSelectReply.selectedRowId
  it('extracts text from listResponseMessage.singleSelectReply.selectedRowId', () => {
    const body = {
      data: {
        key: { remoteJid: '917981264279@s.whatsapp.net', id: 'msg2', fromMe: false },
        message: {
          listResponseMessage: {
            singleSelectReply: {
              selectedRowId: 'tier_30min',
            },
          },
        },
        pushName: 'Test User',
      },
    };
    const parsed = parseWebhookPayload(body);
    assert.ok(parsed);
    assert.equal(parsed.text, 'tier_30min');
  });

  // Test 16: messageParser sets isInteractive: true for button/list responses
  it('sets isInteractive: true for button responses', () => {
    const body = {
      data: {
        key: { remoteJid: '917981264279@s.whatsapp.net', id: 'msg3', fromMe: false },
        message: {
          buttonsResponseMessage: {
            selectedButtonId: 'btn_ac',
            selectedDisplayText: 'Assetto Corsa',
          },
        },
        pushName: 'Test User',
      },
    };
    const parsed = parseWebhookPayload(body);
    assert.ok(parsed);
    assert.equal(parsed.isInteractive, true);
  });

  it('sets isInteractive: false for regular text messages', () => {
    const body = {
      data: {
        key: { remoteJid: '917981264279@s.whatsapp.net', id: 'msg4', fromMe: false },
        message: {
          conversation: 'Hello there',
        },
        pushName: 'Test User',
      },
    };
    const parsed = parseWebhookPayload(body);
    assert.ok(parsed);
    assert.equal(parsed.isInteractive, false);
  });

  it('includes selectedId for button responses', () => {
    const body = {
      data: {
        key: { remoteJid: '917981264279@s.whatsapp.net', id: 'msg5', fromMe: false },
        message: {
          buttonsResponseMessage: {
            selectedButtonId: 'btn_ac',
            selectedDisplayText: 'Assetto Corsa',
          },
        },
        pushName: 'Test User',
      },
    };
    const parsed = parseWebhookPayload(body);
    assert.ok(parsed);
    assert.equal(parsed.selectedId, 'btn_ac');
  });
});
