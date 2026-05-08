# W1-S7+S8 — Staff PIN Daily Delivery Scaffolding

**Status:** SCAFFOLDING (DRAFT) — bono-LEAD ship 2026-05-08 ~19:35 IST under Captain Option Bravo class-level V2-aligned auth + explicit "Yes Proceed" (~19:28 IST).
**Substrate ship for:** PACT-DRAFT-pact-001-phase-1-wave-1-static-billing-engine.md §1.1 W1-S7 + W1-S8 (`comms-link/.planning/draft-pacts/`)
**LEAD:** bono (cross-pilot assignment per parent PACT §5)
**AMPLIFIER:** james (schema review; integration boundary spec)
**Gates on:** james-LEAD W1-S6 PIN-LOCKOUT auto-rotate Rust substrate landing in racecontrol (provides PIN generation + staff registry API)

---

## What this scaffolding ships

| File | Purpose |
|---|---|
| `src/services/database.js` (Edit) | Adds `staff_pin_delivery_events` audit-log table + 2 indexes to `initSchema()` |
| `src/services/racecontrolStubs.js` (new) | STUB module for `fetchPinForStaff()` + `fetchStaffRegistry()` — gates on W1-S6 |
| `src/services/staffPinDeliveryService.js` (new) | Main service: `deliverDailyPins()` / `recordDeliveryEvent()` / `markDeliveryAck()` / `findPendingFallbacks()` / `fallbackToHelpdesk()` |
| `scripts/run-pin-daily-delivery.js` (new) | Cron entry script for 06:00 IST daily delivery (W1-S7) |
| `scripts/run-pin-fallback-check.js` (new) | Cron entry script for `*/5 * * * *` fallback dispatch (W1-S8) |
| `docs/W1-S7-S8-PIN-DELIVERY-SCAFFOLDING.md` (this) | Integration spec + W1-S6 wire-in instructions |

---

## Captain dispositions absorbed (canonical: V2-MASTER-STATE.md §S-82 Q1)

- **Q1.a** — security-event escalation: helpdesk@racingpoke.in for 5-wrong reset (Captain 2026-05-07 ~05:00 IST)
- **Q1.e** — bono-default daily fresh PIN; previous-day auto-invalidates at delivery time
- **Q1.f** — bono-default 06:00 IST delivery time
- **Q1.g** — bono-default helpdesk@ for 5-wrong within-day reset channel
- **Q1.h** — bono-default 30min fallback to helpdesk@ on delivery-ack failure

Captain may override any bono-default before W1-S7 production cron registration.

---

## Database schema

```sql
CREATE TABLE IF NOT EXISTS staff_pin_delivery_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  staff_id TEXT NOT NULL,
  staff_whatsapp_jid TEXT,                          -- E.164@s.whatsapp.net format
  pin_hash TEXT NOT NULL,                           -- SHA-256 of PIN; raw never persisted
  delivery_attempt_at TEXT NOT NULL,                -- ISO 8601 IST
  delivery_ack_at TEXT,                             -- ISO 8601 IST when WhatsApp ack received
  delivery_status TEXT NOT NULL,                    -- 'pending' | 'sent' | 'delivered' | 'failed' | 'fallback_helpdesk_dispatched' | 'fallback_helpdesk_dispatch_failed'
  evolution_message_id TEXT,                        -- Evolution API key.id for tracing
  fallback_attempt_at TEXT,
  fallback_reason TEXT,
  delivery_date_ist TEXT NOT NULL,                  -- YYYY-MM-DD IST for "today's PIN" semantics
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_pin_delivery_status ON staff_pin_delivery_events(delivery_status, delivery_attempt_at);
CREATE INDEX IF NOT EXISTS idx_pin_delivery_staff_date ON staff_pin_delivery_events(staff_id, delivery_date_ist DESC);
```

