// Run with: node --test tests/*.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const DS = createRequire(import.meta.url)('../js/data-source.js');

// Fictive unit tab: title rows, header row, data. Columns read by name.
const UNIT = [
  'DEMO TITLE ROW,,,,,,,,',
  '1=MON 2=TUE 3=WED 4=THU 5=FRI 6=SAT 7=SUN | Daily = 1234567,,,,,,,,',
  'SI,Airline,H/W,Flight,ETA,ETD,Sealing,Truck Dep,Days,FLIGHT_OUT,FLIGHT_IN,CALLSIGN,ACTIVE,AUTO_STA,AUTO_STD,AUTO_DAYS,STATUS',
  '1,Demo Air One,Halal,ZZ101,06:10,08:40,05:00,06:00,1234567,,,,,,,,',
  '2,,,,,,,,,,,,,,,,',
  '3,"Demo, Two",Western,ZY0202,16:30,19:00,15:00,16:00,135,ZY203,ZY201,,,,,,',
  '4,Demo Air One,Halal,ZZ109,,09:00,05:15,06:15,0,,,,,,,,',
  '5,,,ZZ300,,,,,,,,,,10:00,12:00,246,Resolved',
  '6,,,ZZ400,,,,,,,,,,,,,',
  '7,Demo Air One,,ZZ500,07:00,09:00,,,daily,,,,NO,,,,',
  '8,Unknown Air,,QQ1,07:00,09:00,,,1,,,,,,,,',
  '9,Demo Air One,,1234,07:00,09:00,,,1,,,,,,,,',
  '10,Demo Air One,,ZZ0101,06:10,08:40,05:00,06:00,1,,,,,,,,',
].join('\r\n');
const AIRLINES = 'NAME,COLOR,IATA,ICAO,DEFAULT_PROFILE\nDemo Air One,#fff,ZZ,ZZZ,\n"Demo, Two",#000,ZY,ZZY,';
const RULES = 'KEY,VALUE,DESCRIPTION\nALERT_DEFAULT_MIN,15,x\nAIRPORT_ICAO,XXXX,x';
const BOX = 'UNIT,SI,FLIGHT,DAY,OVERRIDE\n,1,ZZ101,D-1,10:40\nOTHER,3,ZY202,D,11:00';

test('parseCSV handles quotes, escaped quotes and CRLF', () => {
  assert.deepEqual(DS.parseCSV('a,"b,c","d ""e"""\r\n1,2,3'), [['a', 'b,c', 'd "e"'], ['1', '2', '3']]);
});

test('parseDays', () => {
  assert.deepEqual(DS.parseDays('daily').length, 7);
  assert.deepEqual(DS.parseDays('0'), []);
  assert.deepEqual(DS.parseDays('531'), ['MON', 'WED', 'FRI']);
});

test('tab parsers find their header row by name', () => {
  const al = DS.parseAirlines(DS.parseCSV('A,B\nNAME,COLOR,IATA,ICAO\nDemo Air One,#fff,zz,zzz\n,,,'));
  assert.equal(al.length, 1);
  assert.equal(al[0].icao, 'ZZZ');
  assert.deepEqual(DS.parseSettings(DS.parseCSV('KEY,VALUE,DESCRIPTION\nALERT_DEFAULT_MIN,15,x')), { ALERT_DEFAULT_MIN: '15' });
  assert.deepEqual(DS.parseBoxTime(DS.parseCSV('SI,FLIGHT,DAY,OVERRIDE\n,ZZ101,d-1,10:40')),
    [{ unit: '', si: null, flight: 'ZZ101', day: 'D-1', override: '10:40' }]);
});

function build() {
  const raw = DS.readUnitRows(DS.parseCSV(UNIT, true));
  return DS.buildUnit(raw, { unit: 'DEMO', defaultUnit: 'DEMO', airlines: DS.parseAirlines(DS.parseCSV(AIRLINES)), settings: {}, boxTime: DS.parseBoxTime(DS.parseCSV(BOX)) });
}

