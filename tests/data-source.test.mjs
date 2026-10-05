// Run with: node --test tests/*.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const DS = createRequire(import.meta.url)('../js/data-source.js');

const MAIN = [
  'DEMO TITLE ROW,,,,,,,,',
  '1=MON 2=TUE 3=WED 4=THU 5=FRI 6=SAT 7=SUN | Daily = 1234567,,,,,,,,',
  'SI,Airline,H/W,Flight,ETA,ETD,Sealing,Truck Dep,Days',
  '1,Demo Air One,Halal,ZZ101,06:10,08:40,05:00,06:00,1234567',
  '2,,,,,,,,',
  '3,"Demo, Two",Western,ZY202,16:30,19:00,15:00,16:00,135,ZY203',
  '4,Demo Air One,Halal,ZZ109,,09:00,05:15,06:15,0',
].join('\r\n');

test('parseCSV handles quotes, escaped quotes and CRLF', () => {
  assert.deepEqual(DS.parseCSV('a,"b,c","d ""e"""\r\n1,2,3'), [['a', 'b,c', 'd "e"'], ['1', '2', '3']]);
});

test('parseDays', () => {
  assert.deepEqual(DS.parseDays('daily').length, 7);
  assert.deepEqual(DS.parseDays('0'), []);
  assert.deepEqual(DS.parseDays('135'), ['MON', 'WED', 'FRI']);
});

test('parseFlights keeps ids, skips empty rows, keeps Days = 0 rows for lookups', () => {
  const rows = DS.parseFlights(DS.parseCSV(MAIN));
  assert.deepEqual(rows.map(r => r.id), ['gs0', 'gs2', 'gs3']);
  assert.equal(rows[1].airline, 'Demo, Two');
  assert.equal(rows[1].flightOut, 'ZY203');
  assert.equal(rows[0].flightOut, '');
  assert.equal(rows[2].eta, '');
  assert.deepEqual(rows[2].days, []);
});

test('tab parsers read headers by name', () => {
  const al = DS.parseAirlines(DS.parseCSV('NAME,COLOR,IATA,ICAO\nDemo Air One,#fff,zz,zzz\n,,,'));
  assert.deepEqual(al, [{ id: 'demo_air_one', name: 'Demo Air One', color: '#fff', iata: 'ZZ', icao: 'ZZZ' }]);
  assert.deepEqual(DS.parseSettings(DS.parseCSV('KEY,VALUE,DESCRIPTION\nALERT_DEFAULT_MIN,15,x')), { ALERT_DEFAULT_MIN: '15' });
  assert.deepEqual(DS.parseBoxTime(DS.parseCSV('SI,FLIGHT,DAY,OVERRIDE\n,ZZ101,d-1,10:40\n2,ZY202,D,')),
    [{ si: null, flight: 'ZZ101', day: 'D-1', override: '10:40' }, { si: 2, flight: 'ZY202', day: 'D', override: '' }]);
});

function memStorage() { const m = new Map(); return { getItem: k => m.has(k) ? m.get(k) : null, setItem: (k, v) => m.set(k, String(v)) }; }
const cfg = {
  SHEET_CSV_URL: 'https://sheet/main?output=csv', SHEET_GIDS: { airlines: '11', config: null, boxTime: '33' },
  LOCAL_DATA_URL: 'data/local-data.json', sheetTabUrl: g => 'https://sheet/tab?gid=' + g,
};

test('falls back from Sheet to cache to local file', async () => {
  const storage = memStorage();
  let up = true;
  const local = { settings: { ALERT_DEFAULT_MIN: '20' } };
  const fetch = async url => {
    if (url === 'data/local-data.json') return { ok: true, json: async () => local };
    if (!up) throw new Error('down');
    if (url.includes('main')) return { ok: true, text: async () => MAIN };
    if (url.includes('gid=11')) return { ok: true, text: async () => 'NAME,COLOR,IATA,ICAO\nDemo Air One,#fff,ZZ,ZZZ' };
    if (url.includes('gid=33')) return { ok: true, text: async () => 'SI,FLIGHT,DAY,OVERRIDE\n1,ZZ101,D-1,10:40' };
    return { ok: false, status: 404 };
  };
  const ds = DS.create(cfg, { fetch, storage });
  let st = await ds.refresh();
  assert.equal(st.flights.length, 2);
  assert.equal(st.flightRows.length, 3);
  assert.equal(st.tabs.flights.source, 'sheet');
  assert.equal(st.tabs.settings.source, 'local');
  assert.equal(ds.setting('ALERT_DEFAULT_MIN', 15), 20);
  assert.equal(ds.airlineForFlight('ZZ109'), 'Demo Air One');
  assert.deepEqual(ds.icaoPrefixes(), { ZZ: 'ZZZ' });

  up = false;
  st = await ds.refresh();
  assert.equal(st.tabs.flights.source, 'cache');
  assert.equal(st.tabs.flights.error, 'fetch');
  assert.equal(st.flights.length, 2);
  assert.equal(st.boxTime[0].override, '10:40');
});

test('a Sheet answer with no usable row is a parse error, not an empty board', async () => {
  const storage = memStorage();
  let body = MAIN;
  const fetch = async url => url.includes('main') ? { ok: true, text: async () => body } : { ok: false, status: 404 };
  const ds = DS.create(cfg, { fetch, storage });
  await ds.refresh();
  body = '<html>error</html>';
  const st = await ds.refresh();
  assert.equal(st.tabs.flights.error, 'parse');
  assert.equal(st.flights.length, 2);
});

test('legacy airline colours saved on the device are used when nothing else is available', async () => {
  const storage = memStorage();
  storage.setItem('cop_airlines', JSON.stringify([{ id: 'x', name: 'Demo Air One', color: '#123456' }]));
  const ds = DS.create({ ...cfg, SHEET_GIDS: {} }, { fetch: async () => ({ ok: false, status: 404 }), storage });
  const st = await ds.refresh();
  assert.equal(st.airlines[0].color, '#123456');
  assert.equal(st.tabs.airlines.source, 'cache');
});
