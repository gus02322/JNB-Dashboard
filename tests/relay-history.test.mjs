// Runs apps-script/live-relay.gs against in-memory mocks of the Apps Script services. Fictive data only.
// Run with: node --test tests/*.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const CODE = fs.readFileSync(new URL('../apps-script/live-relay.gs', import.meta.url), 'utf8');

function makeEnv(opts = {}) {
  let now = 0;
  const RealDate = Date;
  class FakeDate extends RealDate { constructor(...a) { if (a.length) super(...a); else super(now); } static now() { return now; } }
  const sheets = {}, writes = [];
  function sheet(name, rows) {
    const s = {
      name, rows: rows.map(r => r.slice()),
      getName: () => name,
      getDataRange: () => ({ getDisplayValues: () => { const w = Math.max(0, ...s.rows.map(r => (r || []).length)); return s.rows.map(r => Array.from({ length: w }, (_, i) => String((r || [])[i] ?? ''))); } }),
      getRange: (r, c, nr, nc) => ({
        setNumberFormat() { return this; }, setFontWeight() { return this; },
        setValues(v) { writes.push(name); v.forEach((row, i) => { s.rows[r - 1 + i] = s.rows[r - 1 + i] || []; row.forEach((x, j) => { s.rows[r - 1 + i][c - 1 + j] = x; }); }); return this; },
        clearContent() { writes.push(name); for (let i = 0; i < nr; i++) if (s.rows[r - 1 + i]) s.rows[r - 1 + i] = []; return this; },
      }),
      getLastRow: () => { let n = s.rows.length; while (n && !(s.rows[n - 1] || []).some(v => v !== '' && v !== undefined)) n--; return n; },
      getMaxRows: () => 1000, setFrozenRows() {},
    };
    sheets[name] = s; return s;
  }
  const ss = { getSheetByName: n => sheets[n] || null, insertSheet: n => sheet(n, []), getName: () => 'Demo book' };
  const cache = new Map(), props = { TRIGGER_MIN: '15', ...(opts.props || {}) };
  let api = {}, adb = () => ({ code: 204 });
  const adbCalls = [];
  const ctx = {
    Date: FakeDate, Math, JSON, parseInt, parseFloat, isFinite, String, Array, Object, RegExp, Error,
    console,
    SpreadsheetApp: { getActiveSpreadsheet: () => ss, openById: () => ss, getUi: () => { throw new Error('no ui'); } },
    CacheService: { getScriptCache: () => ({
      get: k => { const e = cache.get(k); return e && e.exp > now ? e.v : null; },
      put: (k, v, ttl) => cache.set(k, { v, exp: now + ttl * 1000 }), remove: k => cache.delete(k) }) },
    PropertiesService: { getScriptProperties: () => ({ getProperty: k => props[k] ?? null, setProperty: (k, v) => { props[k] = v; } }) },
    LockService: { getScriptLock: () => ({ tryLock: () => true, releaseLock() {} }) },
    Session: { getScriptTimeZone: () => 'UTC' },
    Logger: { log() {} },
    Utilities: { formatDate: (d, tz, f) => {
      const iso = new RealDate(d.getTime()).toISOString();
      const day = new RealDate(d.getTime()).getUTCDay();
      return { 'yyyy-MM-dd': iso.slice(0, 10), H: String(parseInt(iso.slice(11, 13), 10)), m: String(parseInt(iso.slice(14, 16), 10)),
        u: String(day === 0 ? 7 : day), 'yyyy-MM-dd HH:mm': iso.slice(0, 10) + ' ' + iso.slice(11, 16), 'yyyy-MM': iso.slice(0, 7),
        d: String(parseInt(iso.slice(8, 10), 10)), 'HH:mm': iso.slice(11, 16), "yyyy-MM-dd'T'HH:mm": iso.slice(0, 16) }[f];
    } },
    UrlFetchApp: {
      fetchAll: reqs => reqs.map(r => { const cs = r.url.split('/').pop(); return { getResponseCode: () => 200, getContentText: () => JSON.stringify({ ac: api[cs] || [] }) }; }),
      fetch: (url) => {
        if (url.includes('aerodatabox')) { adbCalls.push(url); const r = adb(url); return { getResponseCode: () => r.code, getContentText: () => JSON.stringify(r.body || {}) }; }
        return { getResponseCode: () => 200, getContentText: () => JSON.stringify({ ac: [] }) };
      },
    },
    ContentService: { createTextOutput: t => ({ setMimeType() { return t; } }), MimeType: { JSON: 'json' } },
  };
  vm.createContext(ctx);
  vm.runInContext(CODE, ctx);
  sheet('DEMO', [
    ['DEMO TITLE'],
    ['SI', 'AIRLINE', 'H/W', 'FLIGHT', 'ETA', 'ETD', 'Sealing', 'Truck Dep', 'DAYS', 'FLIGHT_OUT', 'FLIGHT_IN', 'CALLSIGN', 'ACTIVE', 'AUTO_CALLSIGN'],
    ['1', 'Demo One', 'Halal', 'ZZ790', '10:00', '12:00', '08:00', '09:00', '1234567', '', 'ZZ789', '', '', ''],
    ['2', 'Demo Two', 'Western', 'YY456', '23:50', '01:30', '22:00', '23:00', '1234567', '', '', '', '', ''],
    ['3', 'Demo Three', 'Western', 'XX123', '10:00', '12:00', '08:00', '09:00', '1234567', '', '', '', '', ''],
    ['4', 'Demo Three', 'Western', 'XX123', '10:30', '12:30', '08:30', '09:30', '1234567', '', '', '', '', ''],
    ['5', 'Demo Four', 'Western', 'WW1', '10:00', '12:00', '08:00', '09:00', '0', '', '', '', '', ''],
    ['6', 'Demo Five', 'Western', 'VV7', '10:00', '12:00', '08:00', '09:00', '1234567', '', '', 'VVQ7', '', ''],
  ]);
  sheet('NEWU', [['FLIGHT'], ['ZZ0100'], ['ZZ300'], ['ZZ500'], ['ZZ700'], ['QQ999']]);
  sheet('Airlines', [['NAME', 'COLOR', 'IATA', 'ICAO'], ['Demo One', '#fff', 'ZZ', 'ZZC'], ['Demo Two', '#fff', 'YY', 'YYB'], ['Demo Three', '#fff', 'XX', 'XXA'], ['Demo Four', '#fff', 'WW', 'WWD']]);
  sheet('RULES', [['KEY', 'VALUE', 'DESCRIPTION'], ['UNITS', 'DEMO,NEWU', ''], ['DEFAULT_UNIT', 'DEMO', ''], ['AIRPORT_LAT', '0', ''], ['AIRPORT_LON', '0', ''],
    ['HISTORY_ENABLED', 'TRUE', ''], ['HISTORY_KEEP_DAYS', '90', ''], ['HISTORY_OUTLIER_MAX_MIN', '360', ''], ['LANDED_RADIUS_NM', '5', ''],
    ['APPROACH_MARGIN_MIN', '5', ''], ['MIN_GS_KT', '150', ''], ['TIMEZONE', 'UTC', ''], ['ADSB_REFRESH_SEC', '1200', ''], ['DAY_STOP_MIN_GROUND', '360', '']]);
  sheet('RULES_DEMO', [['KEY', 'VALUE', 'DESCRIPTION'], ['AIRPORT_ICAO', 'XXXX', '']]);
  sheet('RULES_NEWU', [['KEY', 'VALUE', 'DESCRIPTION'], ['AIRPORT_ICAO', 'YYYY', '']]);
  return {
    ctx, sheets, writes, props, adbCalls,
    at(iso) { now = new RealDate(iso).getTime(); },
    api(v) { api = v; },
    adb(fn) { adb = fn; },
    history() { const s = sheets.History; return s ? s.rows.slice(1).filter(r => r && r.length && r[0]) : []; },
    table(name) { const s = sheets[name]; const v = s.getDataRange().getDisplayValues(); const hi = v.findIndex(r => r.includes('FLIGHT')); return v.slice(hi + 1).map(r => Object.fromEntries(v[hi].map((h, i) => [h, r[i]]))); },
    audit() { const s = sheets.Audit; return s ? s.rows.slice(1).filter(r => r && r.length && r[0]) : []; },
  };
}

