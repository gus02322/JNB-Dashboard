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
