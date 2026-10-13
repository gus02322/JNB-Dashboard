import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const R = require('../js/rules.js');

// Rules as a unit would set them in its RULES tab (fictive flight numbers).
const SHEET = {
  WIDEBODY_AIRLINES: 'XW,YW',
  TRUCK_EXCEPTIONS: 'XX848:ETD-120|YY187:ETD-150',
  SEAL_EXCEPTIONS: 'ZZ344:45',
};
const rules = R.readRules(k => SHEET[k]);
const t = R.m2t;

test('times: tolerant reader, midnight safe difference', () => {
  assert.equal(R.t2m('1:25'), 85);
  assert.equal(R.t2m('01:25:00'), 85);
  assert.equal(R.t2m('25:00'), null);
  assert.equal(R.t2m('daily'), null);
  assert.equal(R.diff(R.t2m('00:10'), R.t2m('23:50')), 20);
  assert.equal(R.diff(R.t2m('23:50'), R.t2m('00:10')), -20);
  assert.equal(t(-10), '23:50');
});

test('flight numbers: uppercase, no spaces, no leading zeros, IATA and ICAO', () => {
  assert.equal(R.normFlight('xx0073').norm, 'XX73');
  assert.equal(R.normFlight(' XX 73 ').norm, 'XX73');
  assert.equal(R.normFlight('XXA0073').kind, 'ICAO');
  assert.equal(R.normFlight('X20450').norm, 'X2450');
  assert.equal(R.normFlight('123'), null);
  assert.equal(R.normFlight('XX'), null);
  assert.ok(R.sameFlight('XX0073', 'XX73'));
  assert.deepEqual(R.callsigns('XX0073', { XX: 'XXA' }), ['XXA73', 'XXA0073']);
  assert.deepEqual(R.callsigns('XXA73', {}), ['XXA73']);
  assert.deepEqual(R.callsigns('QQ73', {}), []);
});

test('defaults apply when the Sheet has no value, invalid values fall back too', () => {
  const d = R.readRules(() => undefined);
  assert.equal(d.turnTruck, -30);
  assert.equal(d.dayStopTruck, -180);
  assert.equal(d.box.threshold, 17 * 60);
  const bad = R.readRules(k => (k === 'BOX_D1_CAP' ? 'soon' : k === 'MIN_ROTATION_MIN' ? 'x' : undefined));
  assert.equal(bad.box.d1Cap, 15 * 60);
  assert.equal(bad.minRotation, 60);
});

test('profile TURN: Truck = ETA - 30, Sealing = Truck - 1h', () => {
  const p = R.computeRow({ flight: 'QQ852', eta: '11:25', etd: '13:10' }, rules);
  assert.equal(p.profile, 'TURN');
  assert.equal(t(p.truck), '10:55');
  assert.equal(t(p.seal), '09:55');
});

test('profile DAYSTOP from ground time: Truck = ETD - 3h', () => {
  const p = R.computeRow({ flight: 'QQ840', eta: '08:10', etd: '22:25' }, rules);
  assert.equal(p.profile, 'DAYSTOP');
  assert.equal(t(p.truck), '19:25');
  assert.equal(t(p.seal), '18:25');
});

test('no STA: day stop from the day before, Truck from ETD', () => {
  const p = R.computeRow({ flight: 'QQ62', eta: '', etd: '09:00' }, rules);
  assert.equal(p.profile, 'DAYSTOP');
  assert.equal(p.profileSource, 'no STA');
  assert.equal(t(p.truck), '06:00');
});

test('RULE_PROFILE overrides the ground time', () => {
  const p = R.computeRow({ flight: 'QQ852', eta: '11:25', etd: '13:10', profile: 'day stop' }, rules);
  assert.equal(p.profile, 'DAYSTOP');
  assert.equal(t(p.truck), '10:10');
});

test('exceptions from RULES: Truck ETD - 2h, ETD - 2h30, Sealing 45 min', () => {
  assert.equal(t(R.computeRow({ flight: 'XX848', eta: '03:55', etd: '08:20' }, rules).truck), '06:20');
  assert.equal(t(R.computeRow({ flight: 'YY0187', eta: '18:30', etd: '22:00' }, rules).truck), '19:30');
  const z = R.computeRow({ flight: 'ZZ344', eta: '20:45', etd: '21:45' }, rules);
  assert.equal(t(z.truck), '20:15');
  assert.equal(t(z.seal), '19:30');
});

test('widebody: Sealing = Truck - 2h, by airline or by aircraft type', () => {
  assert.equal(t(R.computeRow({ flight: 'XW764', eta: '16:15', etd: '19:10' }, rules).seal), '13:45');
  assert.equal(t(R.computeRow({ flight: 'QQ1', eta: '16:15', etd: '19:10', aircraft: 'Airbus A350-900' }, rules).seal), '13:45');
  // type known and narrow: the type wins over the airline list
  assert.equal(t(R.computeRow({ flight: 'XW1', eta: '16:15', etd: '19:10', aircraft: 'Airbus A320' }, rules).seal), '14:45');
});