const flying = (lat, track) => [{ flight: 'X', lat, lon: 0, gs: 480, alt_baro: 30000, track, seen_pos: 0 }];
const ground = [{ flight: 'X', lat: 0.01, lon: 0, gs: 5, alt_baro: 'ground', seen_pos: 0 }];

test('landing recorded with deviation, upsert without duplicates, FLIGHT_IN used', () => {
  const e = makeEnv();
  e.at('2026-10-06T09:30:00Z'); e.api({ ZZC789: flying(2, 180) }); e.ctx.recordHistory();
  e.at('2026-10-06T09:45:00Z'); e.ctx.recordHistory();
  e.at('2026-10-06T10:12:00Z'); e.api({ ZZC789: ground }); e.ctx.recordHistory();
  const rows = e.history().filter(r => r[1] === 'ZZ789');
  assert.equal(rows.length, 1);
  const [date, flight, eta, first, etaLive, last, landed, dev, precision, , unit] = rows[0];
  assert.deepEqual([date, flight, eta, first, landed, dev, precision, unit], ['2026-10-06', 'ZZ789', '10:00', '2026-10-06 09:30', '2026-10-06 10:12', '12', '15', 'DEMO']);
  assert.equal(last, '2026-10-06 09:45');
  assert.equal(etaLive, '09:50'); // 120 nm at 480 kt = 15 min + 5 min margin
});