test('unit build: manual values win, AUTO_* fill the gaps, inactive rows hidden', () => {
  const b = build();
  const by = f => b.rows.find(r => r.flight === f);
  assert.equal(by('ZY0202').flightIn, 'ZY201');
  assert.deepEqual(by('ZY0202').callsigns, ['ZZY201']);
  assert.equal(by('ZZ300').etd, '12:00');
  assert.equal(by('ZZ300').src.etd, 'auto');
  assert.equal(by('ZZ300').airline, 'Demo Air One'); // from the flight prefix
  assert.deepEqual(by('ZZ300').days, ['TUE', 'THU', 'SAT']);
  assert.equal(by('ZZ300').truck, '09:30'); // TURN rule filled the empty Truck
  assert.equal(by('ZZ300').src.truck, 'rule');
  assert.equal(by('ZZ101').status, 'Manual override');
  assert.equal(by('ZZ400').status, 'Unresolved');
  assert.deepEqual(by('ZZ500').days, []);
  assert.ok(!b.flights.some(f => f.flight === 'ZZ109' || f.flight === 'ZZ500' || f.flight === 'ZZ400'));
});

test('Box Time: BoxTime override for the matching unit, rule otherwise', () => {
  const b = build(), by = f => b.rows.find(r => r.flight === f);
  assert.equal(by('ZZ101').box.source, 'override');
  assert.equal(by('ZZ101').box.m, 10 * 60 + 40);
  assert.equal(by('ZY0202').box.source, 'rule'); // override belongs to another unit
  assert.equal(by('ZY0202').box.day, 'D');
});

test('data health: empty row, malformed number, unknown airline, Days = 0, duplicates, never a crash', () => {
  const msgs = build().health.map(h => h.level + ' ' + (h.flight || '') + ' ' + h.msg);
  const has = re => assert.ok(msgs.some(m => re.test(m)), 'missing: ' + re + '\n' + msgs.join('\n'));
  has(/^info .*Empty row \(SI 2\)/);
  has(/^error .*Malformed flight number "1234"/);
  has(/^warn QQ1 .*Unknown Air/);
  has(/^info ZZ109 .*DAYS = 0/);
  has(/^info ZZ500 .*ACTIVE = NO/);
  has(/^warn ZZ400 .*Unresolved/);
  has(/^error ZZ0101 .*Duplicate of ZZ101/);
  has(/^check ZZ101 .*Truck/);
  assert.doesNotThrow(() => DS.buildUnit([{ _row: 3, FLIGHT: 'ZZ1', ETA: 'xx', DAYS: '9' }], { unit: 'U', airlines: [], settings: {}, boxTime: [] }));
});

test('per-day statistics are computed', () => {
  const s = build().stats;
  assert.equal(s.length, 7);
  assert.ok(s.find(d => d.day === 'MON').flights >= 2);
});

function memStorage() { const m = new Map(); return { getItem: k => m.has(k) ? m.get(k) : null, setItem: (k, v) => m.set(k, String(v)) }; }
const cfg = {
  SHEET_ID: 'SHEETID', DEFAULT_UNIT: 'DEMO', SHEET_TAB_GIDS: { DEMO: '0', Airlines: '11', BoxTime: '33' },
  LOCAL_DATA_URL: 'data/local-data.json', sheetTabUrl: g => 'https://pub/tab?gid=' + g,
};

