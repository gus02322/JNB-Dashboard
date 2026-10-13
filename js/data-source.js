/*
 * Ops On Time data source.
 * The only module that knows where data comes from: one Google Sheet, one tab per unit.
 * Each tab is read by name (gviz CSV), then from the published CSV (gid), then from the last good
 * read kept on this device, then from an optional non-versioned local file.
 * The Sheet is never written from the browser.
 * Public API: refresh(), get(), onChange(cb), setting(key, fallback), unit, airlineForFlight(), icaoPrefixes().
 */
(function (root, factory) {
  const api = factory(root.AngaRules || (typeof require === 'function' ? require('./rules.js') : null));
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.AngaData = api.create(root.ANGA_CONFIG, {
    fetch: (...a) => root.fetch(...a),
    storage: root.localStorage,
    search: root.location ? root.location.search : '',
  });
})(typeof window !== 'undefined' ? window : globalThis, function (R) {
  const DAY_NUM_MAP = { '1': 'MON', '2': 'TUE', '3': 'WED', '4': 'THU', '5': 'FRI', '6': 'SAT', '7': 'SUN' };
  const ALL_WEEK = ['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT', 'SUN'];
  const CACHE_PREFIX = 'oot_csv_';
  const LEGACY_AIRLINES_KEY = 'cop_airlines';
  const GVIZ_RETRY_MS = 15 * 60 * 1000;

  /* ---------- parsing (pure) ---------- */

  // RFC 4180 CSV: quoted fields, "" escapes, commas and newlines inside quotes.
  // keepEmpty keeps blank rows so that row numbers match the Sheet.
  function parseCSV(text, keepEmpty) {
    const rows = [];
    let row = [], cur = '', inQ = false;
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (inQ) {
        if (c === '"') {
          if (text[i + 1] === '"') { cur += '"'; i++; } else inQ = false;
        } else cur += c;
      } else if (c === '"') inQ = true;
      else if (c === ',') { row.push(cur.trim()); cur = ''; }
      else if (c === '\n' || c === '\r') {
        if (c === '\r' && text[i + 1] === '\n') i++;
        row.push(cur.trim()); rows.push(row); row = []; cur = '';
      } else cur += c;
    }
    if (cur !== '' || row.length) { row.push(cur.trim()); rows.push(row); }
    return keepEmpty ? rows : rows.filter(r => r.some(v => v !== ''));
  }

  function parseDays(str) {
    const s = String(str || '').replace(/\s/g, '');
    if (!s || s === '0') return [];
    if (s.toLowerCase() === 'daily' || s === '1234567') return ALL_WEEK.slice();
    return [...new Set([...s].map(c => DAY_NUM_MAP[c]).filter(Boolean))].sort((a, b) => ALL_WEEK.indexOf(a) - ALL_WEEK.indexOf(b));
  }
  function daysValid(str) { const s = String(str || '').replace(/\s/g, ''); return !s || /^(daily|[0-7]+)$/i.test(s); }

  // Header names: uppercase, spaces and slashes to underscores ("Truck Dep" -> TRUCK_DEP).
  function headKey(h) { return String(h || '').trim().toUpperCase().replace(/[\s/.-]+/g, '_').replace(/^_|_$/g, ''); }
  const ALIASES = {
    FLIGHT: ['FLIGHT', 'FLIGHT_NO', 'FLIGHT_NUMBER'], AIRLINE: ['AIRLINE'], MEAL: ['H_W', 'MEAL', 'MEAL_TYPE'],
    ETA: ['ETA', 'STA'], ETD: ['ETD', 'STD'], SEALING: ['SEALING', 'SEAL'], TRUCK: ['TRUCK_DEP', 'TRUCK', 'TRUCK_DEPARTURE'],
  };
  function canon(k) { for (const [c, list] of Object.entries(ALIASES)) if (list.includes(k)) return c; return k; }

  // Generic tab: header row found by a required column (gviz may add a label row on top).
  function parseTable(rows, required) {
    const keep = rows.filter(r => r.some(v => v !== ''));
    const hi = required ? keep.findIndex(r => r.map(headKey).includes(required)) : 0;
    if (hi < 0 || !keep.length) return [];
    const head = keep[hi].map(h => h.trim().toUpperCase());
    return keep.slice(hi + 1).map(r => {
      const o = {};
      head.forEach((h, i) => { if (h) o[h] = (r[i] || '').trim(); });
      return o;
    });
  }

  function slug(s) { return String(s).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, ''); }

  function parseAirlines(rows) {
    return parseTable(rows, 'NAME').filter(o => o.NAME).map(o => ({
      id: slug(o.NAME), name: o.NAME, color: o.COLOR || '', iata: (o.IATA || '').toUpperCase(), icao: (o.ICAO || '').toUpperCase(),
      callsign: o.CALLSIGN || '', defaultProfile: (o.DEFAULT_PROFILE || '').toUpperCase(),
    }));
  }

  function parseSettings(rows) {
    const s = {};
    parseTable(rows, 'KEY').forEach(o => { if (o.KEY) s[o.KEY.toUpperCase()] = o.VALUE || ''; });
    return s;
  }

  // Optional "Airports" tab (only used by the schedule based estimate, off by default).
  function parseAirports(rows) {
    return parseTable(rows, 'ICAO').filter(o => o.ICAO && o.LAT && o.LON).map(o => ({ icao: o.ICAO.toUpperCase(), lat: parseFloat(o.LAT), lon: parseFloat(o.LON) }))
      .filter(a => Number.isFinite(a.lat) && Number.isFinite(a.lon));
  }

  // BoxTime tab: optional overrides. UNIT empty = default unit.
  function parseBoxTime(rows) {
    return parseTable(rows, 'FLIGHT').filter(o => o.FLIGHT).map(o => ({
      unit: (o.UNIT || '').toUpperCase(),
      si: o.SI ? parseInt(o.SI, 10) : null,
      flight: o.FLIGHT,
      day: (o.DAY || '').toUpperCase(),
      override: o.OVERRIDE || '',
    }));
  }

  // Raw rows of a unit tab, read by header name. Every row keeps its Sheet row number.
  function readUnitRows(rows) {
    const hi = rows.findIndex(r => r.map(headKey).map(canon).includes('FLIGHT'));
    if (hi < 0) return null;
    const head = rows[hi].map(h => canon(headKey(h)));
    const out = [];
    rows.slice(hi + 1).forEach((r, i) => {
      if (!r.some(v => v !== '')) return;
      const o = { _row: hi + 2 + i };
      head.forEach((h, j) => { if (h && o[h] === undefined) o[h] = (r[j] || '').trim(); });
      out.push(o);
    });
    return out;
  }

  /* ---------- unit build: effective values, plan, data health (pure) ---------- */

  const time = v => (R.t2m(v) === null ? '' : R.m2t(R.t2m(v)));

  // ctx: { unit, defaultUnit, airlines, settings, boxTime }. Returns { rows, flights, health, stats }.
  function buildUnit(raw, ctx) {
    const rules = R.readRules(k => ctx.settings[k]);
    const airlines = ctx.airlines || [];
    const byName = new Map(airlines.map(a => [a.name.toLowerCase(), a]));
    const prefixes = icaoMap(airlines);
    const health = [];
    const flag = (level, o, msg) => health.push({ level, row: o ? o._row : null, si: o && o.SI ? o.SI : '', flight: o ? o.FLIGHT || '' : '', msg });
    const rows = [];

    (raw || []).forEach(o => {
      const flightRaw = o.FLIGHT || '';
      if (!flightRaw) {
        if (Object.keys(o).some(k => k !== '_row' && k !== 'SI' && o[k])) flag('error', o, 'No FLIGHT number: row ignored');
        else flag('info', o, 'Empty row' + (o.SI ? ' (SI ' + o.SI + ')' : '') + ': ignored');
        return;
      }
      const n = R.normFlight(flightRaw);
      if (!n) { flag('error', o, 'Malformed flight number "' + flightRaw + '": row ignored'); return; }
      const auto = k => o['AUTO_' + k] || '';
      ['ETA', 'ETD', 'SEALING', 'TRUCK'].forEach(k => { if (o[k] && R.t2m(o[k]) === null) flag('error', o, k + ' "' + o[k] + '" is not a time (HH:MM): ignored'); });
      if (!daysValid(o.DAYS)) flag('error', o, 'DAYS "' + o.DAYS + '" not understood (use 1 to 7, daily or 0)');
      const eta = time(o.ETA) || time(auto('STA')), etd = time(o.ETD) || time(auto('STD'));
      const manualTimes = !!(time(o.ETA) || time(o.ETD));
      const daysText = o.DAYS !== undefined && o.DAYS !== '' ? o.DAYS : auto('DAYS');
      let days = parseDays(daysText);
      const active = String(o.ACTIVE || '').trim().toUpperCase();
      const cancelled = active === 'CANCELLED' || active === 'CANCELED';
      if (active === 'NO' || active === 'FALSE' || active === '0') { days = []; flag('info', o, 'ACTIVE = NO: not shown'); }
      else if (String(daysText).trim() === '0') flag('info', o, 'DAYS = 0: not shown');
      else if (!daysText && (eta || etd)) { days = ALL_WEEK.slice(); flag('warn', o, 'No DAYS: shown every day'); }
      // airline: AIRLINE column, then AUTO_AIRLINE, then the Airlines tab by flight prefix
      let airlineName = o.AIRLINE || auto('AIRLINE');
      let al = airlineName ? byName.get(airlineName.toLowerCase()) : null;
      const byPrefix = airlines.find(a => (n.kind === 'IATA' ? a.iata : a.icao) === n.prefix && (a.iata || a.icao));
      if (!airlineName && byPrefix) { al = byPrefix; airlineName = byPrefix.name; }
      if (airlineName && !al) flag('warn', o, 'Airline "' + airlineName + '" is not in the Airlines tab');
      if (al && !al.iata && !al.icao) flag('warn', o, 'Airline "' + al.name + '" has no IATA / ICAO code: tracking uses the flight prefix ' + n.prefix + (byPrefix ? ' (' + byPrefix.name + ', ' + (byPrefix.icao || '?') + ')' : ''));
      else if (al && al.iata && n.kind === 'IATA' && al.iata !== n.prefix) flag('warn', o, 'Flight prefix ' + n.prefix + ' does not match ' + al.name + ' (' + al.iata + ')');
      const flightIn = o.FLIGHT_IN || auto('FLIGHT_IN');
      // FLIGHT_IN unknown: the departing number, then number - 1 and + 1 are tried (live tracking keeps
      // only the aircraft really flying to the airport, with a matching route).
      const inCalls = R.callsigns(flightIn || flightRaw, prefixes);
      const inGuess = flightIn ? [] : R.neighbours(flightRaw).flatMap(x => R.callsigns(x, prefixes).slice(0, 1));
      const extra = [o.CALLSIGN, auto('CALLSIGN')].map(c => String(c || '').toUpperCase().replace(/\s+/g, '')).filter(c => /^[A-Z0-9]{3,8}$/.test(c));
      if (!inCalls.length && !extra.length && days.length) flag('warn', o, 'No ICAO code for prefix ' + n.prefix + ': live tracking impossible (add it to Airlines or fill CALLSIGN)');
      const status = o.STATUS || (manualTimes ? 'Manual override' : eta || etd ? 'Resolved' : 'Unresolved');
      if (!eta && !etd) flag(days.length || !daysText ? 'warn' : 'info', o, 'Unresolved: no ETA / ETD (manual or automatic) yet');
      const row = {
        flight: flightRaw, eta, etd, sealing: time(o.SEALING), truck: time(o.TRUCK),
        profile: o.RULE_PROFILE || '', sealToTruck: o.SEAL_TO_TRUCK || '', truckOffset: o.TRUCK_OFFSET || '',
        aircraft: auto('AIRCRAFT'), airlineIata: al ? al.iata : '', airlineIcao: al ? al.icao : '', defaultProfile: al ? al.defaultProfile : '',
      };
      const plan = R.computeRow(row, rules);
      if (o.ETA && !time(o.ETA) && auto('STA')) flag('info', o, 'Using AUTO_STA ' + auto('STA'));
      if (!eta && /D-1/i.test(auto('STA'))) flag('info', o, 'Arrives the day before (' + auto('STA') + '): day stop');
      const si = o.SI && /^\d+$/.test(o.SI) ? parseInt(o.SI, 10) : null;
      rows.push({
        id: ctx.unit + ':' + (si !== null ? 'si' + si : 'r' + o._row) + ':' + n.norm,
        unit: ctx.unit, row: o._row, si, norm: n.norm,
        airline: airlineName || n.prefix, mealType: (o.MEAL || '').toLowerCase(), flight: flightRaw,
        eta, etd, sealing: time(o.SEALING) || R.m2t(plan.seal), truck: time(o.TRUCK) || R.m2t(plan.truck),
        days, flightOut: o.FLIGHT_OUT || '', flightIn, callsigns: [...new Set(inCalls.concat(extra))], inGuess, outCallsigns: R.callsigns(o.FLIGHT_OUT || flightRaw, prefixes),
        originIcao: (o.ORIGIN_ICAO || '').toUpperCase(), durationMin: o.DURATION_MIN ? parseInt(o.DURATION_MIN, 10) || null : null,
        status, notes: o.NOTES || '', cancelled, aircraft: row.aircraft,
        src: { eta: time(o.ETA) ? 'manual' : eta ? 'auto' : '', etd: time(o.ETD) ? 'manual' : etd ? 'auto' : '', sealing: plan.sealSource, truck: plan.truckSource,
          days: o.DAYS ? 'manual' : auto('DAYS') ? 'auto' : '', flightIn: o.FLIGHT_IN ? 'manual' : auto('FLIGHT_IN') ? 'auto' : '' },
        plan, input: row,
      });
    });

    // Box Time: rule for every flight, BoxTime tab as override (UNIT, then SI or FLIGHT).
    rows.forEach(f => {
      const b = (ctx.boxTime || []).find(x => (x.unit ? x.unit === ctx.unit : ctx.unit === ctx.defaultUnit) &&
        (x.si !== null && f.si !== null ? x.si === f.si : R.sameFlight(x.flight, f.flight)));
      const rule = f.plan.box, ov = b ? R.t2m(b.override) : null;
      f.box = ov !== null ? { day: b.day || (rule ? rule.day : 'D'), m: ov, source: 'override', rule } : rule ? Object.assign({ source: 'rule', rule }, rule) : null;
    });

    // duplicates and rule gaps (active rows only)
    const act = rows.filter(f => f.days.length);
    const overlap = (a, b) => a.days.some(d => b.days.includes(d));
    act.forEach((f, i) => act.slice(i + 1).forEach(g => {
      if (!overlap(f, g)) return;
      const ref = x => (x.si !== null ? 'SI ' + x.si : 'row ' + x.row);
      if (f.norm === g.norm && f.eta === g.eta && f.etd === g.etd) health.push({ level: 'error', row: g.row, si: g.si || '', flight: g.flight, msg: 'Duplicate of ' + f.flight + ' (' + ref(f) + ')' });
      else if (f.norm !== g.norm && f.airline === g.airline && f.eta && f.eta === g.eta && f.etd === g.etd) health.push({ level: 'warn', row: g.row, si: g.si || '', flight: g.flight, msg: 'Same airline, ETA, ETD and days as ' + f.flight + ' (' + ref(f) + '): duplicate?' });
    }));
    // rule gaps on every row, inactive ones included (they may be switched on again)
    rows.forEach(f => {
      const c = R.checkRow(Object.assign({ si: f.si }, f.input), rules, f.box && f.box.source === 'override' ? R.m2t(f.box.m) : '');
      const say = (what, gap, sheet, rule, text, extra) => {
        if (gap === null || Math.abs(gap) < rules.healthGap) return;
        health.push({ level: 'check', row: f.row, si: f.si || '', flight: f.flight,
          msg: what + ' ' + R.m2t(sheet) + (extra || '') + ' is ' + Math.abs(gap) + ' min ' + (gap > 0 ? 'earlier' : 'later') + ' than the rule (' + R.m2t(rule) + ', ' + text + ')' + (f.days.length ? '' : ' [inactive row]') });
      };
      const beforeEta = c.truckSheet !== null && c.eta !== null && /^ETA/.test(c.truckText) ? ((d) => ' (' + Math.abs(d) + ' min ' + (d >= 0 ? 'before' : 'after') + ' ETA)')(R.diff(c.eta, c.truckSheet)) : '';
      say('Truck', c.truckGap, c.truckSheet, c.truckRule, c.truckText, beforeEta);
      say('Sealing', c.sealGap, c.sealSheet, c.sealRule, c.sealText);
      if (c.boxOverride !== null) say('Box Time override', c.boxGap, c.boxOverride, c.boxRule, c.boxDay + ' rule');
    });
    // one IATA code on several Airlines rows
    const seen = {};
    airlines.forEach(a => { if (a.iata) (seen[a.iata] = seen[a.iata] || []).push(a.name); });
    Object.entries(seen).forEach(([code, names]) => { if (names.length > 1) health.push({ level: 'info', row: null, si: '', flight: code, msg: 'IATA ' + code + ' is on ' + names.length + ' Airlines rows (' + names.join(', ') + '): codes taken from ' + names[0] }); });

    const order = { error: 0, warn: 1, check: 2, info: 3 };
    health.sort((a, b) => order[a.level] - order[b.level] || (a.row || 0) - (b.row || 0));
    return { rows, flights: rows.filter(f => f.days.length), health, stats: stats(rows), rules };
  }

  // Flights and events per weekday (replaces the old manual stats tab).
  function stats(rows) {
    return ALL_WEEK.map(d => {
      const fl = rows.filter(f => f.days.includes(d));
      return { day: d, flights: fl.length, events: fl.reduce((n, f) => n + ['eta', 'etd', 'sealing', 'truck'].filter(k => f[k]).length, 0) };
    });
  }

  function icaoMap(airlines) {
    const m = {};
    (airlines || []).forEach(a => { if (a.iata && a.icao && !m[a.iata]) m[a.iata] = a.icao; });
    return m;
  }

  /* ---------- data source instance ---------- */

  function cleanUnit(u) { const s = String(u || '').trim().toUpperCase(); return /^[A-Z0-9_]{1,40}$/.test(s) ? s : ''; }

  function create(cfg, env) {
    const listeners = [];
    const unit = cleanUnit(new URLSearchParams(env.search || '').get('unit')) || cleanUnit(cfg.DEFAULT_UNIT) || 'MAIN';
    const gids = cfg.SHEET_TAB_GIDS || {};
    let localFile, gvizDownUntil = 0;
    const state = { unit, flights: [], flightRows: [], airlines: [], settings: {}, boxTime: [], airports: [], tabs: {}, health: [], stats: [], rules: null, syncedAt: null };

    // Tab definitions: name in the Sheet, validator (a gviz read of a missing tab returns the first tab).
    const TABS = {
      flights: { name: unit, valid: t => readUnitRows(parseCSV(t, true)) !== null },
      airlines: { name: 'Airlines', valid: t => parseAirlines(parseCSV(t)).length > 0 },
      settings: { name: 'RULES', valid: t => Object.keys(parseSettings(parseCSV(t))).length > 0 },
      unitRules: { name: 'RULES_' + unit, valid: t => parseCSV(t).some(r => r.map(headKey).includes('KEY')), optional: true },
      boxTime: { name: 'BoxTime', valid: t => parseCSV(t).some(r => r.map(headKey).includes('OVERRIDE')), optional: true },
      airports: { name: 'Airports', valid: t => parseAirports(parseCSV(t)).length > 0, optional: true, onlyGid: true },
    };

    function gvizUrl(name) {
      return 'https://docs.google.com/spreadsheets/d/' + encodeURIComponent(cfg.SHEET_ID) + '/gviz/tq?tqx=out:csv&headers=0&sheet=' + encodeURIComponent(name);
    }
    function readCache(name) {
      try {
        const raw = env.storage && env.storage.getItem(CACHE_PREFIX + name);
        if (raw) return JSON.parse(raw);
      } catch (e) { /* ignore corrupt cache */ }
      return null;
    }
    function writeCache(name, text, at) {
      try { env.storage && env.storage.setItem(CACHE_PREFIX + name, JSON.stringify({ at, text })); } catch (e) { /* quota */ }
    }
    function readLocalFile() {
      if (!localFile) {
        localFile = env.fetch(cfg.LOCAL_DATA_URL, { cache: 'no-store' }).then(r => (r.ok ? r.json() : null)).catch(() => null);
      }
      return localFile;
    }
    async function get(url) {
      const r = await env.fetch(url + (url.includes('?') ? '&' : '?') + 'cachebust=' + Date.now());
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.text();
    }

    // One tab: gviz by name, then published CSV by gid, then cache, then local file.
    async function loadTab(key) {
      const tab = TABS[key], gid = gids[tab.name];
      let error = null;
      const tries = [];
      if (cfg.SHEET_ID && !tab.onlyGid && Date.now() >= gvizDownUntil) tries.push(['gviz', gvizUrl(tab.name)]);
      if (gid !== undefined && gid !== null && gid !== '' && cfg.sheetTabUrl) tries.push(['pub', cfg.sheetTabUrl(gid)]);
      for (const [via, url] of tries) {
        try {
          const text = await get(url);
          if (tab.valid(text)) {
            const at = Date.now();
            writeCache(tab.name, text, at);
            return { text, source: 'sheet', via, at, error: null };
          }
          error = error || 'not found';
        } catch (e) {
          if (via === 'gviz') gvizDownUntil = Date.now() + GVIZ_RETRY_MS; // no link sharing: skip gviz for a while
          error = error || 'fetch';
        }
      }
      if (!tries.length) error = 'not-configured';
      const cached = readCache(tab.name);
      if (cached && cached.text) return { text: cached.text, source: 'cache', at: cached.at, error };
      const local = await readLocalFile();
      if (local && local.csv && local.csv[tab.name]) return { text: local.csv[tab.name], source: 'local', at: null, error };
      return { text: '', source: 'none', at: null, error: tab.optional && error !== 'fetch' ? null : error };
    }

    async function refresh() {
      const keys = Object.keys(TABS);
      const res = await Promise.all(keys.map(loadTab));
      const by = {};
      keys.forEach((k, i) => { by[k] = res[i]; state.tabs[k] = { name: TABS[k].name, source: res[i].source, via: res[i].via || '', at: res[i].at, error: res[i].error }; });
      let airlines = parseAirlines(parseCSV(by.airlines.text));
      if (!airlines.length) { // colours saved by earlier versions of the app on this device
        try { const legacy = env.storage && env.storage.getItem(LEGACY_AIRLINES_KEY); if (legacy) { airlines = JSON.parse(legacy); state.tabs.airlines.source = 'cache'; } } catch (e) { /* ignore */ }
      }
      const settings = Object.assign({}, parseSettings(parseCSV(by.settings.text)), parseSettings(parseCSV(by.unitRules.text)));
      state.airlines = airlines;
      state.settings = settings;
      state.boxTime = parseBoxTime(parseCSV(by.boxTime.text));
      state.airports = parseAirports(parseCSV(by.airports.text));
      const raw = readUnitRows(parseCSV(by.flights.text, true));
      const built = buildUnit(raw || [], { unit, defaultUnit: cleanUnit(cfg.DEFAULT_UNIT), airlines, settings, boxTime: state.boxTime });
      if (!raw && by.flights.text === '') built.health.unshift({ level: 'error', row: null, si: '', flight: '', msg: 'Tab "' + unit + '" could not be read (' + (by.flights.error || 'empty') + ')' });
      state.flightRows = built.rows;
      state.flights = built.flights;
      state.health = built.health;
      state.stats = built.stats;
      state.rules = built.rules;
      if (by.flights.source === 'sheet') state.syncedAt = by.flights.at;
      listeners.forEach(cb => { try { cb(state); } catch (e) { console.error(e); } });
      return state;
    }

    function setting(key, fallback) {
      const v = state.settings[String(key).toUpperCase()];
      if (v === undefined || v === '') return fallback;
      if (typeof fallback === 'number') { const n = Number(String(v).replace(',', '.')); return Number.isFinite(n) ? n : fallback; }
      return v;
    }

    // Airline of a flight number, looked up in every row (inactive rows included).
    function airlineForFlight(flight) {
      const r = state.flightRows.find(x => R.sameFlight(x.flight, flight));
      return r ? r.airline : '';
    }

    async function write() { throw new Error('The dashboard never writes to the Sheet.'); }

    return {
      refresh, setting, airlineForFlight, write, unit,
      icaoPrefixes: () => icaoMap(state.airlines),
      sheetUrl: () => (cfg.SHEET_ID ? 'https://docs.google.com/spreadsheets/d/' + cfg.SHEET_ID + '/edit' : ''),
      get: () => state,
      onChange: cb => { listeners.push(cb); },
    };
  }

  return { create, parseCSV, parseDays, parseTable, parseAirlines, parseSettings, parseBoxTime, parseAirports, readUnitRows, buildUnit, stats, ALL_WEEK };
});