test('callsign learning: the callsign seen is written to AUTO_CALLSIGN and logged in Audit', () => {
  const e = makeEnv();
  e.at('2026-10-06T09:30:00Z'); e.api({ VVQ7: flying(2, 180) }); e.ctx.recordHistory();
  assert.equal(e.table('DEMO').find(r => r.FLIGHT === 'VV7').AUTO_CALLSIGN, 'VVQ7');
  const a = e.audit();
  assert.equal(a.length, 1);
  assert.equal(a[0][1], 'live tracking: callsign seen');
  assert.match(a[0][2], /^DEMO row 8 VV7 AUTO_CALLSIGN$/);
  e.at('2026-10-06T09:45:00Z'); e.ctx.recordHistory();
  assert.equal(e.audit().length, 1); // no change, no new audit row
});

test('a parked aircraft never seen in flight is not a landing', () => {
  const e = makeEnv();
  e.at('2026-10-06T10:05:00Z'); e.api({ ZZC789: ground }); e.ctx.recordHistory();
  assert.equal(e.history().filter(r => r[1] === 'ZZ789' && r[6]).length, 0);
});

test('arrival after midnight keeps the operating date and a positive deviation', () => {
  const e = makeEnv();
  e.at('2026-10-06T23:40:00Z'); e.api({ YYB456: flying(1, 180) }); e.ctx.recordHistory();
  e.at('2026-10-07T00:20:00Z'); e.api({ YYB456: ground }); e.ctx.recordHistory();
  const r = e.history().find(x => x[1] === 'YY456');
  assert.equal(r[0], '2026-10-06');
  assert.equal(r[6], '2026-10-07 00:20');
  assert.equal(r[7], '30');
});

test('same callsign on two close rows: ambiguous note, no deviation', () => {
  const e = makeEnv();
  e.at('2026-10-06T10:10:00Z'); e.api({ XXA123: flying(1, 180) }); e.ctx.recordHistory();
  const rows = e.history().filter(r => r[1] === 'XX123');
  assert.equal(rows.length, 2);
  rows.forEach(r => { assert.match(r[9], /^ambiguous/); assert.equal(r[7], ''); assert.equal(r[3], ''); });
});

test('Days = 0 rows are ignored; medians per flight and scheduled ETA', () => {
  const e = makeEnv();
  e.at('2026-10-06T09:50:00Z'); e.api({ WWD1: flying(1, 180) }); e.ctx.recordHistory();
  assert.equal(e.history().filter(r => r[1] === 'WW1').length, 0);
  e.sheets.History.rows.push(['2026-10-01', 'ZZ789', '10:00', 'a', '', '', 'b', '4', '15', '', 'DEMO'], ['2026-10-02', 'ZZ789', '10:00', 'a', '', '', 'b', '20', '15', '', 'DEMO'],
    ['2026-10-03', 'ZZ789', '10:00', 'a', '', '', 'b', '8', '15', ''], ['2026-10-04', 'ZZ789', '10:00', 'a', '', '', 'b', '500', '15', 'outlier'],
    ['2026-10-04', 'ZZ789', '10:00', 'a', '', '', 'b', '90', '15', '', 'OTHER']);
  const st = e.ctx.historyStats('DEMO').stats['ZZ789|10:00'];
  assert.deepEqual({ median: st.median, n: st.n }, { median: 8, n: 3 });
});

// Fictive airport schedule: one week from Tuesday 2026-10-06 (the day before is fetched too).
function fictiveSchedule(url) {
  const m = /\/(\d{4}-\d{2}-\d{2})T(\d{2}):\d{2}\//.exec(url), date = m[1], am = m[2] === '00';
  const day = new Date(date + 'T12:00:00Z').getUTCDay(); // 0 Sunday
  const at = t => ({ scheduledTime: { utc: date + ' ' + t + 'Z', local: date + ' ' + t + '+00:00' } });
  const dep = [], arr = [];
  const add = (list, t, number, extra = {}) => { if ((t < '12:00') === am) list.push(Object.assign({ number, callSign: number.replace('ZZ ', 'ZZC'), airline: { name: 'Demo One' }, aircraft: { model: 'Airbus A350-900', reg: 'ZS-' + number.slice(-3) }, status: 'Expected' }, extra(t))); };
  // ZZ100: daily turnaround, inbound ZZ99 (number - 1) at 08:00, departs 10:00
  add(arr, '08:00', 'ZZ 99', t => ({ arrival: at(t), departure: { airport: { icao: 'XORG' } } }));
  add(dep, '10:00', 'ZZ 100', t => ({ departure: at(t) }));
  // ZZ300: Mon Wed Fri, same aircraft (registration) arriving as ZZ250 at 06:30
  if ([1, 3, 5].includes(day)) {
    add(arr, '06:30', 'ZZ 250', t => ({ arrival: at(t), aircraft: { model: 'Boeing 737-800', reg: 'ZS-RTN' } }));
    add(dep, '09:30', 'ZZ 300', t => ({ departure: at(t), aircraft: { model: 'Boeing 737-800', reg: 'ZS-RTN' } }));
  }
  // ZZ500: departs 00:45 after an arrival ZZ499 at 23:45 the evening before (quick turn after midnight)
  add(dep, '00:45', 'ZZ 500', t => ({ departure: at(t) }));
  add(arr, '23:45', 'ZZ 499', t => ({ arrival: at(t) }));
  // ZZ700: day stop, arrives ZZ699 at 21:00 the day before, departs 14:00
  add(arr, '21:00', 'ZZ 699', t => ({ arrival: at(t) }));
  add(dep, '14:00', 'ZZ 700', t => ({ departure: at(t) }));
  return { code: 200, body: { departures: dep, arrivals: arr } };
}