test('?unit= picks the tab; gviz by name first, published CSV second, then cache, then local file', async () => {
  const storage = memStorage();
  let gviz = true, pub = true;
  const calls = [];
  const local = { csv: { RULES: RULES } };
  const fetch = async url => {
    calls.push(url);
    if (url === 'data/local-data.json') return { ok: true, json: async () => local };
    if (url.includes('/gviz/')) {
      if (!gviz) throw new Error('cors');
      const name = decodeURIComponent(/sheet=([^&]+)/.exec(url)[1]);
      if (name === 'DEMO') return { ok: true, text: async () => UNIT };
      return { ok: true, text: async () => '"Read me first"' }; // gviz returns the first tab for an unknown name
    }
    if (!pub) throw new Error('down');
    if (url.includes('gid=0')) return { ok: true, text: async () => UNIT };
    if (url.includes('gid=11')) return { ok: true, text: async () => AIRLINES };
    if (url.includes('gid=33')) return { ok: true, text: async () => BOX };
    return { ok: false, status: 404 };
  };
  const ds = DS.create(cfg, { fetch, storage, search: '?unit=demo' });
  assert.equal(ds.unit, 'DEMO');
  let st = await ds.refresh();
  assert.equal(st.tabs.flights.source, 'sheet');
  assert.equal(st.tabs.flights.via, 'gviz');
  assert.equal(st.tabs.airlines.via, 'pub'); // gviz answered with the wrong tab
  assert.equal(st.tabs.settings.source, 'local');
  assert.equal(ds.setting('ALERT_DEFAULT_MIN', 10), 15);
  assert.equal(ds.airlineForFlight('ZZ0109'), 'Demo Air One');
  assert.deepEqual(ds.icaoPrefixes(), { ZZ: 'ZZZ', ZY: 'ZZY' });

  gviz = false;
  st = await ds.refresh();
  assert.equal(st.tabs.flights.via, 'pub');
  const n = calls.length;
  await ds.refresh(); // gviz is skipped for a while after a failure
  assert.ok(!calls.slice(n).some(u => u.includes('/gviz/')));

  pub = false;
  st = await ds.refresh();
  assert.equal(st.tabs.flights.source, 'cache');
  assert.equal(st.tabs.flights.error, 'fetch');
  assert.ok(st.flights.length >= 3);
});

test('a missing unit tab is reported in data health, not a crash', async () => {
  const ds = DS.create(cfg, { fetch: async () => ({ ok: false, status: 404 }), storage: memStorage(), search: '?unit=NOPE' });
  const st = await ds.refresh();
  assert.equal(st.flights.length, 0);
  assert.ok(st.health.some(h => h.level === 'error' && /NOPE/.test(h.msg)));
});

test('unit names are sanitised', () => {
  const ds = DS.create(cfg, { fetch: async () => ({ ok: false }), storage: memStorage(), search: '?unit=<script>' });
  assert.equal(ds.unit, 'DEMO');
});

test('AeroDataBox live columns: kept per row, "No matching hours" in Data health when the Sheet differs', () => {
  const tab = [
    'FLIGHT,ETA,ETD,DAYS,AUTO_LIVE_DATE,AUTO_ARR_SCHED,AUTO_ARR_REVISED,AUTO_DEP_SCHED,AUTO_DEP_STATUS,AUTO_CHECKED_AT',
    'ZZ101,06:10,08:40,1234567,2026-10-06,2026-10-06 06:10,2026-10-06 06:40,2026-10-06 08:40,Expected,2026-10-06 04:00',
    'ZZ109,07:00,09:00,1234567,2026-10-06,2026-10-06 07:15,,2026-10-06 09:00,Expected,2026-10-06 04:00',
  ].join('\n');
  const b = DS.buildUnit(DS.readUnitRows(DS.parseCSV(tab, true)), { unit: 'DEMO', defaultUnit: 'DEMO', airlines: DS.parseAirlines(DS.parseCSV(AIRLINES)), settings: {}, boxTime: [] });
  const r = b.rows.find(x => x.flight === 'ZZ101');
  assert.deepEqual([r.adb.date, r.adb.arrRevised, r.adb.depStatus, r.adb.checkedAt], ['2026-10-06', '2026-10-06 06:40', 'Expected', '2026-10-06 04:00']);
  assert.equal(r.eta, '06:10'); // the Sheet time stays the plan
  const msgs = b.health.filter(h => /No matching hours/.test(h.msg));
  assert.equal(msgs.length, 1);
  assert.match(msgs[0].msg, /^No matching hours: Sheet ETA 07:00, AeroDataBox 07:15 \(2026-10-06\)$/);
  assert.equal(b.rows.find(x => x.flight === 'ZZ109').adb.depSched, '2026-10-06 09:00');
});
