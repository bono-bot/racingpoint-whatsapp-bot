#!/usr/bin/env node
/**
 * test-racecontrol-api-client.js — smoke tests for racecontrolApiClient.
 *
 * Pre-W1-S6 substrate: the real racecontrol endpoints don't exist yet. This script
 * monkey-patches the global fetch to return canned responses matching the msg=35677
 * §1.1 envelope contract, then exercises:
 *
 *  1. fetchPinForStaff happy path (envelope shape, fields preserved)
 *  2. fetchStaffRegistry happy path (array shape, row fields preserved)
 *  3. RACECONTROL_API_URL missing → CONFIG error
 *  4. RACECONTROL_SERVICE_KEY missing → CONFIG error
 *  5. HTTP 404 → HTTP error with .status=404
 *  6. HTTP 401 → HTTP error with .status=401
 *  7. Malformed JSON → PARSE error
 *  8. fetchPinForStaff envelope missing field → CONTRACT error
 *  9. fetchStaffRegistry non-array envelope → CONTRACT error
 *
 * Exit 0 on all-pass; exit 1 with diagnostic on any failure. Standalone (no test
 * runner dependency).
 */

'use strict';

let passed = 0;
let failed = 0;
const failures = [];

function assert(cond, label) {
  if (cond) {
    passed += 1;
    console.log(`  PASS  ${label}`);
  } else {
    failed += 1;
    failures.push(label);
    console.log(`  FAIL  ${label}`);
  }
}

async function shouldThrow(fn, predicate, label) {
  try {
    await fn();
    failed += 1;
    failures.push(label);
    console.log(`  FAIL  ${label} — expected throw, did not throw`);
  } catch (err) {
    if (predicate(err)) {
      passed += 1;
      console.log(`  PASS  ${label}`);
    } else {
      failed += 1;
      failures.push(label);
      console.log(`  FAIL  ${label} — threw but predicate failed: ${err.name} ${err.message} status=${err.status} code=${err.code}`);
    }
  }
}

// Stub the global fetch via per-test installer. Restored after each test.
const realFetch = global.fetch;
function withFetch(stub, fn) {
  global.fetch = stub;
  return fn().finally(() => { global.fetch = realFetch; });
}

function resp(json, { status = 200, ok = null } = {}) {
  return Promise.resolve({
    ok: ok === null ? status >= 200 && status < 300 : ok,
    status,
    json: () => Promise.resolve(json),
  });
}

function respMalformed(status = 200) {
  return Promise.resolve({
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.reject(new SyntaxError('Unexpected token < in JSON')),
  });
}

function respNetworkError() {
  return Promise.reject(new Error('ECONNREFUSED 127.0.0.1:8080'));
}

