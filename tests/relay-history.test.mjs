// Runs apps-script/live-relay.gs against in-memory mocks of the Apps Script services. Fictive data only.
// Run with: node --test tests/*.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const CODE = fs.readFileSync(new URL('../apps-script/live-relay.gs', import.meta.url), 'utf8');

function makeEnv() {
  let now = 0;
  const RealDate = Date;
  class FakeDate extends RealDate { constructor(...a) { if (a.length) super(...a); else super(now); } static now() { return now; } }
  const sheets = {};
  function sheet(name, rows) {
    const s = {
      name, rows: rows.map(r => r.slice()),
      getDataRange: () => ({ getDisplayValues: () => s.rows.map(r => r.map(v => String(v ?? ''))) }),
      getRange: (r, c, nr, nc) => ({
        setNumberFormat() { return this; }, setFontWeight() { return this; },
        setValues(v) { v.forEach((row, i) => { s.rows[r - 1 + i] = s.rows[r - 1 + i] || []; row.forEach((x, j) => { s.rows[r - 1 + i][c - 1 + j] = x; }); }); return this; },
        clearContent() { for (let i = 0; i < nr; i++) if (s.rows[r - 1 + i]) s.rows[r - 1 + i] = []; return this; },
      }),
      getLastRow: () => { let n = s.rows.length; while (n && !(s.rows[n - 1] || []).some(v => v !== '' && v !== undefined)) n--; return n; },
      getMaxRows: () => 1000, setFrozenRows() {},
    };
    sheets[name] = s; return s;
  }
  const order = [];
  const ss = {
    getSheetByName: n => sheets[n] || null,
    getSheets: () => order.map(n => sheets[n]),
    insertSheet: n => { order.push(n); return sheet(n, []); },
  };
  const cache = new Map();
  let api = {};
  const ctx = {
    Date: FakeDate, Math, JSON, parseInt, parseFloat, isFinite, String, Array, Object, RegExp, Error,
    console,
    SpreadsheetApp: { openById: () => ss },
    CacheService: { getScriptCache: () => ({
      get: k => { const e = cache.get(k); return e && e.exp > now ? e.v : null; },
      put: (k, v, ttl) => cache.set(k, { v, exp: now + ttl * 1000 }), remove: k => cache.delete(k) }) },
    PropertiesService: { getScriptProperties: () => ({ getProperty: k => ({ SHEET_ID: 'x', TRIGGER_MIN: '15' })[k] || null, setProperty() {} }) },
    LockService: { getScriptLock: () => ({ tryLock: () => true, releaseLock() {} }) },
    Session: { getScriptTimeZone: () => 'UTC' },
    Logger: { log() {} },
    Utilities: { formatDate: (d, tz, f) => {
      const iso = new RealDate(d.getTime()).toISOString();
      const day = new RealDate(d.getTime()).getUTCDay();
      return { 'yyyy-MM-dd': iso.slice(0, 10), H: String(parseInt(iso.slice(11, 13), 10)), m: String(parseInt(iso.slice(14, 16), 10)),
        u: String(day === 0 ? 7 : day), 'yyyy-MM-dd HH:mm': iso.slice(0, 10) + ' ' + iso.slice(11, 16) }[f];
    } },
    UrlFetchApp: { fetchAll: reqs => reqs.map(r => { const cs = r.url.split('/').pop(); return { getResponseCode: () => 200, getContentText: () => JSON.stringify({ ac: api[cs] || [] }) }; }) },
    ContentService: { createTextOutput: t => ({ setMimeType() { return t; } }), MimeType: { JSON: 'json' } },
  };
  vm.createContext(ctx);
  vm.runInContext(CODE, ctx);
  order.push('Main');
  sheet('Main', [
    ['SI', 'Airline', 'H/W', 'Flight', 'ETA', 'ETD', 'Sealing', 'Truck Dep', 'Days', 'FLIGHT_OUT', 'FLIGHT_IN'],
    ['1', 'Demo One', 'Halal', 'ZZ790', '10:00', '12:00', '08:00', '09:00', '1234567', '', 'ZZ789'],
    ['2', 'Demo Two', 'Western', 'YY456', '23:50', '01:30', '22:00', '23:00', '1234567', '', ''],
    ['3', 'Demo Three', 'Western', 'XX123', '10:00', '12:00', '08:00', '09:00', '1234567', '', ''],
    ['4', 'Demo Three', 'Western', 'XX123', '10:30', '12:30', '08:30', '09:30', '1234567', '', ''],
    ['5', 'Demo Four', 'Western', 'WW1', '10:00', '12:00', '08:00', '09:00', '0', '', ''],
  ]);
  order.push('Airlines'); sheet('Airlines', [['NAME', 'COLOR', 'IATA', 'ICAO'], ['Demo One', '#fff', 'ZZ', 'ZZC'], ['Demo Two', '#fff', 'YY', 'YYB'], ['Demo Three', '#fff', 'XX', 'XXA'], ['Demo Four', '#fff', 'WW', 'WWD']]);
  order.push('Config'); sheet('Config', [['KEY', 'VALUE', 'DESCRIPTION'], ['AIRPORT_LAT', '0', ''], ['AIRPORT_LON', '0', ''],
    ['HISTORY_ENABLED', 'TRUE', ''], ['HISTORY_KEEP_DAYS', '90', ''], ['HISTORY_OUTLIER_MAX_MIN', '360', ''], ['LANDED_RADIUS_NM', '5', ''],
    ['APPROACH_MARGIN_MIN', '5', ''], ['MIN_GS_KT', '150', ''], ['TIMEZONE', 'UTC', ''], ['ADSB_REFRESH_SEC', '1200', '']]);
  return {
    ctx, sheets,
    at(iso) { now = new RealDate(iso).getTime(); },
    api(v) { api = v; },
    history() { const s = sheets.History; return s ? s.rows.slice(1).filter(r => r && r.length && r[0]) : []; },
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
  const [date, flight, eta, first, etaLive, last, landed, dev, precision] = rows[0];
  assert.deepEqual([date, flight, eta, first, landed, dev, precision], ['2026-10-06', 'ZZ789', '10:00', '2026-10-06 09:30', '2026-10-06 10:12', '12', '15']);
  assert.equal(last, '2026-10-06 09:45');
  assert.equal(etaLive, '09:50'); // 120 nm at 480 kt = 15 min + 5 min margin
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
  e.sheets.History.rows.push(['2026-10-01', 'ZZ789', '10:00', 'a', '', '', 'b', '4', '15', ''], ['2026-10-02', 'ZZ789', '10:00', 'a', '', '', 'b', '20', '15', ''],
    ['2026-10-03', 'ZZ789', '10:00', 'a', '', '', 'b', '8', '15', ''], ['2026-10-04', 'ZZ789', '10:00', 'a', '', '', 'b', '500', '15', 'outlier']);
  const st = e.ctx.historyStats().stats['ZZ789|10:00'];
  assert.deepEqual({ median: st.median, n: st.n }, { median: 8, n: 3 });
});
