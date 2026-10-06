/**
 * ANGA live tracking relay (Google Apps Script web app, free).
 *
 * 1. doGet: the browser cannot call the tracking API directly (CORS). This script calls it from
 *    Google's servers, keeps each answer in cache for CACHE_SEC seconds so that every screen shares
 *    the same request, and returns only the fields the dashboard needs. It also returns, per flight,
 *    the median deviation of past days computed from the private "History" tab.
 *
 * GET <web app url>?cs=CALLSIGN1,CALLSIGN2&lat=..&lon=..&r=40&route=CALLSIGN1,CALLSIGN2
 *   cs    callsigns to look up worldwide (max 30)
 *   lat, lon, r  optional point query around the airport (r in nm, max 250)
 *   route optional callsigns whose route should be checked (max 30)
 *
 * 2. recordHistory: run by a time trigger (installTrigger, once). It reads the Sheet itself (never
 *    data sent by a browser), looks up today's arriving flights, and upserts one row per
 *    DATE + FLIGHT + ETA_SCHEDULED in the "History" tab: first and last time seen in flight, landing
 *    time (on the ground near the airport after being seen in flight) and the deviation in minutes.
 *    The History tab must NOT be published to the web.
 *
 * Script properties (Project Settings > Script Properties):
 *   SHEET_ID     id of the Google Sheet (the long id in its address). Required for the history.
 *   TRIGGER_MIN  written by installTrigger.
 * No secret here: the tracking API needs no key today. If a key is required later, store it in the
 * script properties (never in this file).
 */
var API = 'https://api.adsb.lol';
var CACHE_SEC = 55;
var ROUTE_CACHE_SEC = 3600;
var MAX_CS = 30;
var FIELDS = ['hex', 'flight', 'r', 't', 'lat', 'lon', 'gs', 'track', 'alt_baro', 'baro_rate', 'seen_pos'];

var HISTORY_SHEET = 'History';
var HISTORY_HEAD = ['DATE', 'FLIGHT', 'ETA_SCHEDULED', 'FIRST_SEEN_AT', 'ETA_LIVE_AT_FIRST_SEEN', 'LAST_SEEN_AT',
  'LANDED_AT', 'DEVIATION_MIN', 'PRECISION_MIN', 'NOTE'];
var HISTORY_WATCH_BEFORE_MIN = 120; // record a flight from its scheduled ETA - 120 min
var HISTORY_WATCH_AFTER_MIN = 180;  // until its scheduled ETA + 180 min (late arrivals)
var AMBIGUITY_MARGIN_MIN = 60;      // two Sheet rows this close to the observation: ambiguous
var STATS_CACHE_SEC = 600;

/* ---------------- web app ---------------- */

function doGet(e) {
  var p = (e && e.parameter) || {};
  var out = { now: Date.now(), cs: {}, point: null, routes: {}, errors: [] };
  try {
    var cache = CacheService.getScriptCache();
    var fetched = fetchCallsigns(list(p.cs), cache);
    out.cs = fetched.cs;
    out.errors = out.errors.concat(fetched.errors);

    var lat = num(p.lat, -90, 90), lon = num(p.lon, -180, 180), r = num(p.r, 1, 250);
    if (lat !== null && lon !== null && r !== null) {
      var pkey = 'pt:' + lat.toFixed(3) + ',' + lon.toFixed(3) + ',' + Math.round(r);
      var phit = cache.get(pkey);
      if (phit) out.point = JSON.parse(phit);
      else {
        var res = UrlFetchApp.fetch(API + '/v2/point/' + lat + '/' + lon + '/' + Math.round(r), { muteHttpExceptions: true });
        if (res.getResponseCode() !== 200) out.errors.push({ id: pkey, status: res.getResponseCode() });
        else { out.point = slim(JSON.parse(res.getContentText()).ac || []); cache.put(pkey, JSON.stringify(out.point), CACHE_SEC); }
      }
    }

    var routeCs = list(p.route);
    var missing = routeCs.filter(function (cs) {
      var hit = cache.get('rt:' + cs);
      if (hit) { out.routes[cs] = JSON.parse(hit); return false; }
      return true;
    });
    if (missing.length) {
      var planes = missing.map(function (cs) {
        var ac = (out.cs[cs] || [])[0] || {};
        return { callsign: cs, lat: ac.lat || 0, lng: ac.lon || 0 };
      });
      var rr = UrlFetchApp.fetch(API + '/api/0/routeset', {
        method: 'post', contentType: 'application/json', payload: JSON.stringify({ planes: planes }), muteHttpExceptions: true,
      });
      if (rr.getResponseCode() === 200) {
        var arr = JSON.parse(rr.getContentText());
        (Array.isArray(arr) ? arr : []).forEach(function (item) {
          var cs = String(item.callsign || '').trim().toUpperCase();
          if (!cs) return;
          out.routes[cs] = item;
          cache.put('rt:' + cs, JSON.stringify(item), ROUTE_CACHE_SEC);
        });
      } else out.errors.push({ id: 'routeset', status: rr.getResponseCode() });
    }
  } catch (err) {
    out.errors.push({ id: 'relay', message: String(err) });
  }
  try {
    var hs = historyStats();
    out.history = hs.stats;
    if (hs.warning) out.warnings = [hs.warning];
  } catch (err) {
    out.errors.push({ id: 'history', message: String(err) });
  }
  return ContentService.createTextOutput(JSON.stringify(out)).setMimeType(ContentService.MimeType.JSON);
}