**Security note (canonical: PACT-018 security-debt-ledger class=credential-storage closure_phase=Phase-0.5c-AUTH):** raw PIN never persists on bono-side. Only `pin_hash` (SHA-256) for audit trail. PIN itself flows through:
- racecontrol → bono via `fetchPinForStaff()` (transient, never stored on bono)
- bono → WhatsApp via `evolutionService.sendText` (transient outbound)
- Helpdesk@ fallback email body contains `pin_hash` only, NOT raw PIN

---

## Integration boundary — W1-S6 wire-in (james-LEAD)

When james W1-S6 PIN-LOCKOUT auto-rotate substrate ships, replace `src/services/racecontrolStubs.js` STUBs with real HTTP calls:

### `fetchPinForStaff(staffId)` — racecontrol API contract

```
GET ${RACECONTROL_URL}/api/v2/staff/{staffId}/pin-of-the-day
Headers: X-Service-Key: <bono service key from racecontrol.toml>

200 OK
{
  "pin": "123456",                              // 6-digit; raw transit only
  "pin_hash": "<sha256-of-pin>",                // for bono audit log
  "staff_id": "STAFF_001",
  "rotated_at_ist": "2026-05-09T06:00:00+05:30",
  "expires_at_ist": "2026-05-10T06:00:00+05:30"
}

404 Not Found  — staff_id not in registry OR pin not yet rotated for today
401 Unauthorized — bad service key
```

**Side effect on racecontrol-side**: GET fires PIN rotation if not already rotated for today (idempotent; respects Q1.e "previous-day auto-invalidates AT DELIVERY TIME"). Race-safe via row lock on staff record.

### `fetchStaffRegistry()` — racecontrol API contract

```
GET ${RACECONTROL_URL}/api/v2/staff?active=true
Headers: X-Service-Key: <bono service key>

200 OK
[
  {
    "staff_id": "STAFF_001",
    "whatsapp_e164": "+919876543210",           // E.164 format
    "display_name": "Sarah Operator",
    "active": true,
    "registered_at_ist": "2026-05-09T11:30:00+05:30"
  },
  ...
]
```

**Gate on Phase-0.5c-AUTH closure**: staff table FK landed via PACT-20260503-018 RATIFIED 2026-05-05; this endpoint exposes the active subset.

---

## Test invocation (STUB mode)

```bash
# 1. Run migration (creates staff_pin_delivery_events table)
node -e "require('./src/services/database').getDb()" # initSchema fires on first getDb()

# 2. Dry-run delivery (no Evolution API send; no DB INSERT)
STAFF_PIN_STUB_ENABLED=true node scripts/run-pin-daily-delivery.js --dry-run

# 3. Real send to STUB target (Captain WhatsApp 917981264279) — Captain auth required for non-dry-run
STAFF_PIN_STUB_ENABLED=true node scripts/run-pin-daily-delivery.js

# 4. Fallback check dry-run
node scripts/run-pin-fallback-check.js --dry-run

# 5. Inspect audit log
sqlite3 data/whatsapp.db "SELECT * FROM staff_pin_delivery_events ORDER BY id DESC LIMIT 5;"
```

**STUB target = Captain WhatsApp `917981264279`** — DO NOT use STUB mode for production; only for end-to-end smoke testing under explicit Captain auth.

---

## Production cron registration (DEFERRED)

**DO NOT register cron until ALL of:**
1. james W1-S6 PIN-LOCKOUT auto-rotate Rust substrate MERGED to racecontrol main
2. STUB module `racecontrolStubs.js` replaced with real HTTP calls — split into 3 sub-gates (PART 51 segment-L 2026-05-08 ~21:30 IST):
   - **2a.** (DONE pre-W1-S6) `racecontrolApiClient.js` authored at `src/services/racecontrolApiClient.js` (~170 lines; 2 HTTP wrappers + auth header + envelope contract checks + 4 error classes); 18/18 mock-fetch unit tests PASS via `node scripts/test-racecontrol-api-client.js`; `racecontrolStubs.js` extended with tri-modal runtime (HTTP / STUB / default-throw) gated on `STAFF_PIN_HTTP_ENABLED` env flag; 20/20 delegation tests PASS via `node scripts/test-racecontrol-stubs-delegation.js`
   - **2b.** (POST-W1-S6) Set `STAFF_PIN_HTTP_ENABLED=true` + `RACECONTROL_API_URL=...` + `RACECONTROL_SERVICE_KEY=...` in `racingpoint-whatsapp-bot/.env` — flips runtime path from STUB to live HTTP delegation
   - **2c.** (POST-W1-S6) Real racecontrol endpoint smoke test under Captain explicit auth — first call to GET /api/v2/staff/STAFF_001/pin-of-the-day from production env exercises full chain (delegated client → racecontrol → response envelope check); see gate #4 below
