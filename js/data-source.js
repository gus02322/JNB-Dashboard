/*
 * ANGA data source.
 * The only module that knows where data comes from. Today: published Google Sheet CSV tabs,
 * with a localStorage cache (last good read) and an optional non-versioned local file as fallback.
 * To move to a database later, replace the readers below and keep the same public API:
 *   refresh(), get(), onChange(cb), setting(key, fallback), write(key, value).
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.AngaData = api.create(root.ANGA_CONFIG, {
    fetch: (...a) => root.fetch(...a),
    storage: root.localStorage,
  });
})(typeof window !== 'undefined' ? window : globalThis, function () {
  const DAY_NUM_MAP = { '1': 'MON', '2': 'TUE', '3': 'WED', '4': 'THU', '5': 'FRI', '6': 'SAT', '7': 'SUN' };
  const ALL_WEEK = ['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT', 'SUN'];
  const CACHE_PREFIX = 'anga_cache_';
  const LEGACY_AIRLINES_KEY = 'cop_airlines';

  /* ---------- parsing (pure) ---------- */

  // RFC 4180 CSV: quoted fields, "" escapes, commas and newlines inside quotes.
  function parseCSV(text) {
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
    return rows.filter(r => r.some(v => v !== ''));
  }

  function parseDays(str) {
    const s = String(str || '').replace(/\s/g, '');
    if (!s || s === '0') return [];
    if (s.toLowerCase() === 'daily' || s === '1234567') return ALL_WEEK.slice();
    return [...s].map(c => DAY_NUM_MAP[c]).filter(Boolean);
  }

  // Main flights tab. Data rows start with a number (SI). Columns:
  // SI, Airline, H/W, Flight, ETA, ETD, Sealing, Truck Dep, Days, [FLIGHT_OUT]
  // Returns every valid row, including rows with no operating day (Days = 0),
  // which are kept for lookups only and never shown on the board.
  function parseFlights(rows) {
    const out = [];
    rows.filter(r => /^\d+$/.test(r[0] || '')).forEach((c, i) => {
      if (c.length < 9) return;
      const airline = c[1], flight = c[3];
      if (!flight || !airline) return;
      out.push({
        id: 'gs' + i,
        si: parseInt(c[0], 10),
        airline,
        mealType: (c[2] || '').toLowerCase(),
        flight,
        eta: c[4] || '',
        etd: c[5] || '',
        sealing: c[6] || '',
        truck: c[7] || '',
        days: parseDays(c[8]),
        flightOut: c[9] || '',
      });
    });
    return out;
  }

  // Generic tab with a header row: returns objects keyed by UPPERCASE header.
  function parseTable(rows) {
    if (!rows.length) return [];
    const head = rows[0].map(h => h.trim().toUpperCase());
    return rows.slice(1).map(r => {
      const o = {};
      head.forEach((h, i) => { if (h) o[h] = (r[i] || '').trim(); });
      return o;
    });
  }

  function slug(s) { return String(s).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, ''); }

  function parseAirlines(rows) {
    return parseTable(rows).filter(o => o.NAME).map(o => ({
      id: slug(o.NAME), name: o.NAME, color: o.COLOR || '', iata: (o.IATA || '').toUpperCase(), icao: (o.ICAO || '').toUpperCase(),
    }));
  }

  function parseSettings(rows) {
    const s = {};
    parseTable(rows).forEach(o => { if (o.KEY) s[o.KEY.toUpperCase()] = o.VALUE || ''; });
    return s;
  }

  function parseBoxTime(rows) {
    return parseTable(rows).filter(o => o.FLIGHT).map(o => ({
      si: o.SI ? parseInt(o.SI, 10) : null,
      flight: o.FLIGHT,
      day: (o.DAY || '').toUpperCase(),
      override: o.OVERRIDE || '',
    }));
  }

  const TABS = {
    flights: { parse: t => ({ rows: parseFlights(parseCSV(t)) }), valid: d => d.rows.some(r => r.days.length) },
    airlines: { parse: t => parseAirlines(parseCSV(t)), valid: d => d.length > 0 },
    settings: { parse: t => parseSettings(parseCSV(t)), valid: d => Object.keys(d).length > 0 },
    boxTime: { parse: t => parseBoxTime(parseCSV(t)), valid: d => d.length > 0 },
  };
  const EMPTY = { flights: { rows: [] }, airlines: [], settings: {}, boxTime: [] };

  /* ---------- data source instance ---------- */

  function create(cfg, env) {
    const listeners = [];
    let localFile; // promise of the local file content (null when unavailable), read once
    const state = { flights: [], flightRows: [], airlines: [], settings: {}, boxTime: [], tabs: {} };

    function tabUrl(name) {
      if (name === 'flights') return cfg.SHEET_CSV_URL;
      const gid = cfg.SHEET_GIDS && cfg.SHEET_GIDS[name === 'settings' ? 'config' : name];
      return gid === null || gid === undefined || gid === '' ? null : cfg.sheetTabUrl(gid);
    }

    function readCache(name) {
      try {
        const raw = env.storage && env.storage.getItem(CACHE_PREFIX + name);
        if (raw) return JSON.parse(raw);
        if (name === 'airlines') { // colours saved by earlier versions of the app on this device
          const legacy = env.storage && env.storage.getItem(LEGACY_AIRLINES_KEY);
          if (legacy) return { at: null, data: JSON.parse(legacy) };
        }
      } catch (e) { /* ignore corrupt cache */ }
      return null;
    }
    function writeCache(name, data, at) {
      try { env.storage && env.storage.setItem(CACHE_PREFIX + name, JSON.stringify({ at, data })); } catch (e) { /* quota */ }
    }

    function readLocalFile() {
      if (!localFile) {
        localFile = env.fetch(cfg.LOCAL_DATA_URL, { cache: 'no-store' })
          .then(r => (r.ok ? r.json() : null))
          .catch(() => null);
      }
      return localFile;
    }

    async function loadTab(name) {
      const tab = TABS[name], url = tabUrl(name);
      let error = url ? null : 'not-configured';
      if (url) {
        try {
          const r = await env.fetch(url + '&cachebust=' + Date.now());
          if (!r.ok) throw new Error('HTTP ' + r.status);
          const data = tab.parse(await r.text());
          if (tab.valid(data)) {
            const at = Date.now();
            writeCache(name, data, at);
            return { data, source: 'sheet', at, error: null };
          }
          error = 'parse';
        } catch (e) { error = 'fetch'; }
      }
      const cached = readCache(name);
      if (cached && cached.data) return { data: cached.data, source: 'cache', at: cached.at, error };
      const local = await readLocalFile();
      if (local && local[name]) return { data: local[name], source: 'local', at: null, error };
      return { data: EMPTY[name], source: 'none', at: null, error };
    }

    async function refresh() {
      const names = Object.keys(TABS);
      const results = await Promise.all(names.map(loadTab));
      names.forEach((n, i) => { state.tabs[n] = { source: results[i].source, at: results[i].at, error: results[i].error }; });
      const byName = Object.fromEntries(names.map((n, i) => [n, results[i].data]));
      state.flightRows = byName.flights.rows || [];
      state.flights = state.flightRows.filter(f => f.days && f.days.length);
      state.airlines = byName.airlines;
      state.settings = byName.settings;
      state.boxTime = byName.boxTime;
      listeners.forEach(cb => { try { cb(state); } catch (e) { console.error(e); } });
      return state;
    }

    function setting(key, fallback) {
      const v = state.settings[String(key).toUpperCase()];
      if (v === undefined || v === '') return fallback;
      if (typeof fallback === 'number') { const n = Number(v); return Number.isFinite(n) ? n : fallback; }
      return v;
    }

    // Airline of a flight number, looked up in every row (Days = 0 included).
    function airlineForFlight(flight) {
      const r = state.flightRows.find(x => x.flight === flight);
      return r ? r.airline : '';
    }

    // IATA prefix to ICAO prefix, from the Airlines tab.
    function icaoPrefixes() {
      const m = {};
      state.airlines.forEach(a => { if (a.iata && a.icao && !m[a.iata]) m[a.iata] = a.icao; });
      return m;
    }

    async function write() {
      throw new Error('Writing is not available yet.');
    }

    return {
      refresh, setting, airlineForFlight, icaoPrefixes, write,
      get: () => state,
      onChange: cb => { listeners.push(cb); },
    };
  }

  return { create, parseCSV, parseDays, parseFlights, parseTable, parseAirlines, parseSettings, parseBoxTime };
});
