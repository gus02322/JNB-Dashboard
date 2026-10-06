// Run with: node --test tests/*.test.mjs   (fictive data only)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const C = createRequire(import.meta.url)('../js/live-core.js');

const BOX = { threshold: C.t2m('17:00'), dOffset: -240, d1Offset: 120, d1Cap: C.t2m('15:00'), d1LateSlot: C.t2m('19:00') };
const row = (eta, etd, sealing, truck) => ({ eta, etd, sealing, truck });

test('schedule puts an ETD earlier than the ETA on the next day', () => {
  const s = C.schedule(row('23:45', '00:45', '21:15', '22:00'));
  assert.equal(s.etd, 1440 + 45);
  assert.equal(s.nextDayEtd, true);
  assert.equal(C.schedule(row('', '09:00', '05:15', '06:15')).etd, 540); // departure only, no ETA
});

test('Box Time rule: D regime, D-1 regime, cap, late slot, next-day ETD', () => {
  assert.deepEqual(C.boxSlotFormula(row('16:15', '19:10', '13:45', '15:45'), BOX), { day: 'D', m: C.t2m('09:45') });
  assert.deepEqual(C.boxSlotFormula(row('01:25', '03:00', '00:00', '01:00'), BOX), { day: 'D-1', m: C.t2m('05:00') });
  assert.deepEqual(C.boxSlotFormula(row('11:55', '14:50', '10:00', '11:50'), BOX), { day: 'D-1', m: C.t2m('15:00') });
  assert.deepEqual(C.boxSlotFormula(row('15:25', '16:25', '14:00', '15:00'), BOX), { day: 'D-1', m: C.t2m('19:00') });
  assert.deepEqual(C.boxSlotFormula(row('23:45', '00:45', '21:15', '22:00'), BOX), { day: 'D', m: C.t2m('17:15') });
  assert.equal(C.boxSlotFormula(row('10:00', '', '08:00', '09:00'), BOX), null);
});

test('callsign candidates use the ICAO prefix and also try without leading zeros', () => {
  const px = { ZZ: 'ZZZ', Z9: 'ZNI' };
  assert.deepEqual(C.callsignCandidates('ZZ101', px), ['ZZZ101']);
  assert.deepEqual(C.callsignCandidates('ZZ0073', px), ['ZZZ0073', 'ZZZ73']);
  assert.deepEqual(C.callsignCandidates('Z9 12', px), ['ZNI12']);
  assert.deepEqual(C.callsignCandidates('QQ1', px), []);
});

const P = { lat: 0, lon: 0, maxPosAgeSec: 120, minGsKt: 150, approachMarginMin: 5, groundNm: 5, finalNm: 30, approachNm: 150 };

test('live ETA = distance / ground speed + margin, with confidence', () => {
  // 1 degree of latitude is 60 nm: at 240 kt that is 15 min, plus the 5 min margin.
  const r = C.liveEta({ lat: 1, lon: 0, gs: 240, alt_baro: 20000, seen_pos: 3 }, 600, P);
  assert.equal(r.usable, true);
  assert.ok(Math.abs(r.etaM - 620) < 0.2);
  assert.equal(r.confidence, 'approach');
  assert.equal(C.liveEta({ lat: 0.2, lon: 0, gs: 200, alt_baro: 3000 }, 600, P).confidence, 'final');
  assert.equal(C.liveEta({ lat: 5, lon: 0, gs: 450, alt_baro: 38000 }, 600, P).confidence, 'far');
});

test('live ETA is refused when the data cannot be trusted', () => {
  assert.equal(C.liveEta({ lat: 1, lon: 0, gs: 100, alt_baro: 5000 }, 600, P).reason, 'ground speed too low');
  assert.equal(C.liveEta({ lat: 1, lon: 0, gs: 300, alt_baro: 5000, seen_pos: 500 }, 600, P).reason, 'position too old');
  assert.equal(C.liveEta({ lat: 3, lon: 0, gs: 0, alt_baro: 'ground' }, 600, P).reason, 'on ground elsewhere');
  assert.equal(C.liveEta({ lat: 0.01, lon: 0, gs: 10, alt_baro: 'ground' }, 600, P).landed, true);
  assert.equal(C.liveEta({}, 600, P).usable, false);
});

const R = { minRotationMin: 60, dayStopMinGround: 360 };

test('strip and load: ETD = max(scheduled ETD, live ETA + rotation), Sealing and Truck keep their gaps', () => {
  const f = row('16:00', '17:30', '15:00', '16:00');
  const late = C.estimateDeparture(f, C.t2m('17:00'), R);
  assert.equal(late.dayStop, false);
  assert.equal(late.etd, C.t2m('18:00'));
  assert.equal(late.seal, C.t2m('15:30'));
  assert.equal(late.truck, C.t2m('16:30'));
  const early = C.estimateDeparture(f, C.t2m('15:40'), R);
  assert.equal(early.etd, C.t2m('17:30'));
  assert.equal(early.shift, 0);
});