function fetchCallsigns(callsigns, cache) {
  var out = { cs: {}, errors: [] }, requests = [], keys = [];
  callsigns.forEach(function (cs) {
    var hit = cache.get('cs:' + cs);
    if (hit) out.cs[cs] = JSON.parse(hit);
    else { keys.push(cs); requests.push({ url: API + '/v2/callsign/' + cs, muteHttpExceptions: true }); }
  });
  if (requests.length) {
    UrlFetchApp.fetchAll(requests).forEach(function (res, i) {
      var code = res.getResponseCode();
      if (code !== 200) { out.errors.push({ id: keys[i], status: code }); return; }
      var ac = slim(JSON.parse(res.getContentText()).ac || []);
      out.cs[keys[i]] = ac;
      cache.put('cs:' + keys[i], JSON.stringify(ac), CACHE_SEC);
    });
  }
  return out;
}

/* ---------------- history: medians for the dashboard ---------------- */

function historyStats() {
  var cache = CacheService.getScriptCache(), hit = cache.get('hist:stats');
  if (hit) return JSON.parse(hit);
  var ss = sheetBook(), cfg = readConfig(ss), res = { stats: {}, warning: tzWarning(cfg) };
  var sh = ss.getSheetByName(HISTORY_SHEET);
  if (isTrue(cfg.HISTORY_ENABLED) && sh) {
    var tz = timeZone(cfg), keep = toNum(cfg.HISTORY_KEEP_DAYS, 90), outlier = toNum(cfg.HISTORY_OUTLIER_MAX_MIN, 360);
    var cutoff = Utilities.formatDate(new Date(Date.now() - keep * 86400000), tz, 'yyyy-MM-dd');
    var groups = {};
    readHistory(sh).rows.forEach(function (r) {
      if (r.DATE < cutoff) return;
      var d = parseFloat(r.DEVIATION_MIN);
      if (!isFinite(d) || Math.abs(d) > outlier) return;
      var k = String(r.FLIGHT).toUpperCase() + '|' + r.ETA_SCHEDULED;
      (groups[k] = groups[k] || []).push(d);
    });
    Object.keys(groups).forEach(function (k) { res.stats[k] = { median: median(groups[k]), n: groups[k].length }; });
  }
  cache.put('hist:stats', JSON.stringify(res), STATS_CACHE_SEC);
  return res;
}

/* ---------------- history: recording (time trigger) ---------------- */