(async () => {
  console.log('test-racecontrol-api-client.js — wire-in smoke suite');
  console.log('==================================================');

  // Test 1: fetchPinForStaff happy path
  process.env.RACECONTROL_API_URL = 'http://example/';
  process.env.RACECONTROL_SERVICE_KEY = 'test-service-key';
  // Re-require to avoid module-cache contamination from earlier failed runs (rare).
  delete require.cache[require.resolve('../src/services/racecontrolApiClient')];
  const client = require('../src/services/racecontrolApiClient');

  await withFetch(
    (url, init) => {
      assert(url === 'http://example/api/v2/staff/STAFF_001/pin-of-the-day', 'T1 URL composed correctly');
      assert(init.headers['X-Service-Key'] === 'test-service-key', 'T1 X-Service-Key header sent');
      return resp({
        pin: '123456',
        pin_hash: 'abc'.repeat(21) + 'a',
        staff_id: 'STAFF_001',
        rotated_at_ist: '2026-05-09T06:00:00+05:30',
        expires_at_ist: '2026-05-10T06:00:00+05:30',
      });
    },
    async () => {
      const out = await client.fetchPinForStaff('STAFF_001');
      assert(out.pin === '123456', 'T1 pin field preserved');
      assert(out.staff_id === 'STAFF_001', 'T1 staff_id field preserved');
      assert(typeof out.rotated_at_ist === 'string', 'T1 rotated_at_ist is string');
    }
  );

  // Test 2: fetchStaffRegistry happy path
  await withFetch(
    (url) => {
      assert(url === 'http://example/api/v2/staff?active=true', 'T2 URL composed correctly');
      return resp([
        { staff_id: 'STAFF_001', whatsapp_e164: '917981264279', display_name: 'Captain', active: true, registered_at_ist: '2026-05-01T00:00:00+05:30' },
        { staff_id: 'STAFF_002', whatsapp_e164: '910000000000', display_name: 'TEST', active: true, registered_at_ist: '2026-05-01T00:00:00+05:30' },
      ]);
    },
    async () => {
      const out = await client.fetchStaffRegistry();
      assert(Array.isArray(out), 'T2 returns array');
      assert(out.length === 2, 'T2 array length preserved');
      assert(out[0].staff_id === 'STAFF_001', 'T2 row 0 staff_id preserved');
    }
  );

  // Test 3: RACECONTROL_API_URL missing → CONFIG error
  delete process.env.RACECONTROL_API_URL;
  await shouldThrow(
    () => client.fetchPinForStaff('STAFF_001'),
    (err) => err.name === 'RacecontrolApiError' && err.code === 'CONFIG',
    'T3 missing API_URL → CONFIG error'
  );
  process.env.RACECONTROL_API_URL = 'http://example/';

  // Test 4: RACECONTROL_SERVICE_KEY missing → CONFIG error
  delete process.env.RACECONTROL_SERVICE_KEY;
  await shouldThrow(
    () => client.fetchPinForStaff('STAFF_001'),
    (err) => err.name === 'RacecontrolApiError' && err.code === 'CONFIG',
    'T4 missing SERVICE_KEY → CONFIG error'
  );
  process.env.RACECONTROL_SERVICE_KEY = 'test-service-key';

  // Test 5: HTTP 404
  await withFetch(
    () => resp({ error: 'staff not found' }, { status: 404 }),
    () => shouldThrow(
      () => client.fetchPinForStaff('STAFF_404'),
      (err) => err.name === 'RacecontrolApiError' && err.status === 404 && err.code === 'HTTP',
      'T5 HTTP 404 → HTTP error with status=404'
    )
  );

  // Test 6: HTTP 401
  await withFetch(
    () => resp({ error: 'unauthorized' }, { status: 401 }),
    () => shouldThrow(
      () => client.fetchPinForStaff('STAFF_001'),
      (err) => err.name === 'RacecontrolApiError' && err.status === 401 && err.code === 'HTTP',
      'T6 HTTP 401 → HTTP error with status=401'
    )
  );

  // Test 7: Malformed JSON
  await withFetch(
    () => respMalformed(200),
    () => shouldThrow(
      () => client.fetchPinForStaff('STAFF_001'),
      (err) => err.name === 'RacecontrolApiError' && err.code === 'PARSE',
      'T7 malformed JSON → PARSE error'
    )
  );

  // Test 8: fetchPinForStaff envelope missing field
  await withFetch(
    () => resp({ pin: '123456', pin_hash: 'abc', staff_id: 'STAFF_001' /* missing rotated_at_ist + expires_at_ist */ }),
    () => shouldThrow(
      () => client.fetchPinForStaff('STAFF_001'),
      (err) => err.name === 'RacecontrolApiError' && err.code === 'CONTRACT',
      'T8 envelope missing field → CONTRACT error'
    )
  );

  // Test 9: fetchStaffRegistry non-array
  await withFetch(
    () => resp({ staff: [] /* wrong shape */ }),
    () => shouldThrow(
      () => client.fetchStaffRegistry(),
      (err) => err.name === 'RacecontrolApiError' && err.code === 'CONTRACT',
      'T9 non-array envelope → CONTRACT error'
    )
  );

  // Test 10: Network failure
  await withFetch(
    () => respNetworkError(),
    () => shouldThrow(
      () => client.fetchPinForStaff('STAFF_001'),
      (err) => err.name === 'RacecontrolApiError' && err.code === 'NETWORK',
      'T10 network failure → NETWORK error'
    )
  );

  // Test 11: fetchPinForStaff invalid input
  await shouldThrow(
    () => client.fetchPinForStaff(''),
    (err) => err.name === 'RacecontrolApiError' && err.code === 'INPUT',
    'T11 empty staffId → INPUT error'
  );

  console.log('==================================================');
  console.log(`Result: ${passed} pass / ${failed} fail`);
  if (failed > 0) {
    console.log('Failures:');
    for (const f of failures) console.log(`  - ${f}`);
    process.exit(1);
  }
  process.exit(0);
})();
