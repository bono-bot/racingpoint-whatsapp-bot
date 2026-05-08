#!/usr/bin/env node
/**
 * test-racecontrol-stubs-delegation.js — verify tri-modal runtime path in racecontrolStubs.js
 *
 * Modes tested:
 *   1. HTTP_ENABLED=true → delegates to racecontrolApiClient
 *   2. STUB_ENABLED=true → returns mock data
 *   3. (both unset) → throws STUB-W1-S6-PENDING
 *   4. Both set → HTTP wins
 *
 * Run from racingpoint-whatsapp-bot repo root:
 *   node scripts/test-racecontrol-stubs-delegation.js
 *
 * Exit 0 on all-pass; 1 on any failure.
 */

'use strict';

let passed = 0;
let failed = 0;

function assert(cond, label) {
  if (cond) { passed += 1; console.log(`  PASS  ${label}`); }
  else { failed += 1; console.log(`  FAIL  ${label}`); }
}

async function shouldThrow(fn, predicate, label) {
  try { await fn(); failed += 1; console.log(`  FAIL  ${label} — did not throw`); }
  catch (err) {
    if (predicate(err)) { passed += 1; console.log(`  PASS  ${label}`); }
    else { failed += 1; console.log(`  FAIL  ${label} — wrong throw: ${err.message}`); }
  }
}

function fresh(envOverrides) {
  // Strip + reapply env, then bust module cache for both files
  delete process.env.STAFF_PIN_HTTP_ENABLED;
  delete process.env.STAFF_PIN_STUB_ENABLED;
  delete process.env.RACECONTROL_API_URL;
  delete process.env.RACECONTROL_SERVICE_KEY;
  for (const [k, v] of Object.entries(envOverrides)) process.env[k] = v;
  delete require.cache[require.resolve('../src/services/racecontrolStubs')];
  delete require.cache[require.resolve('../src/services/racecontrolApiClient')];
  return require('../src/services/racecontrolStubs');
}

const realFetch = global.fetch;
function withFetch(stub, fn) {
  global.fetch = stub;
  return fn().finally(() => { global.fetch = realFetch; });
}

(async () => {
  console.log('test-racecontrol-stubs-delegation.js — tri-modal runtime path');
  console.log('================================================================');

  // Mode 3: both flags unset → throws (production-mode default)
  {
    const stubs = fresh({});
    assert(stubs.HTTP_ENABLED === false, 'M3 HTTP_ENABLED reads false from unset env');
    assert(stubs.STUB_ENABLED === false, 'M3 STUB_ENABLED reads false from unset env');
    await shouldThrow(
      () => stubs.fetchPinForStaff('STAFF_001'),
      (err) => err.message.includes('STUB-W1-S6-PENDING'),
      'M3 fetchPinForStaff throws STUB-W1-S6-PENDING'
    );
    const reg = await stubs.fetchStaffRegistry();
    assert(Array.isArray(reg) && reg.length === 0, 'M3 fetchStaffRegistry returns []');
  }

  // Mode 2: STUB_ENABLED=true → returns mock data (existing scaffolding-test behavior)
  {
    const stubs = fresh({ STAFF_PIN_STUB_ENABLED: 'true' });
    assert(stubs.STUB_ENABLED === true, 'M2 STUB_ENABLED reads true');
    assert(stubs.HTTP_ENABLED === false, 'M2 HTTP_ENABLED reads false');
    const pin = await stubs.fetchPinForStaff('STAFF_001');
    assert(typeof pin.pin === 'string' && pin.pin.length === 6, 'M2 STUB returns 6-digit pin');
    assert(pin.staff_id === 'STAFF_001', 'M2 STUB preserves staff_id');
    const reg = await stubs.fetchStaffRegistry();
    assert(Array.isArray(reg) && reg.length === 1, 'M2 STUB registry has 1 entry');
    assert(reg[0].whatsapp_e164 === '917981264279', 'M2 STUB registry has Captain WhatsApp');
  }

  // Mode 1: HTTP_ENABLED=true → delegates to racecontrolApiClient (mocked fetch)
  {
    const stubs = fresh({
      STAFF_PIN_HTTP_ENABLED: 'true',
      RACECONTROL_API_URL: 'http://example/',
      RACECONTROL_SERVICE_KEY: 'test-key',
    });
    assert(stubs.HTTP_ENABLED === true, 'M1 HTTP_ENABLED reads true');
    assert(stubs.STUB_ENABLED === false, 'M1 STUB_ENABLED reads false');

    let urlSeen = null;
    let keySeen = null;
    await withFetch(
      (url, init) => {
        urlSeen = url; keySeen = init.headers['X-Service-Key'];
        return Promise.resolve({
          ok: true, status: 200,
          json: () => Promise.resolve({
            pin: '654321',
            pin_hash: 'a'.repeat(64),
            staff_id: 'STAFF_HTTP_001',
            rotated_at_ist: '2026-05-09T06:00:00+05:30',
            expires_at_ist: '2026-05-10T06:00:00+05:30',
          }),
        });
      },
      async () => {
        const out = await stubs.fetchPinForStaff('STAFF_HTTP_001');
        assert(urlSeen === 'http://example/api/v2/staff/STAFF_HTTP_001/pin-of-the-day', 'M1 delegated GET hits correct URL');
        assert(keySeen === 'test-key', 'M1 delegated GET sends X-Service-Key');
        assert(out.pin === '654321', 'M1 delegated response pin field preserved');
      }
    );

    await withFetch(
      () => Promise.resolve({
        ok: true, status: 200,
        json: () => Promise.resolve([
          { staff_id: 'A', whatsapp_e164: '910000000001', display_name: 'A', active: true, registered_at_ist: '2026-05-01T00:00:00+05:30' },
        ]),
      }),
      async () => {
        const reg = await stubs.fetchStaffRegistry();
        assert(Array.isArray(reg) && reg.length === 1, 'M1 delegated registry returns array');
        assert(reg[0].staff_id === 'A', 'M1 delegated registry row preserved');
      }
    );
  }

  // Mode 4: both flags set → HTTP wins (production-readiness > test-fixture precedence)
  {
    const stubs = fresh({
      STAFF_PIN_HTTP_ENABLED: 'true',
      STAFF_PIN_STUB_ENABLED: 'true',
      RACECONTROL_API_URL: 'http://example/',
      RACECONTROL_SERVICE_KEY: 'test-key',
    });
    assert(stubs.HTTP_ENABLED === true && stubs.STUB_ENABLED === true, 'M4 both flags true');

    let httpHit = false;
    await withFetch(
      () => {
        httpHit = true;
        return Promise.resolve({
          ok: true, status: 200,
          json: () => Promise.resolve({
            pin: '111111',
            pin_hash: 'b'.repeat(64),
            staff_id: 'BOTH',
            rotated_at_ist: '2026-05-09T06:00:00+05:30',
            expires_at_ist: '2026-05-10T06:00:00+05:30',
          }),
        });
      },
      async () => {
        const out = await stubs.fetchPinForStaff('BOTH');
        assert(httpHit === true, 'M4 HTTP path was invoked (not STUB)');
        assert(out.pin === '111111', 'M4 HTTP response returned (not STUB mock)');
      }
    );
  }

  console.log('================================================================');
  console.log(`Result: ${passed} pass / ${failed} fail`);
  process.exit(failed > 0 ? 1 : 0);
})();