function recordHistory() {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(20000)) return;
  try {
    var ss = sheetBook(), cfg = readConfig(ss);
    if (!isTrue(cfg.HISTORY_ENABLED)) return;
    var tz = timeZone(cfg), now = new Date(), nowMin = minutesOfDay(now, tz);
    var today = Utilities.formatDate(now, tz, 'yyyy-MM-dd');
    var yesterday = Utilities.formatDate(new Date(now.getTime() - 86400000), tz, 'yyyy-MM-dd');
    var dowToday = parseInt(Utilities.formatDate(now, tz, 'u'), 10); // 1 = Monday ... 7 = Sunday
    var dowYesterday = dowToday === 1 ? 7 : dowToday - 1;
    var prefixes = readPrefixes(ss), flights = readFlights(ss);

    // Rows of today and of yesterday (late arrivals after midnight), times relative to today's midnight.
    var cands = [];
    [[today, dowToday, 0], [yesterday, dowYesterday, -1440]].forEach(function (d) {
      flights.forEach(function (f) {
        if (f.eta === null || f.days.indexOf(String(d[1])) < 0) return; // Days = 0: not operating, ignored
        var etaAbs = f.eta + d[2];
        if (nowMin < etaAbs - HISTORY_WATCH_BEFORE_MIN || nowMin > etaAbs + HISTORY_WATCH_AFTER_MIN) return;
        var arriving = f.flightIn || f.flight;
        callsignCandidates(arriving, prefixes).forEach(function (cs) {
          cands.push({ date: d[0], si: f.si, flight: arriving, etaText: f.etaText, etaAbs: etaAbs, cs: cs });
        });
      });
    });

    var sh = historySheet(ss), table = readHistory(sh);
    if (cands.length) {
      var fetched = fetchCallsigns(unique(cands.map(function (c) { return c.cs; })), CacheService.getScriptCache());
      var lat = parseFloat(cfg.AIRPORT_LAT), lon = parseFloat(cfg.AIRPORT_LON);
      var radius = toNum(cfg.LANDED_RADIUS_NM, 5), margin = toNum(cfg.APPROACH_MARGIN_MIN, 5), minGs = toNum(cfg.MIN_GS_KT, 150);
      var outlier = toNum(cfg.HISTORY_OUTLIER_MAX_MIN, 360);
      var precision = toNum(PropertiesService.getScriptProperties().getProperty('TRIGGER_MIN'), Math.round(toNum(cfg.ADSB_REFRESH_SEC, 1200) / 60));
      var byCs = {};
      cands.forEach(function (c) { (byCs[c.cs] = byCs[c.cs] || []).push(c); });

      Object.keys(byCs).forEach(function (cs) {
        var acs = (fetched.cs[cs] || []).filter(function (a) { return typeof a.lat === 'number'; });
        if (!acs.length || !isFinite(lat)) return;
        var ac = acs.sort(function (a, b) { return (a.seen_pos || 0) - (b.seen_pos || 0); })[0];
        // Attach the observation to the row with the closest scheduled ETA; too close to call: ambiguous.
        var rows = byCs[cs].sort(function (a, b) { return Math.abs(a.etaAbs - nowMin) - Math.abs(b.etaAbs - nowMin); });
        if (rows.length > 1 && Math.abs(rows[1].etaAbs - nowMin) - Math.abs(rows[0].etaAbs - nowMin) < AMBIGUITY_MARGIN_MIN) {
          var note = 'ambiguous: ' + cs + ' matches SI ' + rows.map(function (x) { return x.si; }).join(', ') + ', no deviation recorded';
          rows.forEach(function (r) { upsert(table, r, { NOTE: note }); });
          return;
        }
        var r = rows[0], rec = table.byKey[key(r.date, r.flight, r.etaText)];
        var obsMin = nowMin - (ac.seen_pos || 0) / 60;
        var stamp = Utilities.formatDate(new Date(now.getTime() - (ac.seen_pos || 0) * 1000), tz, 'yyyy-MM-dd HH:mm');
        var dist = haversineNm(ac.lat, ac.lon, lat, lon);
        if (ac.alt_baro === 'ground') {
          // Landing: on the ground near the airport after being seen in flight for this row.
          if (dist <= radius && rec && rec.FIRST_SEEN_AT && !rec.LANDED_AT) {
            var dev = Math.round(obsMin - r.etaAbs); // both relative to today's midnight: midnight handled
            upsert(table, r, { LANDED_AT: stamp, DEVIATION_MIN: dev, PRECISION_MIN: precision,
              NOTE: Math.abs(dev) > outlier ? 'outlier, ignored in the median' : (rec.NOTE || '') });
          }
          return;
        }
        if (typeof ac.track === 'number' && dist > radius) {
          var off = Math.abs(((ac.track - bearingDeg(ac.lat, ac.lon, lat, lon)) % 360 + 540) % 360 - 180);
          if (off > 100) return; // flying away: not this arrival
        }
        var upd = { LAST_SEEN_AT: stamp };
        if (!rec || !rec.FIRST_SEEN_AT) {
          upd.FIRST_SEEN_AT = stamp;
          if (ac.gs >= minGs) upd.ETA_LIVE_AT_FIRST_SEEN = hhmm(obsMin + dist / ac.gs * 60 + margin);
        }
        upsert(table, r, upd);
      });
    }
    writeHistory(sh, table, cfg);
    CacheService.getScriptCache().remove('hist:stats');
  } finally {
    lock.releaseLock();
  }
}