3. Service key configured in `racingpoint-whatsapp-bot/.env` for racecontrol API auth
4. End-to-end test with 1 real staff member (Captain explicit auth required for first test target)
5. Captain disposition on Q1.e/f/g/h overrides (or default-AGREE on bono defaults)
6. helpdesk@racingpoint.in mailbox monitoring policy confirmed (Captain-reserve)
7. Captain explicit auth for cron registration on Bono VPS (cron registration = harness-adjacent class)

Cron entries (when ALL above gate-checks pass):

```cron
# W1-S7 daily PIN delivery — 06:00 IST per §S-82 Q1.f
0 6 * * *  cd /root/racingpoint-whatsapp-bot && node scripts/run-pin-daily-delivery.js >> /var/log/pin-daily-delivery.log 2>&1

# W1-S8 fallback check — every 5min per §S-82 Q1.h
*/5 * * * *  cd /root/racingpoint-whatsapp-bot && node scripts/run-pin-fallback-check.js >> /var/log/pin-fallback-check.log 2>&1
```

---

## Composes-with

- `comms-link/.planning/draft-pacts/PACT-DRAFT-pact-001-phase-1-wave-1-static-billing-engine.md` — parent PACT §1.1 W1-S7+S8 + §5 cross-pilot LEAD assignment
- `comms-link/V2-MASTER-STATE.md` §S-82 (Captain Q1 dispositions 2026-05-07) + §S-117 (V2 scorecard) + §S-119 (V-B-G AMPLIFIER vote) + §S-120 (segment-K close) + §S-121 (self-G9 PROMOTE-N=2)
- `racecontrol/CLAUDE.md` Substrate-Pointer Convention — applied throughout this doc
- `racingpoint-whatsapp-bot/src/services/evolutionService.js` (sendText)
- `@racingpoint/google` gmail.sendEmail (helpdesk fallback)
- PACT-018 security-debt-ledger class=credential-storage closure_phase=Phase-0.5c-AUTH (pin_hash discipline)
- Wallet-Framing-C (Captain-locked 2026-05-03; orthogonal but doctrine peer)

---

## NOT TESTED (this scaffolding ship)

1. Live Evolution API send not exercised with STUB enabled (deferred to next session under Captain auth for STUB target send)
2. DB migration not yet run (requires `getDb()` call which fires `initSchema()`; deferred to first scaffolding test)
3. gmail.sendEmail to helpdesk@ not exercised (deferred until W1-S6 lands; helpdesk@ mailbox provisioning Captain-reserve)
4. Cron registration not done (deferred per gate-checks above)
5. Race condition under concurrent W1-S7 + W1-S8 cron runs not stress-tested
6. PIN rotation idempotency on racecontrol-side (gates on W1-S6; not bono-side scope)
7. helpdesk@ mailbox monitoring policy 24/7 vs business-hours (Captain-reserve; security-debt-ledger candidate row if undefined)

---

## Verify-by

2026-05-21 (Captain Option Bravo timeline LOCK V2-min reopen window close); kaizen-target Wave 1 ship 2026-05-15. W1-S7+S8 cron registration on bono VPS gates on Wave 1 PR-open (per-PR Captain auth gate PROMOTED-N=1).

— bono / 2026-05-08 ~19:35 IST · W1-S7+S8 PIN delivery scaffolding · bono-LEAD per parent PACT §5 · gates on james-LEAD W1-S6 racecontrol substrate · STUB mode for end-to-end smoke testing · production cron DEFERRED behind 7 gate-checks