test('row columns TRUCK_OFFSET and SEAL_TO_TRUCK override everything', () => {
  const p = R.computeRow({ flight: 'XX848', eta: '03:55', etd: '08:20', truckOffset: 'ETA-45', sealToTruck: '90' }, rules);
  assert.equal(t(p.truck), '03:10');
  assert.equal(t(p.seal), '01:40');
});

test('manual Sealing and Truck win over the rule', () => {
  const p = R.computeRow({ flight: 'QQ852', eta: '11:25', etd: '13:10', truck: '10:40', sealing: '' }, rules);
  assert.equal(p.truckSource, 'manual');
  assert.equal(t(p.truck), '10:40');
  assert.equal(t(p.seal), '09:40');
});

test('after midnight: ETD next day, Truck before midnight', () => {
  const p = R.computeRow({ flight: 'QQ711', eta: '23:45', etd: '00:45' }, rules);
  assert.equal(p.etd, 24 * 60 + 45);
  assert.equal(t(p.truck), '23:15');
  assert.equal(p.box.day, 'D');
});

test('Box Time: D slot, D-1 capped, D-1 late slot', () => {
  const b = (etd, seal) => R.boxSlot(R.t2m(etd), R.t2m(seal), rules);
  assert.deepEqual(b('19:10', '13:45'), { day: 'D', m: R.t2m('09:45') });
  assert.deepEqual(b('08:20', '05:20'), { day: 'D-1', m: R.t2m('10:20') });
  assert.deepEqual(b('14:50', '10:00'), { day: 'D-1', m: R.t2m('15:00') });
  assert.deepEqual(b('16:25', '14:00'), { day: 'D-1', m: R.t2m('19:00') });
  assert.deepEqual(b('17:00', '14:00'), { day: 'D-1', m: R.t2m('19:00') });
  assert.equal(b('17:01', '14:00').day, 'D');
});

test('delay in TURN: Truck, Sealing, ETD and Box D slide from the threshold', () => {
  const plan = R.computeRow({ flight: 'XW764', eta: '16:15', etd: '19:10' }, rules);
  const small = R.applyEta(plan, plan.eta + 4, rules);
  assert.equal(small.moved, false);
  const d = R.applyEta(plan, plan.eta + 30, rules);
  assert.equal(d.moved, true);
  assert.equal(t(d.truck), '16:15');
  assert.equal(t(d.seal), '14:15');
  assert.equal(t(d.etd), '19:10'); // 16:45 + 60 is still before the STD
  assert.equal(t(d.box.m), '10:15');
  const big = R.applyEta(plan, plan.eta + 150, rules);
  assert.equal(t(big.etd), '19:45');
});

test('delay on a D-1 flight: the slot does not move, it is marked Check', () => {
  const plan = R.computeRow({ flight: 'QQ852', eta: '11:25', etd: '13:10' }, rules);
  const d = R.applyEta(plan, plan.eta + 30, rules);
  assert.equal(d.box.day, 'D-1');
  assert.equal(d.box.m, plan.box.m);
  assert.equal(d.d1Check, true);
});

test('early arrival in TURN moves the plan earlier, ETD stays', () => {
  const plan = R.computeRow({ flight: 'QQ852', eta: '11:25', etd: '13:10' }, rules);
  const d = R.applyEta(plan, plan.eta - 20, rules);
  assert.equal(t(d.truck), '10:35');
  assert.equal(t(d.etd), '13:10');
});

test('DAYSTOP: nothing moves, alert when the ETA eats the margin', () => {
  const plan = R.computeRow({ flight: 'QQ840', eta: '08:10', etd: '22:25' }, rules);
  const ok = R.applyEta(plan, plan.eta + 60, rules);
  assert.equal(ok.moved, false);
  assert.equal(ok.truck, plan.truck);
  assert.equal(ok.marginAlert, false);
  const late = R.applyEta(plan, R.t2m('18:45'), rules);
  assert.equal(late.marginAlert, true);
  assert.equal(late.etd, plan.etd);
});

test('cancellation holds production', () => {
  const plan = R.cancelPlan(R.computeRow({ flight: 'QQ852', eta: '11:25', etd: '13:10' }, rules));
  assert.equal(plan.cancelled, true);
  assert.equal(plan.holdProduction, true);
});

test('checkRow lists the gaps between the Sheet and the rule', () => {
  const c = R.checkRow({ flight: 'QQ762', eta: '10:15', etd: '13:25', truck: '09:35', sealing: '08:35' }, rules, '14:35');
  assert.equal(c.truckGap, 10);   // rule 09:45, Sheet 09:35
  assert.equal(c.sealGap, 10);
  assert.equal(c.boxDay, 'D-1');
  assert.equal(c.boxGap, 25);  // rule: 13:25 + 2h capped at 15:00
});

test('unit clock: offset of a fixed zone', () => {
  assert.equal(R.tzOffsetMin('UTC', Date.UTC(2026, 0, 1)), 0);
  assert.equal(R.tzOffsetMin('Etc/GMT-2', Date.UTC(2026, 0, 1)), 120);
  assert.equal(R.tzOffsetMin('Not/AZone', Date.now()), null);
});