/** Run once from the editor: creates the History tab and the time trigger. */
function installTrigger() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'recordHistory') ScriptApp.deleteTrigger(t);
  });
  var ss = sheetBook(), cfg = readConfig(ss);
  var refreshMin = Math.round(toNum(cfg.ADSB_REFRESH_SEC, 1200) / 60), n = 5;
  [5, 10, 15, 30].forEach(function (a) { if (a <= refreshMin) n = a; }); // allowed trigger intervals
  ScriptApp.newTrigger('recordHistory').timeBased().everyMinutes(n).create();
  PropertiesService.getScriptProperties().setProperty('TRIGGER_MIN', String(n));
  historySheet(ss);
  var msg = 'recordHistory runs every ' + n + ' min. ' + (tzWarning(cfg) || 'Time zone OK: ' + timeZone(cfg));
  Logger.log(msg);
  return msg;
}

/* ---------------- Sheet access ---------------- */

function sheetBook() {
  var id = PropertiesService.getScriptProperties().getProperty('SHEET_ID');
  if (!id) throw new Error('Script property SHEET_ID is missing');
  return SpreadsheetApp.openById(id);
}

function readConfig(ss) {
  var cache = CacheService.getScriptCache(), hit = cache.get('cfg');
  if (hit) return JSON.parse(hit);
  var cfg = {}, sh = ss.getSheetByName('Config');
  if (sh) {
    var v = sh.getDataRange().getDisplayValues(), h = v[0].map(function (x) { return String(x).trim().toUpperCase(); });
    var ik = h.indexOf('KEY'), iv = h.indexOf('VALUE');
    v.slice(1).forEach(function (r) { if (r[ik]) cfg[String(r[ik]).trim().toUpperCase()] = String(r[iv]).trim(); });
  }
  cache.put('cfg', JSON.stringify(cfg), 300);
  return cfg;
}

function readPrefixes(ss) {
  var m = {}, sh = ss.getSheetByName('Airlines');
  if (!sh) return m;
  var v = sh.getDataRange().getDisplayValues(), h = v[0].map(function (x) { return String(x).trim().toUpperCase(); });
  var ia = h.indexOf('IATA'), ii = h.indexOf('ICAO');
  v.slice(1).forEach(function (r) {
    var a = String(r[ia] || '').trim().toUpperCase(), i = String(r[ii] || '').trim().toUpperCase();
    if (a && i && !m[a]) m[a] = i;
  });
  return m;
}

// Main tab: SI, Airline, H/W, Flight, ETA, ETD, Sealing, Truck Dep, Days, [FLIGHT_OUT], [FLIGHT_IN]
function readFlights(ss) {
  return ss.getSheets()[0].getDataRange().getDisplayValues().filter(function (r) {
    return /^\d+$/.test(String(r[0]).trim()) && r[1] && r[3];
  }).map(function (r) {
    var d = String(r[8] || '').replace(/\s/g, '');
    return {
      si: parseInt(r[0], 10), flight: String(r[3]).trim().toUpperCase(), etaText: String(r[4]).trim(), eta: t2m(r[4]),
      days: d.toLowerCase() === 'daily' ? '1234567' : d === '0' ? '' : d, flightIn: String(r[10] || '').trim().toUpperCase(),
    };
  });
}

function historySheet(ss) {
  var sh = ss.getSheetByName(HISTORY_SHEET);
  if (!sh) {
    sh = ss.insertSheet(HISTORY_SHEET);
    sh.getRange(1, 1, sh.getMaxRows(), HISTORY_HEAD.length).setNumberFormat('@'); // keep dates and times as text
    sh.getRange(1, 1, 1, HISTORY_HEAD.length).setValues([HISTORY_HEAD]).setFontWeight('bold');
    sh.setFrozenRows(1);
  }
  return sh;
}

function readHistory(sh) {
  var v = sh.getDataRange().getDisplayValues(), rows = [], byKey = {};
  v.slice(1).forEach(function (r) {
    if (!r[0]) return;
    var o = {};
    HISTORY_HEAD.forEach(function (h, i) { o[h] = r[i] === undefined ? '' : String(r[i]); });
    rows.push(o);
    byKey[key(o.DATE, o.FLIGHT, o.ETA_SCHEDULED)] = o;
  });
  return { rows: rows, byKey: byKey };
}

function key(date, flight, eta) { return date + '|' + String(flight).toUpperCase() + '|' + eta; }

// Upsert on DATE + FLIGHT + ETA_SCHEDULED: one row per scheduled arrival, never duplicated.
function upsert(table, r, fields) {
  var k = key(r.date, r.flight, r.etaText), o = table.byKey[k];
  if (!o) {
    o = {};
    HISTORY_HEAD.forEach(function (h) { o[h] = ''; });
    o.DATE = r.date; o.FLIGHT = r.flight; o.ETA_SCHEDULED = r.etaText;
    table.rows.push(o);
    table.byKey[k] = o;
  }
  Object.keys(fields).forEach(function (f) { o[f] = fields[f] === undefined || fields[f] === null ? '' : String(fields[f]); });
}