test('day stop: a late arrival does not move the ETD', () => {
  const f = row('08:00', '19:00', '15:00', '16:00');
  const r = C.estimateDeparture(f, C.t2m('10:00'), R);
  assert.equal(r.dayStop, true);
  assert.equal(r.etd, C.t2m('19:00'));
  assert.equal(r.shift, 0);
});

test('threshold: small moves are ignored, larger ones applied', () => {
  assert.deepEqual(C.applyWithThreshold(600, 603, 5), { value: 600, changed: false });
  assert.deepEqual(C.applyWithThreshold(600, 606, 5), { value: 606, changed: true });
  assert.deepEqual(C.applyWithThreshold(600, null, 5), { value: 600, changed: false });
});

test('round5 and m2t never promise minute accuracy', () => {
  assert.equal(C.m2t(C.round5(612)), '10:10');
  assert.equal(C.m2t(1440 + 45), '00:45');
});

test('an aircraft flying away from the airport gives no ETA', () => {
  // 1 degree north of the airport: heading south (180) approaches, heading north (0) flies away.
  assert.equal(C.liveEta({ lat: 1, lon: 0, gs: 300, alt_baro: 20000, track: 180 }, 600, P).usable, true);
  assert.equal(C.liveEta({ lat: 1, lon: 0, gs: 300, alt_baro: 20000, track: 0 }, 600, P).reason, 'flying away from the airport');
  assert.equal(C.liveEta({ lat: 1, lon: 0, gs: 300, alt_baro: 20000 }, 600, P).usable, true); // no track: not refused
});

const LV = { posFreshMult: 2, refreshSec: 1200, posMediumMin: 30, posLowMin: 60, uncertaintyFactor: 0.15, approachMarginMin: 5 };

test('levels: never seen, live, lost, landed', () => {
  const now = 10_000_000;
  assert.equal(C.arrivalLevel({}, now, LV), null);
  assert.equal(C.arrivalLevel({ eta: 600, seenAt: now - 30 * 60e3 }, now, LV), 'live'); // 30 min <= 2 x 20 min
  assert.equal(C.arrivalLevel({ eta: 600, seenAt: now - 41 * 60e3 }, now, LV), 'lost');
  assert.equal(C.arrivalLevel({ eta: 600, seenAt: now - 90 * 60e3, landedAt: 590 }, now, LV), 'landed');
});

test('dead reckoning stays consistent with the last live ETA', () => {
  // Last seen 2 degrees north (120 nm) at 480 kt. ETA 600, now 590, margin 5: 5 min left = 40 nm.
  const r = C.deadReckon({ lat: 2, lon: 0, gs: 480 }, { lat: 0, lon: 0 }, 600, 590, 20, LV);
  assert.ok(Math.abs(r.distNm - 40) < 1e-9);
  assert.ok(Math.abs(r.lat - 40 / 60) < 0.01 && Math.abs(r.lon) < 1e-9);
  assert.ok(Math.abs(r.uncKm - 0.15 * 480 * 20 / 60 * 1.852) < 1e-9);
  assert.equal(r.confidence, 'high');
  assert.equal(r.arrived, false);
  const late = C.deadReckon({ lat: 2, lon: 0, gs: 480 }, { lat: 0, lon: 0 }, 600, 620, 70, LV);
  assert.equal(late.distNm, 0);
  assert.equal(late.arrived, true);
  assert.equal(late.confidence, 'low');
  assert.equal(C.confidenceFromAge(45, LV), 'medium');
});

test('map fraction and arrival status', () => {
  assert.equal(C.mapFraction(0, 9000), 1);
  assert.equal(C.mapFraction(4500, 9000), 0.5);
  assert.equal(C.mapFraction(20000, 9000), 0);
  assert.equal(C.arrivalStatus(700, 600, null, 5).text, 'ETA in 1h 40m');
  assert.equal(C.arrivalStatus(700, 697, null, 5).text, 'Due now');
  assert.equal(C.arrivalStatus(700, 720, null, 5).text, 'Scheduled time passed, no live confirmation');
  assert.equal(C.arrivalStatus(700, 720, 712, 5).text, 'Landed 11:52 (detected)');
});

test('median ignores non numbers, schedule estimate only inside the flight', () => {
  assert.equal(C.median([5, 1, 100, 3]), 4);
  assert.equal(C.median([7, NaN, 2, 9]), 7);
  assert.equal(C.median([]), null);
  const e = C.scheduleEstimate({ lat: 10, lon: 0 }, { lat: 0, lon: 0 }, 700, 640, 240);
  assert.ok(Math.abs(e.fraction - 0.75) < 1e-9);
  assert.equal(C.scheduleEstimate({ lat: 10, lon: 0 }, { lat: 0, lon: 0 }, 700, 300, 240), null);
});