test('schedules: a tab with only FLIGHT is filled (AUTO_*), STATUS set, every change audited', () => {
  const e = makeEnv({ props: { AERODATABOX_KEY: 'test-key' } });
  e.at('2026-10-06T08:00:00Z'); e.adb(fictiveSchedule);
  const msg = e.ctx.runResolve('NEWU', 'menu', 'all'); // "Resolve this tab" on a saved tab
  assert.match(msg, /NEWU: 4 resolved, 1 unresolved/);
  const t = Object.fromEntries(e.table('NEWU').map(r => [r.FLIGHT, r]));
  assert.deepEqual([t.ZZ0100.AUTO_STD, t.ZZ0100.AUTO_STA, t.ZZ0100.AUTO_FLIGHT_IN, t.ZZ0100.AUTO_DAYS, t.ZZ0100.STATUS], ['10:00', '08:00', 'ZZ99', '1234567', 'Resolved']);
  assert.equal(t.ZZ0100.AUTO_CALLSIGN, 'ZZC99');
  assert.equal(t.ZZ0100.AUTO_AIRCRAFT, 'Airbus A350-900');
  assert.equal(t.ZZ0100.AUTO_ORIGIN, 'XORG');
  assert.deepEqual([t.ZZ300.AUTO_STA, t.ZZ300.AUTO_FLIGHT_IN, t.ZZ300.AUTO_DAYS], ['06:30', 'ZZ250', '135']); // same aircraft
  assert.deepEqual([t.ZZ500.AUTO_STA, t.ZZ500.AUTO_STD, t.ZZ500.AUTO_DAYS], ['23:45', '00:45', '1234567']); // operating day = arrival day
  assert.deepEqual([t.ZZ700.AUTO_STA, t.ZZ700.AUTO_STD], ['D-1 21:00', '14:00']); // day stop from the day before
  assert.equal(t.QQ999.STATUS, 'Unresolved');
  assert.ok(e.audit().length >= 20);
  assert.ok(e.audit().every(r => /^schedules \(menu\)$/.test(r[1])));
  // manual times win: the DEMO tab rows are Manual override
  e.ctx.resolveFlights();
  assert.ok(e.table('DEMO').every(r => r.STATUS === 'Manual override'));
});