// Rewrites the tab, dropping rows older than HISTORY_KEEP_DAYS.
function writeHistory(sh, table, cfg) {
  var keep = toNum(cfg.HISTORY_KEEP_DAYS, 90);
  var cutoff = Utilities.formatDate(new Date(Date.now() - keep * 86400000), timeZone(cfg), 'yyyy-MM-dd');
  var rows = table.rows.filter(function (o) { return o.DATE >= cutoff; })
    .sort(function (a, b) { return (a.DATE + a.ETA_SCHEDULED).localeCompare(b.DATE + b.ETA_SCHEDULED); })
    .map(function (o) { return HISTORY_HEAD.map(function (h) { return o[h]; }); });
  var last = sh.getLastRow();
  if (last > 1) sh.getRange(2, 1, last - 1, HISTORY_HEAD.length).clearContent();
  if (rows.length) sh.getRange(2, 1, rows.length, HISTORY_HEAD.length).setNumberFormat('@').setValues(rows);
}

/* ---------------- helpers ---------------- */

function timeZone(cfg) { return cfg.TIMEZONE || Session.getScriptTimeZone(); }
function tzWarning(cfg) {
  var tz = Session.getScriptTimeZone();
  return cfg.TIMEZONE && cfg.TIMEZONE !== tz
    ? 'Project time zone ' + tz + ' differs from Config TIMEZONE ' + cfg.TIMEZONE + ': set it in Project Settings' : '';
}
function minutesOfDay(d, tz) { return parseInt(Utilities.formatDate(d, tz, 'H'), 10) * 60 + parseInt(Utilities.formatDate(d, tz, 'm'), 10) + d.getSeconds() / 60; }
function t2m(t) { var m = /^(\d{1,2}):(\d{2})/.exec(String(t || '').trim()); return m ? parseInt(m[1], 10) * 60 + parseInt(m[2], 10) : null; }
function hhmm(m) { m = ((Math.round(m) % 1440) + 1440) % 1440; return ('0' + Math.floor(m / 60)).slice(-2) + ':' + ('0' + (m % 60)).slice(-2); }
function isTrue(v) { return String(v).trim().toUpperCase() === 'TRUE'; }
function toNum(v, d) { var n = parseFloat(v); return isFinite(n) ? n : d; }
function unique(a) { return a.filter(function (x, i) { return a.indexOf(x) === i; }); }
function median(a) {
  var v = a.slice().sort(function (x, y) { return x - y; }), m = Math.floor(v.length / 2);
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
}
function haversineNm(lat1, lon1, lat2, lon2) {
  var r = Math.PI / 180;
  var a = Math.pow(Math.sin((lat2 - lat1) * r / 2), 2) + Math.cos(lat1 * r) * Math.cos(lat2 * r) * Math.pow(Math.sin((lon2 - lon1) * r / 2), 2);
  return 2 * 3440.065 * Math.asin(Math.min(1, Math.sqrt(a)));
}
function bearingDeg(lat1, lon1, lat2, lon2) {
  var r = Math.PI / 180, y = Math.sin((lon2 - lon1) * r) * Math.cos(lat2 * r);
  var x = Math.cos(lat1 * r) * Math.sin(lat2 * r) - Math.sin(lat1 * r) * Math.cos(lat2 * r) * Math.cos((lon2 - lon1) * r);
  return (Math.atan2(y, x) / r + 360) % 360;
}
// Same rule as the dashboard: ICAO prefix from the Airlines tab, also tried without leading zeros.
function callsignCandidates(flight, prefixes) {
  var m = /^([A-Z0-9]{2})(\d{1,4})([A-Z]?)$/.exec(String(flight || '').replace(/\s+/g, '').toUpperCase());
  if (!m || !prefixes[m[1]]) return [];
  var a = prefixes[m[1]] + m[2] + m[3], b = prefixes[m[1]] + String(parseInt(m[2], 10)) + m[3];
  return a === b ? [a] : [a, b];
}
function list(s) {
  return String(s || '').split(',').map(function (x) { return x.trim().toUpperCase(); })
    .filter(function (x) { return /^[A-Z0-9]{2,8}$/.test(x); }).slice(0, MAX_CS);
}
function num(s, min, max) {
  var n = parseFloat(s);
  return isFinite(n) && n >= min && n <= max ? n : null;
}
function slim(ac) {
  return ac.map(function (a) {
    var o = {};
    FIELDS.forEach(function (f) { if (a[f] !== undefined) o[f] = a[f]; });
    if (o.flight) o.flight = String(o.flight).trim();
    return o;
  });
}