test('schedules: cached per airport and per 12 h window, one request each, never twice', () => {
  const e = makeEnv({ props: { AERODATABOX_KEY: 'test-key' } });
  e.at('2026-10-06T08:00:00Z'); e.adb(fictiveSchedule);
  e.ctx.resolveFlights();
  assert.equal(e.adbCalls.length, 2 * 8); // active unit only: 2 windows, yesterday + 7 days
  assert.ok(e.table('NEWU').every(r => !r.STATUS)); // saved tab: never resolved, no request
  e.ctx.resolveFlights();
  assert.equal(e.adbCalls.length, 16);
  const usage = Object.fromEntries(e.sheets.ApiUsage.rows.slice(1).map(r => [r[0], r[1]]));
  assert.deepEqual([usage.MONTH, usage.CALLS, usage.UNITS_USED], ['2026-10', '16', '32']); // 2 units per call
  assert.match(e.adbCalls[0], /^https:\/\/prod\.api\.market\/api\/v1\/aedbx\/aerodatabox\/flights\/airports\/icao\/XXXX\//);
});

test('schedules: the nightly run never calls the API', () => {
  const e = makeEnv({ props: { AERODATABOX_KEY: 'test-key' } });
  e.at('2026-10-06T08:00:00Z'); e.adb(fictiveSchedule);
  e.ctx.resolveFlights();
  const n = e.adbCalls.length;
  e.at('2026-10-07T00:05:00Z'); e.ctx.resolveDaily();
  e.at('2026-11-01T00:05:00Z'); e.ctx.resolveDaily();
  assert.equal(e.adbCalls.length, n);
});

test('schedules: no key or quota reached, nothing is called and rows stay unresolved', () => {
  const e = makeEnv();
  e.at('2026-10-06T08:00:00Z'); e.adb(fictiveSchedule);
  assert.match(e.ctx.resolveFlights(), /AERODATABOX_KEY is not set/);
  assert.equal(e.adbCalls.length, 0);
  const q = makeEnv({ props: { AERODATABOX_KEY: 'k' } });
  q.sheets.RULES.rows.push(['ADB_MONTHLY_UNITS', '0', '']);
  q.at('2026-10-06T08:00:00Z'); q.adb(fictiveSchedule);
  assert.match(q.ctx.resolveFlights(), /monthly budget reached/);
  assert.equal(q.adbCalls.length, 0);
});

test('the public web app never writes to the Sheet and never calls the schedule API', () => {
  const e = makeEnv({ props: { AERODATABOX_KEY: 'test-key' } });
  e.at('2026-10-06T08:00:00Z'); e.adb(fictiveSchedule);
  const before = JSON.stringify(Object.fromEntries(Object.entries(e.sheets).map(([k, s]) => [k, s.rows])));
  const out = JSON.parse(e.ctx.doGet({ parameter: { cs: 'ZZC99,<script>,AAAAAAAAAAAA', lat: '0', lon: '0', r: '40', u: 'DEMO', action: 'resolve' } }));
  assert.deepEqual(Object.keys(out.cs), ['ZZC99']);
  assert.equal(e.adbCalls.length, 0);
  assert.equal(e.writes.length, 0);
  assert.equal(JSON.stringify(Object.fromEntries(Object.entries(e.sheets).map(([k, s]) => [k, s.rows]))), before);
  assert.equal(typeof e.ctx.doPost, 'undefined');
});

test('the public web app stops calling upstream above the per minute limit', () => {
  const e = makeEnv();
  e.at('2026-10-06T08:00:00Z');
  let limited = false;
  for (let i = 0; i < 10 && !limited; i++) {
    const cs = Array.from({ length: 40 }, (_, j) => 'QQ' + (i * 40 + j)).join(',');
    const out = JSON.parse(e.ctx.doGet({ parameter: { cs } }));
    limited = out.errors.some(x => x.status === 429);
  }
  assert.ok(limited);
});

test('departures: take-off recorded by the trigger and shared with every screen through doGet', () => {
  const e = makeEnv();
  // ZZ790 departs 12:00: seen on the ground at 11:50, then airborne 40 nm away at 12:10 (480 kt: 5 min flown)
  e.at('2026-10-06T11:50:00Z'); e.api({ ZZC790: ground }); e.ctx.recordHistory();
  e.at('2026-10-06T12:10:00Z'); e.api({ ZZC790: [{ flight: 'ZZC790', lat: 0.66, lon: 0, gs: 480, alt_baro: 20000, track: 0, seen_pos: 0 }] }); e.ctx.recordHistory();
  const d = e.sheets.Departures.rows.slice(1).filter(r => r && r[0]);
  assert.equal(d.length, 1);
  assert.deepEqual([d[0][0], d[0][2], d[0][3], d[0][5], d[0][6]], ['2026-10-06', 'ZZ790', '12:00', '2026-10-06 12:05', 'yes']);
  const out = JSON.parse(e.ctx.doGet({ parameter: { u: 'DEMO' } }));
  assert.deepEqual(out.today.dep['ZZ790|12:00'], { at: '12:05', day: '2026-10-06', est: true });
});

test('inbound under number - 1 when FLIGHT_IN is empty; the outbound number flying away is ignored', () => {
  const e = makeEnv();
  // YY456 (ETA 23:50, no FLIGHT_IN): YYB455 approaches, YYB456 flies away elsewhere
  e.at('2026-10-06T23:30:00Z'); e.api({ YYB455: flying(1, 180), YYB456: flying(-3, 180) }); e.ctx.recordHistory();
  e.at('2026-10-06T23:58:00Z'); e.api({ YYB455: ground, YYB456: [] }); e.ctx.recordHistory();
  const r = e.history().find(x => x[1] === 'YY456');
  assert.equal(r[6], '2026-10-06 23:58');
  assert.equal(r[11], 'YYB455');
  assert.equal(e.table('DEMO').find(x => x.FLIGHT === 'YY456').AUTO_CALLSIGN, 'YYB455');
  const out = JSON.parse(e.ctx.doGet({ parameter: { u: 'DEMO' } }));
  assert.equal(out.today.arr['YY456|23:50'], '23:58');
});

// Fictive FIDS answer (relative window): EK-like daily turn ZZ789 in, ZZ790 out; times given in UTC.
function fictiveBoard(opts = {}) {
  const t = (d, hm) => ({ utc: d + ' ' + hm + 'Z', local: d + ' ' + hm + '+00:00' });
  const d = opts.date || '2026-10-06';
  return () => ({ code: 200, body: {
    arrivals: [
      { number: 'ZZ 0789', status: opts.arrStatus || 'EnRoute', lastUpdatedUtc: d + 'T08:20Z',
        arrival: Object.assign({ scheduledTime: t(d, '10:00'), revisedTime: t(d, opts.arrRev || '10:25') }, opts.arrAct ? { runwayTime: t(d, opts.arrAct) } : {}),
        departure: { airport: { icao: 'XORG', iata: 'ORG' } }, aircraft: { reg: 'ZS-ABC', modeS: 'ABC123', model: opts.model || 'Airbus A350-900' } },
      { number: 'QQ 1', status: 'Expected', arrival: { scheduledTime: t(d, '10:10') } },
    ],
    departures: [
      { number: 'ZZ 790', status: opts.depStatus || 'Expected', lastUpdatedUtc: d + 'T08:25Z',
        departure: { scheduledTime: t(d, '12:00'), revisedTime: t(d, '12:40'), terminal: 'A', gate: 'A7' },
        arrival: { airport: { icao: 'XDST' } }, aircraft: { reg: 'ZS-ABC', modeS: 'ABC123', model: opts.model || 'Airbus A350-900' } },
    ],
  } });
}

test('AeroDataBox: one FIDS call on the fixed schedule, live columns written, changes audited', () => {
  const e = makeEnv({ props: { AERODATABOX_KEY: 'test-key' } });
  e.sheets.RULES_DEMO.rows.push(['AIRPORT_IATA', 'XXX', '']);
  e.adb(fictiveBoard());
  e.at('2026-10-06T07:30:00Z');
  assert.match(e.ctx.adbTick(), /not due/); // no fixed time reached since 04:00 was missed by more than 60 min
  e.at('2026-10-06T08:02:00Z');
  assert.match(e.ctx.adbTick(), /XXX: 3 movements read, 1 flights updated/);
  assert.equal(e.adbCalls.length, 1);
  assert.equal(e.adbCalls[0], 'https://prod.api.market/api/v1/aedbx/aerodatabox/flights/airports/Iata/XXX?offsetMinutes=-120&durationMinutes=720&direction=Both&withLeg=true&withCancelled=true&withCodeshared=true&withCargo=false&withPrivate=false&withLocation=true');
  const r = e.table('DEMO').find(x => x.FLIGHT === 'ZZ790');
  assert.deepEqual([r.AUTO_LIVE_DATE, r.AUTO_ARR_STATUS, r.AUTO_ARR_SCHED, r.AUTO_ARR_REVISED, r.AUTO_DEP_SCHED, r.AUTO_DEP_REVISED],
    ['2026-10-06', 'EnRoute', '2026-10-06 10:00', '2026-10-06 10:25', '2026-10-06 12:00', '2026-10-06 12:40']);
  assert.deepEqual([r.AUTO_ORIGIN, r.AUTO_DEST, r.AUTO_REG, r.AUTO_HEX, r.AUTO_AIRCRAFT, r.AUTO_GATE, r.AUTO_TERMINAL, r.AUTO_UPDATED_UTC, r.AUTO_CHECKED_AT],
    ['XORG', 'XDST', 'ZS-ABC', 'abc123', 'Airbus A350-900', 'A7', 'A', '2026-10-06 08:25', '2026-10-06 08:02']);
  assert.equal(r.ETA, '10:00'); // manual columns never touched
  assert.ok(e.audit().some(a => a[1] === 'AERODATABOX' && /ZZ790 AUTO_ARR_REVISED$/.test(a[2]) && a[4] === '2026-10-06 10:25'));
  assert.ok(!e.audit().some(a => /AUTO_CHECKED_AT|AUTO_HEX/.test(a[2]))); // freshness columns change silently
  // same fixed time: not twice; next fixed time (11:00): read again, only the changes are audited
  e.at('2026-10-06T08:40:00Z'); assert.match(e.ctx.adbTick(), /not due/);
  // a time trigger passes an event object: it never forces a read
  e.at('2026-10-06T08:45:00Z'); assert.match(e.ctx.adbTick({ authMode: 'FULL', triggerUid: '1' }), /not due/);
  assert.equal(e.adbCalls.length, 1);
  const before = e.audit().length;
  e.adb(fictiveBoard({ arrStatus: 'Arrived', arrAct: '10:21', model: 'Boeing 777-300ER' }));
  e.at('2026-10-06T11:00:00Z'); e.ctx.adbTick();
  const r2 = e.table('DEMO').find(x => x.FLIGHT === 'ZZ790');
  assert.deepEqual([r2.AUTO_ARR_STATUS, r2.AUTO_ARR_ACTUAL, r2.AUTO_AIRCRAFT, r2.AUTO_AIRCRAFT_PREV], ['Arrived', '2026-10-06 10:21', 'Boeing 777-300ER', 'Airbus A350-900']);
  assert.equal(e.audit().length - before, 3); // status, actual time, aircraft type
  const usage = Object.fromEntries(e.sheets.ApiUsage.rows.slice(1).map(x => [x[0], x[1]]));
  assert.deepEqual([usage.UNITS_USED, usage.CALLS, usage.MODE], ['4', '2', 'normal']);
});

test('AeroDataBox: a runway time before landing is an estimate, never an actual time', () => {
  const e = makeEnv({ props: { AERODATABOX_KEY: 'test-key' } });
  e.sheets.RULES_DEMO.rows.push(['AIRPORT_IATA', 'XXX', '']);
  e.adb(fictiveBoard({ arrStatus: 'Expected', arrAct: '10:11' }));
  e.at('2026-10-06T08:00:00Z'); e.ctx.adbTick();
  const r = e.table('DEMO').find(x => x.FLIGHT === 'ZZ790');
  assert.deepEqual([r.AUTO_ARR_STATUS, r.AUTO_ARR_REVISED, r.AUTO_ARR_ACTUAL || ''], ['Expected', '2026-10-06 10:25', '']);
});

test('AeroDataBox: cancelled flight written as a status only, ACTIVE never touched', () => {
  const e = makeEnv({ props: { AERODATABOX_KEY: 'test-key' } });
  e.sheets.RULES_DEMO.rows.push(['AIRPORT_IATA', 'XXX', '']);
  e.adb(fictiveBoard({ depStatus: 'Canceled' }));
  e.at('2026-10-06T08:00:00Z'); e.ctx.adbTick();
  const r = e.table('DEMO').find(x => x.FLIGHT === 'ZZ790');
  assert.equal(r.AUTO_DEP_STATUS, 'Canceled');
  assert.equal(r.ACTIVE, '');
});

test('AeroDataBox: ranges schedule, one call per airport for several active units, never from the public URL', () => {
  const e = makeEnv({ props: { AERODATABOX_KEY: 'test-key' } });
  e.sheets.RULES.rows.push(['ACTIVE_UNITS', 'DEMO,COPY', ''], ['ADB_SCHEDULE', '00:00-12:00:30|12:00-24:00:60', '']);
  e.sheets.RULES_DEMO.rows.push(['AIRPORT_IATA', 'XXX', '']);
  e.sheets.COPY = null;
  const copy = e.ctx.SpreadsheetApp.getActiveSpreadsheet().insertSheet('COPY');
  copy.rows = [['FLIGHT', 'ETA', 'ETD', 'DAYS', 'FLIGHT_IN'], ['ZZ790', '10:00', '12:00', '1234567', 'ZZ789']];
  e.sheets.RULES_COPY = null;
  e.ctx.SpreadsheetApp.getActiveSpreadsheet().insertSheet('RULES_COPY').rows = [['KEY', 'VALUE'], ['AIRPORT_IATA', 'XXX', ''], ['AIRPORT_ICAO', 'XXXX', '']];
  e.adb(fictiveBoard());
  e.at('2026-10-06T08:00:00Z'); e.ctx.adbTick();
  assert.equal(e.adbCalls.length, 1); // DEMO and COPY share the airport
  assert.equal(e.table('COPY')[0].AUTO_ARR_REVISED, '2026-10-06 10:25');
  e.at('2026-10-06T08:20:00Z'); e.ctx.adbTick(); assert.equal(e.adbCalls.length, 1); // every 30 min
  e.at('2026-10-06T08:31:00Z'); e.ctx.adbTick(); assert.equal(e.adbCalls.length, 2);
  e.ctx.doGet({ parameter: { cs: 'ZZC789', hex: 'abc123', u: 'DEMO' } });
  assert.equal(e.adbCalls.length, 2);
});

test('AeroDataBox budget: economy above the planned pace, stopped before the cap', () => {
  const e = makeEnv();
  // 400 units, 2 per call, day 10 of 31 at noon: pace about 123 units
  assert.equal(e.ctx.adbMode(100, 400, 2, 10, 31, 720).mode, 'normal');
  const eco = e.ctx.adbMode(160, 400, 2, 10, 31, 720);
  assert.equal(eco.mode, 'economy');
  assert.ok(eco.minGapMin >= 60);
  assert.equal(e.ctx.adbMode(391, 400, 2, 30, 31, 720).mode, 'stopped'); // reserve of 8 units (2 %)
  assert.equal(e.ctx.adbMode(4990, 5000, 2, 30, 31, 0).mode, 'stopped');
  // schedules
  const fx = e.ctx.parseAdbSchedule('@00:00|04:00|08:00|11:00|14:00|18:00');
  assert.deepEqual(Array.from(fx.fixed), [0, 240, 480, 660, 840, 1080]);
  assert.equal(e.ctx.adbDue(fx, 485, 0, 1e9), true);
  assert.equal(e.ctx.adbDue(fx, 485, 1e9 - 3 * 60000, 1e9), false); // read 3 min ago, after 08:00
  assert.equal(e.ctx.adbDue(fx, 600, 0, 1e9), false); // 10:00: 08:00 is 2 h old
  const rg = e.ctx.parseAdbSchedule('00:00-06:00:20|06:00-16:00:15|16:00-21:00:30|21:00-24:00:60');
  assert.equal(rg.ranges.length, 4);
  assert.equal(e.ctx.adbDue(rg, 1300, 1e9 - 59 * 60000, 1e9), false);
  assert.equal(e.ctx.adbDue(rg, 1300, 1e9 - 60 * 60000, 1e9), true);
  // OFF: reads only on demand (menu), never from the trigger
  const off = makeEnv({ props: { AERODATABOX_KEY: 'k' } });
  off.sheets.RULES_DEMO.rows.push(['AIRPORT_IATA', 'XXX', '']);
  off.sheets.RULES.rows.push(['ADB_SCHEDULE', 'OFF', '']);
  off.adb(fictiveBoard());
  ['00:00', '04:01', '08:00', '11:00', '18:30'].forEach(hm => { off.at('2026-10-06T' + hm + ':00Z'); off.ctx.adbTick({ triggerUid: 'x' }); });
  assert.equal(off.adbCalls.length, 0);
  off.ctx.adbTick(true);
  assert.equal(off.adbCalls.length, 1);
  // stopped: no call at all
  const s = makeEnv({ props: { AERODATABOX_KEY: 'k' } });
  s.sheets.RULES_DEMO.rows.push(['AIRPORT_IATA', 'XXX', '']);
  s.sheets.RULES.rows.push(['ADB_MONTHLY_UNITS', '3', '']);
  s.adb(fictiveBoard());
  s.at('2026-10-06T08:00:00Z');
  assert.match(s.ctx.adbTick(), /not due \(stopped\)/);
  assert.equal(s.adbCalls.length, 0);
});

test('nightly learning from the board reads: AUTO_DAYS only once 7 full days were read', () => {
  const e = makeEnv({ props: { AERODATABOX_KEY: 'k' } });
  e.sheets.RULES.rows.push(['DEFAULT_UNIT', 'NEWU', ''], ['ADB_SCHEDULE', '@00:00|04:00|08:00|11:00|14:00|18:00', '']);
  e.sheets.RULES_NEWU.rows.push(['AIRPORT_IATA', 'YYY', '']);
  // ZZ100 departs 10:00 every day, inbound ZZ99 at 08:00
  let day = '';
  e.adb(() => {
    const t = hm => ({ utc: day + ' ' + hm + 'Z' });
    return { code: 200, body: { arrivals: [{ number: 'ZZ99', status: 'Arrived', arrival: { scheduledTime: t('08:00') }, aircraft: { model: 'Airbus A320' } }],
      departures: [{ number: 'ZZ100', status: 'Departed', departure: { scheduledTime: t('10:00') }, aircraft: { model: 'Airbus A320' } }] } };
  });
  const runDay = d => { day = d; ['00:00', '04:00', '08:00', '11:00', '14:00', '18:00'].forEach(hm => { e.at(d + 'T' + hm + ':30Z'); e.ctx.adbTick(); }); };
  ['2026-10-05', '2026-10-06', '2026-10-07'].forEach(runDay);
  e.at('2026-10-08T02:00:00Z'); e.ctx.resolveDaily();
  let r = e.table('NEWU').find(x => x.FLIGHT === 'ZZ0100');
  assert.deepEqual([r.AUTO_STD, r.AUTO_STA, r.AUTO_DAYS], ['10:00', '08:00', '123']); // 3 days read: partial
  assert.equal(e.table('NEWU').find(x => x.FLIGHT === 'QQ999').STATUS, ''); // not seen, partial: untouched
  ['2026-10-08', '2026-10-09', '2026-10-10', '2026-10-11'].forEach(runDay);
  e.at('2026-10-12T02:00:00Z'); e.ctx.resolveDaily();
  r = e.table('NEWU').find(x => x.FLIGHT === 'ZZ0100');
  assert.deepEqual([r.AUTO_DAYS, r.AUTO_FLIGHT_IN, r.STATUS], ['1234567', 'ZZ99', 'Resolved']); // 7 full days read
  assert.equal(e.table('NEWU').find(x => x.FLIGHT === 'QQ999').STATUS, 'Unresolved');
  assert.equal(e.adbCalls.length, 7 * 6); // the nightly runs called nothing
});
