/**
 * Ops On Time relay (Google Apps Script, bound to the Sheet, deployed as a web app, free).
 *
 * PUBLIC, READ ONLY: doGet
 *   The browser cannot call the tracking API directly (CORS). doGet calls it from Google's servers,
 *   keeps each answer in cache CACHE_SEC seconds so that every screen shares the same request, and
 *   returns only the fields the dashboard needs, plus the median deviation of past days per flight.
 *   doGet never writes to the Sheet and never calls the schedule API. There is no doPost.
 *
 *   GET <web app url>?cs=CS1,CS2&lat=..&lon=..&r=40&route=CS1,CS2&u=UNIT
 *     cs     callsigns to look up worldwide (max MAX_CS)
 *     lat, lon, r  optional point query around the airport (r in nm, max 250)
 *     route  optional callsigns whose route should be checked (max MAX_CS)
 *     u      unit tab whose history medians are returned (default: DEFAULT_UNIT of RULES)
 *
 * PRIVATE (owner only): Sheet menu "Ops On Time" and time triggers
 *   resolveFlights   fills the AUTO_* columns of every unit tab from the schedule API (AeroDataBox),
 *                    one request per airport and per 12 h window, cached in the private ScheduleCache tab.
 *   recordHistory    records real landing times in the private History tab and learns the callsign
 *                    really seen for each arriving flight (AUTO_CALLSIGN).
 *   Every automatic change is logged in the Audit tab (DATE, SOURCE, KEY, OLD, NEW).
 *
 * Script properties (Project Settings > Script properties). Never in this file, never in the Sheet:
 *   AERODATABOX_KEY   RapidAPI key of the AeroDataBox API (schedules). Without it, nothing is resolved.
 *   AERODATABOX_HOST  optional, default aerodatabox.p.rapidapi.com
 *   ADB_MAX_CALLS_MONTH optional, default 300: the resolver stops before this many calls in a month.
 *   SHEET_ID          only if the script is not bound to the Sheet.
 *   TRIGGER_MIN       written by installTriggers.
 */
var API = 'https://api.adsb.lol';
var CACHE_SEC = 55;
var ROUTE_CACHE_SEC = 3600;
var MAX_CS = 40;
var MAX_UPSTREAM_PER_MIN = 150;     // protects the free UrlFetch quota against abuse of the public URL
var FIELDS = ['hex', 'flight', 'r', 't', 'lat', 'lon', 'gs', 'track', 'alt_baro', 'baro_rate', 'seen_pos'];

var HISTORY_SHEET = 'History';
var HISTORY_HEAD = ['DATE', 'FLIGHT', 'ETA_SCHEDULED', 'FIRST_SEEN_AT', 'ETA_LIVE_AT_FIRST_SEEN', 'LAST_SEEN_AT',
  'LANDED_AT', 'DEVIATION_MIN', 'PRECISION_MIN', 'NOTE', 'UNIT', 'CALLSIGN'];
var HISTORY_WATCH_BEFORE_MIN = 120; // record a flight from its scheduled ETA - 120 min
var HISTORY_WATCH_AFTER_MIN = 180;  // until its scheduled ETA + 180 min (late arrivals)
var AMBIGUITY_MARGIN_MIN = 60;      // two Sheet rows this close to the observation: ambiguous
var STATS_CACHE_SEC = 600;
var DEPARTURES_SHEET = 'Departures';
var DEPARTURES_HEAD = ['DATE', 'UNIT', 'FLIGHT', 'ETD_SCHEDULED', 'GROUND_SEEN_AT', 'DEPARTED_AT', 'ESTIMATED', 'LAST_SEEN_AT', 'CALLSIGN'];
var DEP_WATCH_BEFORE_MIN = 60;      // watch a departure from its scheduled ETD - 60 min
var DEP_WATCH_AFTER_MIN = 240;      // until ETD + 240 min
var TODAY_CACHE_SEC = 120;

var SCHEDULE_SHEET = 'ScheduleCache';
var SCHEDULE_HEAD = ['AIRPORT', 'DATE', 'DIR', 'NUMBER', 'TIME', 'CALLSIGN', 'AIRCRAFT', 'REG', 'AIRLINE', 'STATUS', 'FETCHED_AT', 'ORIGIN'];
var AUDIT_SHEET = 'Audit';
var AUDIT_HEAD = ['DATE', 'SOURCE', 'KEY', 'OLD', 'NEW'];
var AUTO_COLS = ['AUTO_STA', 'AUTO_STD', 'AUTO_DAYS', 'AUTO_FLIGHT_IN', 'AUTO_CALLSIGN', 'AUTO_AIRLINE', 'AUTO_AIRCRAFT', 'AUTO_ORIGIN', 'STATUS'];

/* ---------------- web app: public, read only ---------------- */

function doGet(e) {
  var p = (e && e.parameter) || {};
  var out = { now: Date.now(), cs: {}, point: null, routes: {}, errors: [] };
  var cache = CacheService.getScriptCache();
  try {
    var fetched = fetchCallsigns(list(p.cs), cache, true);
    out.cs = fetched.cs;
    out.errors = out.errors.concat(fetched.errors);

    var lat = num(p.lat, -90, 90), lon = num(p.lon, -180, 180), r = num(p.r, 1, 250);
    if (lat !== null && lon !== null && r !== null) {
      var pkey = 'pt:' + lat.toFixed(3) + ',' + lon.toFixed(3) + ',' + Math.round(r);
      var phit = cache.get(pkey);
      if (phit) out.point = JSON.parse(phit);
      else if (!spend(cache, 1)) out.errors.push({ id: 'relay-quota', status: 429 });
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
    if (missing.length && spend(cache, 1)) {
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
    var hs = historyStats(cleanUnit(p.u));
    out.history = hs.stats;
    if (hs.warning) out.warnings = [hs.warning];
  } catch (err) {
    out.errors.push({ id: 'history', message: String(err) });
  }
  try {
    out.today = todayEvents(cleanUnit(p.u));
  } catch (err) {
    out.errors.push({ id: 'today', message: String(err) });
  }
  return ContentService.createTextOutput(JSON.stringify(out)).setMimeType(ContentService.MimeType.JSON);
}

// Upstream calls per minute, shared by every caller of the public URL. false = over the limit.
function spend(cache, n) {
  var k = 'q:' + Math.floor(Date.now() / 60000), used = parseInt(cache.get(k) || '0', 10);
  if (used + n > MAX_UPSTREAM_PER_MIN) return false;
  cache.put(k, String(used + n), 120);
  return true;
}

function fetchCallsigns(callsigns, cache, guarded) {
  var out = { cs: {}, errors: [] }, requests = [], keys = [];
  callsigns.forEach(function (cs) {
    var hit = cache.get('cs:' + cs);
    if (hit) out.cs[cs] = JSON.parse(hit);
    else { keys.push(cs); requests.push({ url: API + '/v2/callsign/' + cs, muteHttpExceptions: true }); }
  });
  if (requests.length && guarded && !spend(cache, requests.length)) {
    out.errors.push({ id: 'relay-quota', status: 429 });
    return out;
  }
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

function historyStats(unit) {
  var cache = CacheService.getScriptCache(), ck = 'hist:stats:' + (unit || '');
  var hit = cache.get(ck);
  if (hit) return JSON.parse(hit);
  var ss = sheetBook(), cfg = readRules(ss, ''), res = { stats: {}, warning: tzWarning(cfg) };
  unit = unit || cfg.DEFAULT_UNIT || '';
  var sh = ss.getSheetByName(HISTORY_SHEET);
  if (isTrue(cfg.HISTORY_ENABLED) && sh) {
    var tz = timeZone(cfg), keep = toNum(cfg.HISTORY_KEEP_DAYS, 90), outlier = toNum(cfg.HISTORY_OUTLIER_MAX_MIN, 360);
    var cutoff = Utilities.formatDate(new Date(Date.now() - keep * 86400000), tz, 'yyyy-MM-dd');
    var groups = {};
    readHistory(sh).rows.forEach(function (r) {
      if (r.DATE < cutoff) return;
      if (r.UNIT && unit && r.UNIT !== unit) return;
      var d = parseFloat(r.DEVIATION_MIN);
      if (!isFinite(d) || Math.abs(d) > outlier) return;
      var k = String(r.FLIGHT).toUpperCase() + '|' + r.ETA_SCHEDULED;
      (groups[k] = groups[k] || []).push(d);
    });
    Object.keys(groups).forEach(function (k) { res.stats[k] = { median: median(groups[k]), n: groups[k].length }; });
  }
  cache.put(ck, JSON.stringify(res), STATS_CACHE_SEC);
  return res;
}

// Landings and take-offs already detected today by the trigger, shared with every screen
// (a screen opened after the aircraft left the live coverage still knows it took off).
function todayEvents(unit) {
  var cache = CacheService.getScriptCache(), ck = 'today:' + (unit || ''), hit = cache.get(ck);
  if (hit) return JSON.parse(hit);
  var ss = sheetBook(), cfg = readRules(ss, unit), out = { date: '', arr: {}, dep: {} };
  unit = unit || cfg.DEFAULT_UNIT || '';
  var date = Utilities.formatDate(new Date(), timeZone(cfg), 'yyyy-MM-dd');
  out.date = date;
  var hs = ss.getSheetByName(HISTORY_SHEET);
  if (hs) readHistory(hs).rows.forEach(function (r) {
    if (r.DATE !== date || !r.LANDED_AT || (r.UNIT && r.UNIT !== unit)) return;
    out.arr[String(r.FLIGHT).toUpperCase() + '|' + r.ETA_SCHEDULED] = r.LANDED_AT.slice(-5);
  });
  var ds = ss.getSheetByName(DEPARTURES_SHEET);
  if (ds) readTable(ds, DEPARTURES_HEAD).rows.forEach(function (r) {
    if (r.DATE !== date || !r.DEPARTED_AT || (r.UNIT && r.UNIT !== unit)) return;
    out.dep[String(r.FLIGHT).toUpperCase() + '|' + r.ETD_SCHEDULED] = { at: r.DEPARTED_AT.slice(-5), day: r.DEPARTED_AT.slice(0, 10), est: r.ESTIMATED === 'yes' };
  });
  cache.put(ck, JSON.stringify(out), TODAY_CACHE_SEC);
  return out;
}

/* ---------------- history: recording and callsign learning (time trigger) ---------------- */

function recordHistory() {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(20000)) return;
  try {
    var ss = sheetBook(), base = readRules(ss, '');
    if (!isTrue(base.HISTORY_ENABLED)) return;
    var sh = historySheet(ss), table = readHistory(sh), audit = [];
    var dsh = departuresSheet(ss), deps = readTable(dsh, DEPARTURES_HEAD);
    var list = units(ss, base);
    list.forEach(function (unit) { recordUnit(ss, unit, table, audit, deps); });
    writeHistory(sh, table, base);
    writeDepartures(dsh, deps, base);
    writeAudit(ss, audit, base);
    var c = CacheService.getScriptCache();
    c.remove('hist:stats:'); c.remove('today:');
    list.forEach(function (u) { c.remove('hist:stats:' + u); c.remove('today:' + u); });
  } finally {
    lock.releaseLock();
  }
}

function recordUnit(ss, unit, table, audit, deps) {
  var cfg = readRules(ss, unit), tab = readUnit(ss, unit);
  if (!tab) return;
  var tz = timeZone(cfg), now = new Date(), nowMin = minutesOfDay(now, tz);
  var today = Utilities.formatDate(now, tz, 'yyyy-MM-dd');
  var yesterday = Utilities.formatDate(new Date(now.getTime() - 86400000), tz, 'yyyy-MM-dd');
  var dowToday = parseInt(Utilities.formatDate(now, tz, 'u'), 10); // 1 = Monday ... 7 = Sunday
  var dowYesterday = dowToday === 1 ? 7 : dowToday - 1;
  var prefixes = readPrefixes(ss);
  var lat = parseFloat(cfg.AIRPORT_LAT), lon = parseFloat(cfg.AIRPORT_LON);
  if (!isFinite(lat) || !isFinite(lon)) return;

  // Rows of today and of yesterday (late arrivals after midnight), times relative to today's midnight.
  var cands = [];
  [[today, dowToday, 0], [yesterday, dowYesterday, -1440]].forEach(function (d) {
    tab.rows.forEach(function (f) {
      if (f.eta === null || f.days.indexOf(String(d[1])) < 0) return; // inactive or Days = 0: ignored
      var etaAbs = f.eta + d[2];
      if (nowMin < etaAbs - HISTORY_WATCH_BEFORE_MIN || nowMin > etaAbs + HISTORY_WATCH_AFTER_MIN) return;
      var arriving = f.flightIn || f.flight;
      var cs = unique(callsignCandidates(arriving, prefixes).concat(f.callsigns));
      // FLIGHT_IN unknown: number - 1 and + 1 are tried too; only an aircraft flying to the airport counts.
      if (!f.flightIn) neighbours(f.flight).forEach(function (x) { cs = unique(cs.concat(callsignCandidates(x, prefixes).slice(0, 1))); });
      cs.forEach(function (c) {
        cands.push({ unit: unit, date: d[0], si: f.si, row: f, flight: arriving, etaText: f.etaText, etaAbs: etaAbs, cs: c });
      });
    });
  });
  // Departures of today and of yesterday (ETD after midnight), watched from ETD - 60 to ETD + 240 min.
  var depCands = [];
  [[today, dowToday, 0], [yesterday, dowYesterday, -1440]].forEach(function (d) {
    tab.rows.forEach(function (f) {
      if (f.etd === null || f.days.indexOf(String(d[1])) < 0) return;
      var etdAbs = f.etd + (f.eta !== null && f.etd < f.eta ? 1440 : 0) + d[2];
      if (nowMin < etdAbs - DEP_WATCH_BEFORE_MIN || nowMin > etdAbs + DEP_WATCH_AFTER_MIN) return;
      var dep = f.flightOut || f.flight;
      callsignCandidates(dep, prefixes).forEach(function (c) {
        depCands.push({ unit: unit, date: d[0], flight: dep, etdText: f.etdText, etdAbs: etdAbs, cs: c });
      });
    });
  });
  if (!cands.length && !depCands.length) return;

  var fetched = fetchCallsigns(unique(cands.concat(depCands).map(function (c) { return c.cs; })), CacheService.getScriptCache(), false);
  if (deps) recordDepartures(depCands, fetched, deps, cfg, now, nowMin, tz, lat, lon);
  var radius = toNum(cfg.LANDED_RADIUS_NM, 5), margin = toNum(cfg.APPROACH_MARGIN_MIN, 5), minGs = toNum(cfg.MIN_GS_KT, 150);
  var outlier = toNum(cfg.HISTORY_OUTLIER_MAX_MIN, 360);
  var precision = toNum(PropertiesService.getScriptProperties().getProperty('TRIGGER_MIN'), Math.round(toNum(cfg.ADSB_REFRESH_SEC, 1200) / 60));
  var byCs = {}, learned = {};
  cands.forEach(function (c) { (byCs[c.cs] = byCs[c.cs] || []).push(c); });

  Object.keys(byCs).forEach(function (cs) {
    var acs = (fetched.cs[cs] || []).filter(function (a) { return typeof a.lat === 'number'; });
    if (!acs.length) return;
    var ac = acs.sort(function (a, b) { return (a.seen_pos || 0) - (b.seen_pos || 0); })[0];
    // Attach the observation to the row with the closest scheduled ETA; too close to call: ambiguous.
    var rows = byCs[cs].sort(function (a, b) { return Math.abs(a.etaAbs - nowMin) - Math.abs(b.etaAbs - nowMin); });
    if (rows.length > 1 && Math.abs(rows[1].etaAbs - nowMin) - Math.abs(rows[0].etaAbs - nowMin) < AMBIGUITY_MARGIN_MIN) {
      var note = 'ambiguous: ' + cs + ' matches SI ' + rows.map(function (x) { return x.si; }).join(', ') + ', no deviation recorded';
      rows.forEach(function (r) { upsert(table, r, { NOTE: note }); });
      return;
    }
    var r = rows[0], rec = table.byKey[key(r.unit, r.date, r.flight, r.etaText)];
    var obsMin = nowMin - (ac.seen_pos || 0) / 60;
    var stamp = Utilities.formatDate(new Date(now.getTime() - (ac.seen_pos || 0) * 1000), tz, 'yyyy-MM-dd HH:mm');
    var dist = haversineNm(ac.lat, ac.lon, lat, lon);
    if (ac.alt_baro === 'ground') {
      // Landing: on the ground near the airport after being seen in flight for this row.
      // The callsign must be the one seen in flight: the departing aircraft parked under another number is not a landing.
      if (dist <= radius && rec && rec.FIRST_SEEN_AT && !rec.LANDED_AT && (!rec.CALLSIGN || rec.CALLSIGN === cs)) {
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
    var upd = { LAST_SEEN_AT: stamp, CALLSIGN: cs };
    if (!rec || !rec.FIRST_SEEN_AT) {
      upd.FIRST_SEEN_AT = stamp;
      if (ac.gs >= minGs) upd.ETA_LIVE_AT_FIRST_SEEN = hhmm(obsMin + dist / ac.gs * 60 + margin);
    }
    upsert(table, r, upd);
    learned[r.row.sheetRow] = { row: r.row, cs: cs };
  });

  // Callsign learning: the callsign really seen for an arrival is kept in AUTO_CALLSIGN.
  var changes = [];
  Object.keys(learned).forEach(function (k) {
    var l = learned[k];
    if (l.row.auto.AUTO_CALLSIGN !== l.cs) changes.push({ row: l.row, values: { AUTO_CALLSIGN: l.cs } });
  });
  applyChanges(tab, changes, 'live tracking: callsign seen', audit, cfg);
}

// Take-off: seen on the ground at the airport then airborne, or first seen airborne flying away
// (take-off time then estimated from the distance flown at the current ground speed).
function recordDepartures(depCands, fetched, deps, cfg, now, nowMin, tz, lat, lon) {
  var radius = toNum(cfg.LANDED_RADIUS_NM, 5), byKey = {};
  deps.rows.forEach(function (r) { byKey[r.UNIT + '|' + r.DATE + '|' + r.FLIGHT + '|' + r.ETD_SCHEDULED] = r; });
  var done = {};
  depCands.forEach(function (c) {
    var k = c.unit + '|' + c.date + '|' + c.flight + '|' + c.etdText;
    if (done[k]) return;
    var acs = (fetched.cs[c.cs] || []).filter(function (a) { return typeof a.lat === 'number'; });
    if (!acs.length) return;
    var ac = acs.sort(function (a, b) { return (a.seen_pos || 0) - (b.seen_pos || 0); })[0];
    var rec = byKey[k];
    if (!rec) { rec = {}; DEPARTURES_HEAD.forEach(function (h) { rec[h] = ''; }); rec.DATE = c.date; rec.UNIT = c.unit; rec.FLIGHT = c.flight; rec.ETD_SCHEDULED = c.etdText; }
    var dist = haversineNm(ac.lat, ac.lon, lat, lon), seenMs = now.getTime() - (ac.seen_pos || 0) * 1000;
    var stamp = function (ms) { return Utilities.formatDate(new Date(ms), tz, 'yyyy-MM-dd HH:mm'); };
    if (ac.alt_baro === 'ground') {
      if (dist <= radius && !rec.DEPARTED_AT) { rec.GROUND_SEEN_AT = stamp(seenMs); rec.CALLSIGN = c.cs; }
    } else {
      var away = typeof ac.track !== 'number' || dist <= radius ||
        Math.abs(((ac.track - bearingDeg(lat, lon, ac.lat, ac.lon)) % 360 + 540) % 360 - 180) <= 100;
      if (!away) return; // still coming in: not this departure
      if (!rec.DEPARTED_AT) {
        var flownMin = dist > radius && ac.gs > 50 ? dist / ac.gs * 60 : 0;
        rec.DEPARTED_AT = stamp(seenMs - flownMin * 60000);
        rec.ESTIMATED = flownMin > 0 ? 'yes' : 'no';
      }
      rec.LAST_SEEN_AT = stamp(seenMs);
      rec.CALLSIGN = c.cs;
    }
    if (!byKey[k]) { byKey[k] = rec; deps.rows.push(rec); }
    done[k] = true;
  });
}

function departuresSheet(ss) {
  var sh = ss.getSheetByName(DEPARTURES_SHEET);
  if (!sh) {
    sh = ss.insertSheet(DEPARTURES_SHEET);
    sh.getRange(1, 1, 1, DEPARTURES_HEAD.length).setNumberFormat('@').setValues([DEPARTURES_HEAD]).setFontWeight('bold');
    sh.setFrozenRows(1);
  }
  return sh;
}
function readTable(sh, head) {
  var v = sh.getDataRange().getDisplayValues(), rows = [];
  v.slice(1).forEach(function (r) {
    if (!r[0]) return;
    var o = {};
    head.forEach(function (h, i) { o[h] = r[i] === undefined ? '' : String(r[i]); });
    rows.push(o);
  });
  return { rows: rows };
}
// Rewrites the tab, keeping the last 7 days.
function writeDepartures(sh, deps, cfg) {
  var cutoff = Utilities.formatDate(new Date(Date.now() - 7 * 86400000), timeZone(cfg), 'yyyy-MM-dd');
  var rows = deps.rows.filter(function (o) { return o.DATE >= cutoff; })
    .sort(function (a, b) { return (a.DATE + a.ETD_SCHEDULED).localeCompare(b.DATE + b.ETD_SCHEDULED); })
    .map(function (o) { return DEPARTURES_HEAD.map(function (h) { return o[h]; }); });
  var last = sh.getLastRow();
  if (last > 1) sh.getRange(2, 1, last - 1, DEPARTURES_HEAD.length).clearContent();
  if (rows.length) sh.getRange(2, 1, rows.length, DEPARTURES_HEAD.length).setNumberFormat('@').setValues(rows);
}

/* ---------------- schedules: AeroDataBox (menu and daily trigger only) ---------------- */

/** Menu "Ops On Time > Resolve flights": fills AUTO_* for every unit tab listed in UNITS. */
function resolveFlights() { return runResolve(null, 'menu', true); }
/** Menu "Ops On Time > Resolve this tab" */
function resolveActiveTab() {
  var sh = null;
  try { sh = SpreadsheetApp.getActiveSheet(); } catch (e) { sh = null; }
  return runResolve(sh ? sh.getName() : null, 'menu', true);
}
/** Daily trigger: rows still to resolve, and every row once a week (schedules change). */
function resolveDaily() {
  var cfg = readRules(sheetBook(), '');
  return runResolve(null, 'daily trigger', Utilities.formatDate(new Date(), timeZone(cfg), 'u') === '1');
}

function runResolve(onlyUnit, source, all) {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(30000)) return say('Another run is in progress, try again in a minute.');
  var report = [];
  try {
    var ss = sheetBook(), base = readRules(ss, ''), audit = [];
    var todo = onlyUnit ? [cleanUnit(onlyUnit)] : units(ss, base);
    todo.forEach(function (unit) {
      try { report.push(resolveUnit(ss, unit, source, all, audit)); }
      catch (err) { report.push(unit + ': ' + String(err.message || err)); }
    });
    writeAudit(ss, audit, base);
  } finally {
    lock.releaseLock();
  }
  return say(report.join('\n') || 'No unit tab to resolve (UNITS in RULES)');
}

function resolveUnit(ss, unit, source, all, audit) {
  var cfg = readRules(ss, unit), tab = readUnit(ss, unit);
  if (!tab) return unit + ': tab not found or no FLIGHT column';
  var airport = String(cfg.AIRPORT_ICAO || '').toUpperCase();
  if (!/^[A-Z]{4}$/.test(airport)) return unit + ': AIRPORT_ICAO missing in RULES_' + unit;
  var todo = tab.rows.filter(function (r) { return all || !r.auto.AUTO_STD || !r.auto.STATUS || /^unresolved$/i.test(r.auto.STATUS); });
  if (!todo.length) return unit + ': nothing to resolve';
  var tz = timeZone(cfg), look = Math.max(1, Math.min(7, toNum(cfg.SCHEDULE_LOOKAHEAD_DAYS, 7)));
  var dates = [];
  for (var i = -1; i < look; i++) dates.push(Utilities.formatDate(new Date(Date.now() + i * 86400000), tz, 'yyyy-MM-dd'));
  var sched = loadSchedule(ss, airport, dates);
  if (sched.error && !sched.any) return unit + ': ' + sched.error;
  var days = dates.slice(1), changes = [], resolved = 0, unresolved = 0;
  todo.forEach(function (r) {
    var res = resolveRow(r, sched, days, toNum(cfg.DAY_STOP_MIN_GROUND, 360));
    if (res.STATUS === 'Unresolved') unresolved++; else resolved++;
    var values = {};
    AUTO_COLS.forEach(function (c) { if (res[c] !== undefined && String(res[c]) !== String(r.auto[c] || '')) values[c] = res[c]; });
    if (Object.keys(values).length) changes.push({ row: r, values: values });
  });
  applyChanges(tab, changes, 'schedules (' + source + ')', audit, cfg);
  return unit + ': ' + resolved + ' resolved, ' + unresolved + ' unresolved' + (sched.error ? ' (' + sched.error + ')' : '');
}

// One row: departures of FLIGHT in the cached schedule, its inbound flight and arrival time.
function resolveRow(r, sched, days, dayStopMin) {
  var manual = !!(r.manual.ETA || r.manual.ETD);
  var n = normFlight(r.flight), out = { STATUS: manual ? 'Manual override' : 'Unresolved' };
  if (!n) return out;
  var deps = (sched.dep[n.norm] || sched.depCs[n.raw] || []).filter(function (x) { return days.indexOf(x.date) >= 0; });
  if (!deps.length) return out;
  var std = mode(deps.map(function (x) { return x.time; }));
  var depsT = deps.filter(function (x) { return x.time === std; });
  var stdM = t2m(std);
  out.AUTO_STD = std;
  out.AUTO_AIRLINE = mode(deps.map(function (x) { return x.airline; }).filter(String)) || '';
  out.AUTO_AIRCRAFT = mode(deps.map(function (x) { return x.aircraft; }).filter(String)) || '';
  // Arrival of a flight number before each departure: same day before STD, else the day before.
  var arrivalsFor = function (num) {
    return depsT.map(function (d) {
      var same = (sched.arr[num] || []).filter(function (a) { return a.date === d.date && t2m(a.time) < stdM; });
      var prev = (sched.arr[num] || []).filter(function (a) { return a.date === prevDate(d.date); });
      var a = same.length ? same[same.length - 1] : prev.length ? prev[prev.length - 1] : null;
      return a ? { dep: d, arr: a, prevDay: !same.length } : null;
    }).filter(Boolean);
  };
  // Inbound flight: FLIGHT_IN typed by hand, else the same aircraft (registration), else number - 1, + 1 or same.
  var inNum = r.manual.FLIGHT_IN ? (normFlight(r.manual.FLIGHT_IN) || {}).norm : null;
  if (!inNum) {
    var byReg = [];
    depsT.forEach(function (d) {
      if (!d.reg) return;
      var hits = sched.arrAll.filter(function (a) { return a.reg === d.reg && ((a.date === d.date && t2m(a.time) < stdM) || a.date === prevDate(d.date)); })
        .sort(function (a, b) { return (a.date + a.time).localeCompare(b.date + b.time); });
      if (hits.length) byReg.push(hits[hits.length - 1].number);
    });
    if (byReg.length) inNum = mode(byReg);
  }
  if (!inNum) {
    var k0 = parseInt(n.number, 10);
    [k0 - 1, k0 + 1, k0].some(function (k) {
      if (k <= 0) return false;
      var cand = n.prefix + k + n.suffix, hits = arrivalsFor(cand);
      if (hits.length && hits.length * 2 >= depsT.length) { inNum = cand; return true; }
      return false;
    });
  }
  var pairs = inNum ? arrivalsFor(inNum) : [];
  var operating = depsT.map(function (d) { return d.date; });
  if (pairs.length) {
    out.AUTO_FLIGHT_IN = inNum === n.norm ? '' : inNum;
    var sta = mode(pairs.map(function (p) { return p.arr.time; }));
    var prevDay = pairs.filter(function (p) { return p.prevDay; }).length * 2 > pairs.length;
    out.AUTO_CALLSIGN = mode(pairs.map(function (p) { return p.arr.callsign; }).filter(String)) || '';
    out.AUTO_ORIGIN = mode(pairs.map(function (p) { return p.arr.origin; }).filter(String)) || '';
    if (!prevDay) out.AUTO_STA = sta;
    else if (1440 + stdM - t2m(sta) < dayStopMin) {
      // Quick turn across midnight: the operating day is the arrival day, ETD on the next day.
      out.AUTO_STA = sta;
      operating = operating.map(prevDate);
    } else out.AUTO_STA = 'D-1 ' + sta; // arrives the day before: day stop, no ETA on the day
  } else {
    out.AUTO_FLIGHT_IN = '';
    out.AUTO_STA = '';
    out.AUTO_CALLSIGN = mode(depsT.map(function (d) { return d.callsign; }).filter(String)) || '';
  }
  out.AUTO_DAYS = unique(operating.map(weekday)).sort().join('');
  out.STATUS = manual ? 'Manual override' : 'Resolved';
  return out;
}

// Departures and arrivals of an airport for the given dates, from the ScheduleCache tab;
// missing 12 h windows are fetched once (AeroDataBox) and stored.
function loadSchedule(ss, airport, dates) {
  var sh = scheduleSheet(ss), v = sh.getDataRange().getDisplayValues(), rows = [], have = {}, error = '', purged = false;
  v.slice(1).forEach(function (r) {
    if (!r[0]) return;
    var o = {};
    SCHEDULE_HEAD.forEach(function (h, i) { o[h] = String(r[i] === undefined ? '' : r[i]); });
    if (o.AIRPORT === airport && o.DATE < dates[0]) { purged = true; return; } // purge old days
    if (o.AIRPORT === airport && o.DIR === 'WINDOW') have[o.DATE + '|' + o.NUMBER] = true;
    rows.push(o);
  });
  var fetchedNow = 0;
  dates.forEach(function (d) {
    ['00', '12'].forEach(function (half) {
      if (have[d + '|' + half] || error) return;
      var res = adbFetch(airport, d, half);
      if (res.error) { error = res.error; return; }
      fetchedNow++;
      var at = Utilities.formatDate(new Date(), 'UTC', 'yyyy-MM-dd HH:mm');
      res.items.forEach(function (it) { it.AIRPORT = airport; it.FETCHED_AT = at; rows.push(it); });
      rows.push({ AIRPORT: airport, DATE: d, DIR: 'WINDOW', NUMBER: half, STATUS: String(res.items.length), FETCHED_AT: at });
    });
  });
  if (fetchedNow || purged) {
    var data = rows.map(function (o) { return SCHEDULE_HEAD.map(function (h) { return o[h] === undefined ? '' : String(o[h]); }); });
    var last = sh.getLastRow();
    if (last > 1) sh.getRange(2, 1, last - 1, SCHEDULE_HEAD.length).clearContent();
    if (data.length) sh.getRange(2, 1, data.length, SCHEDULE_HEAD.length).setNumberFormat('@').setValues(data);
  }
  var out = { dep: {}, depCs: {}, arr: {}, arrAll: [], error: error, any: false };
  rows.forEach(function (o) {
    if (o.AIRPORT !== airport || o.DIR === 'WINDOW' || /cancel/i.test(o.STATUS || '')) return;
    out.any = true;
    var it = { date: o.DATE, time: o.TIME, number: o.NUMBER, callsign: o.CALLSIGN || '', aircraft: o.AIRCRAFT || '', reg: o.REG || '', airline: o.AIRLINE || '', origin: o.ORIGIN || '' };
    if (o.DIR === 'DEP') {
      (out.dep[o.NUMBER] = out.dep[o.NUMBER] || []).push(it);
      if (o.CALLSIGN) (out.depCs[o.CALLSIGN] = out.depCs[o.CALLSIGN] || []).push(it);
    } else { (out.arr[o.NUMBER] = out.arr[o.NUMBER] || []).push(it); out.arrAll.push(it); }
  });
  Object.keys(out.arr).forEach(function (k) { out.arr[k].sort(function (a, b) { return (a.date + a.time).localeCompare(b.date + b.time); }); });
  return out;
}

// One 12 h window of departures and arrivals. Returns { items } or { error }.
function adbFetch(airport, date, half) {
  var props = PropertiesService.getScriptProperties();
  var apiKey = props.getProperty('AERODATABOX_KEY');
  if (!apiKey) return { error: 'AERODATABOX_KEY is not set in the script properties' };
  var month = Utilities.formatDate(new Date(), 'UTC', 'yyyy-MM'), used = toNum(props.getProperty('ADB_CALLS_' + month), 0);
  var max = toNum(props.getProperty('ADB_MAX_CALLS_MONTH'), 300);
  if (used >= max) return { error: 'monthly limit of ' + max + ' schedule calls reached (ADB_MAX_CALLS_MONTH)' };
  var host = props.getProperty('AERODATABOX_HOST') || 'aerodatabox.p.rapidapi.com';
  var from = date + 'T' + (half === '00' ? '00:00' : '12:00'), to = date + 'T' + (half === '00' ? '11:59' : '23:59');
  var url = 'https://' + host + '/flights/airports/icao/' + airport + '/' + from + '/' + to +
    '?withLeg=true&direction=Both&withCancelled=true&withCodeshared=false&withCargo=false&withPrivate=false&withLocation=false';
  var res = UrlFetchApp.fetch(url, { headers: { 'X-RapidAPI-Key': apiKey, 'X-RapidAPI-Host': host }, muteHttpExceptions: true });
  props.setProperty('ADB_CALLS_' + month, String(used + 1));
  var code = res.getResponseCode();
  if (code === 204) return { items: [] };
  if (code !== 200) return { error: 'schedule API answered ' + code + (code === 401 || code === 403 ? ' (check the key and the subscription)' : code === 429 ? ' (quota)' : '') };
  var json = JSON.parse(res.getContentText()), items = [];
  [['departures', 'DEP', 'departure'], ['arrivals', 'ARR', 'arrival']].forEach(function (k) {
    (json[k[0]] || []).forEach(function (x) {
      var leg = x[k[2]] || x.movement || {}, st = leg.scheduledTime || {};
      var local = String(st.local || leg.scheduledTimeLocal || '');
      var m = /(\d{4}-\d{2}-\d{2})[ T](\d{2}):(\d{2})/.exec(local), n = normFlight(x.number);
      if (!m || !n) return;
      items.push({ DATE: m[1], DIR: k[1], NUMBER: n.norm, TIME: m[2] + ':' + m[3], CALLSIGN: String(x.callSign || '').replace(/\s+/g, '').toUpperCase(),
        AIRCRAFT: String((x.aircraft && x.aircraft.model) || ''), REG: String((x.aircraft && x.aircraft.reg) || '').toUpperCase(),
        AIRLINE: String((x.airline && x.airline.name) || ''), STATUS: String(x.status || ''),
        // arrivals: airport the flight comes from (departure leg, or the movement's other airport)
        ORIGIN: k[1] === 'ARR' ? String(((x.departure && x.departure.airport) || (x.movement && x.movement.airport) || {}).icao || '').toUpperCase() : '' });
    });
  });
  return { items: items };
}

/* ---------------- menu and triggers ---------------- */

function onOpen() {
  SpreadsheetApp.getUi().createMenu('Ops On Time')
    .addItem('Resolve flights', 'resolveFlights')
    .addItem('Resolve this tab', 'resolveActiveTab')
    .addSeparator()
    .addItem('Install triggers', 'installTriggers')
    .addItem('Check setup', 'checkSetup')
    .addToUi();
}

/** Run once (menu or editor): history every 5 to 30 min, schedules every night. */
function installTriggers() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (['recordHistory', 'resolveDaily'].indexOf(t.getHandlerFunction()) >= 0) ScriptApp.deleteTrigger(t);
  });
  var ss = sheetBook(), cfg = readRules(ss, '');
  var refreshMin = Math.round(toNum(cfg.ADSB_REFRESH_SEC, 1200) / 60), n = 5;
  [5, 10, 15, 30].forEach(function (a) { if (a <= refreshMin) n = a; }); // allowed trigger intervals
  ScriptApp.newTrigger('recordHistory').timeBased().everyMinutes(n).create();
  ScriptApp.newTrigger('resolveDaily').timeBased().everyDays(1).atHour(2).create();
  PropertiesService.getScriptProperties().setProperty('TRIGGER_MIN', String(n));
  historySheet(ss); scheduleSheet(ss); auditSheet(ss); departuresSheet(ss);
  return say('History every ' + n + ' min, schedules every night at about 02:00. ' + (tzWarning(cfg) || 'Time zone OK: ' + timeZone(cfg)));
}
/** Kept for older instructions. */
function installTrigger() { return installTriggers(); }

function checkSetup() {
  var ss = sheetBook(), cfg = readRules(ss, ''), props = PropertiesService.getScriptProperties(), lines = [];
  lines.push('Sheet: ' + ss.getName());
  lines.push('Units: ' + units(ss, cfg).map(function (u) { return u + (readUnit(ss, u) ? '' : ' (tab missing)'); }).join(', '));
  lines.push('Schedule API key: ' + (props.getProperty('AERODATABOX_KEY') ? 'set' : 'MISSING (Project Settings > Script properties > AERODATABOX_KEY)'));
  lines.push('Schedule calls this month: ' + (props.getProperty('ADB_CALLS_' + Utilities.formatDate(new Date(), 'UTC', 'yyyy-MM')) || 0) + ' / ' + toNum(props.getProperty('ADB_MAX_CALLS_MONTH'), 300));
  lines.push('Triggers: ' + (ScriptApp.getProjectTriggers().map(function (t) { return t.getHandlerFunction(); }).join(', ') || 'none (run Install triggers)'));
  lines.push(tzWarning(cfg) || 'Time zone OK: ' + timeZone(cfg));
  return say(lines.join('\n'));
}

function say(msg) {
  Logger.log(msg);
  try { SpreadsheetApp.getUi().alert(msg); } catch (e) { /* trigger or web app: no UI */ }
  return msg;
}

/* ---------------- Sheet access ---------------- */

function sheetBook() {
  var ss = null;
  try { ss = SpreadsheetApp.getActiveSpreadsheet(); } catch (e) { ss = null; }
  if (ss) return ss;
  var id = PropertiesService.getScriptProperties().getProperty('SHEET_ID');
  if (!id) throw new Error('Bind the script to the Sheet (Extensions > Apps Script) or set the SHEET_ID script property');
  return SpreadsheetApp.openById(id);
}

function readKv(sh) {
  var cfg = {};
  if (!sh) return cfg;
  var v = sh.getDataRange().getDisplayValues(), hi = -1;
  v.some(function (r, i) { if (r.map(norm).indexOf('KEY') >= 0) { hi = i; return true; } return false; });
  if (hi < 0) return cfg;
  var h = v[hi].map(norm), ik = h.indexOf('KEY'), iv = h.indexOf('VALUE');
  v.slice(hi + 1).forEach(function (r) { if (r[ik]) cfg[String(r[ik]).trim().toUpperCase()] = String(r[iv]).trim(); });
  return cfg;
}

// RULES (or the older Config tab), then RULES_<UNIT> on top.
function readRules(ss, unit) {
  var cache = CacheService.getScriptCache(), ck = 'cfg:' + (unit || ''), hit = cache.get(ck);
  if (hit) return JSON.parse(hit);
  var cfg = readKv(ss.getSheetByName('RULES') || ss.getSheetByName('Config'));
  if (unit) { var u = readKv(ss.getSheetByName('RULES_' + unit)); Object.keys(u).forEach(function (k) { cfg[k] = u[k]; }); }
  cache.put(ck, JSON.stringify(cfg), 300);
  return cfg;
}

function units(ss, cfg) {
  return unique(String(cfg.UNITS || cfg.DEFAULT_UNIT || '').split(/[,;\s]+/).map(cleanUnit).filter(String));
}

function readPrefixes(ss) {
  var m = {}, sh = ss.getSheetByName('Airlines');
  if (!sh) return m;
  var v = sh.getDataRange().getDisplayValues(), h = v[0].map(norm);
  var ia = h.indexOf('IATA'), ii = h.indexOf('ICAO');
  v.slice(1).forEach(function (r) {
    var a = String(r[ia] || '').trim().toUpperCase(), i = String(r[ii] || '').trim().toUpperCase();
    if (a && i && !m[a]) m[a] = i;
  });
  return m;
}

var ALIASES = { FLIGHT: ['FLIGHT', 'FLIGHT_NO', 'FLIGHT_NUMBER'], ETA: ['ETA', 'STA'], ETD: ['ETD', 'STD'] };
function canon(k) { for (var c in ALIASES) if (ALIASES[c].indexOf(k) >= 0) return c; return k; }

// Unit tab read by header name. Effective values: manual first, then AUTO_*.
function readUnit(ss, unit) {
  var sh = unit ? ss.getSheetByName(unit) : null;
  if (!sh) return null;
  var v = sh.getDataRange().getDisplayValues(), hi = -1;
  v.some(function (r, i) { if (r.map(norm).map(canon).indexOf('FLIGHT') >= 0) { hi = i; return true; } return false; });
  if (hi < 0) return null;
  var head = v[hi].map(norm).map(canon), col = {};
  head.forEach(function (h, i) { if (h && col[h] === undefined) col[h] = i; });
  var get = function (r, k) { return col[k] === undefined ? '' : String(r[col[k]] === undefined ? '' : r[col[k]]).trim(); };
  var rows = [];
  v.slice(hi + 1).forEach(function (r, i) {
    var flight = get(r, 'FLIGHT').toUpperCase().replace(/\s+/g, '');
    if (!flight) return;
    var auto = {};
    AUTO_COLS.forEach(function (c) { auto[c] = get(r, c); });
    var manual = { ETA: t2m(get(r, 'ETA')) !== null ? get(r, 'ETA') : '', ETD: t2m(get(r, 'ETD')) !== null ? get(r, 'ETD') : '', FLIGHT_IN: get(r, 'FLIGHT_IN').toUpperCase(), DAYS: get(r, 'DAYS') };
    var etaText = manual.ETA || (t2m(auto.AUTO_STA) !== null ? auto.AUTO_STA : '');
    var etdText = manual.ETD || (t2m(auto.AUTO_STD) !== null ? auto.AUTO_STD : '');
    var dRaw = (manual.DAYS || auto.AUTO_DAYS).replace(/\s/g, '');
    var active = get(r, 'ACTIVE').toUpperCase();
    var days = /^(NO|FALSE|0)$/.test(active) ? '' : dRaw.toLowerCase() === 'daily' ? '1234567' : dRaw === '0' ? '' : dRaw;
    var siRaw = get(r, 'SI');
    rows.push({
      sheetRow: hi + 2 + i, si: /^\d+$/.test(siRaw) ? parseInt(siRaw, 10) : null, flight: flight,
      flightIn: (manual.FLIGHT_IN || auto.AUTO_FLIGHT_IN).toUpperCase(), etaText: etaText, eta: t2m(etaText), days: days,
      etdText: etdText, etd: t2m(etdText), flightOut: get(r, 'FLIGHT_OUT').toUpperCase().replace(/\s+/g, ''),
      callsigns: [get(r, 'CALLSIGN'), auto.AUTO_CALLSIGN].map(function (c) { return String(c).toUpperCase().replace(/\s+/g, ''); }).filter(function (c) { return /^[A-Z0-9]{3,8}$/.test(c); }),
      auto: auto, manual: manual,
    });
  });
  return { sheet: sh, unit: unit, headerRow: hi + 1, col: col, head: head, rows: rows };
}

// Adds the missing columns at the end of the header row (a pasted tab may only have FLIGHT).
function ensureColumns(tab, names) {
  var next = tab.head.length;
  names.forEach(function (n) {
    if (tab.col[n] !== undefined) return;
    tab.sheet.getRange(tab.headerRow, next + 1, 1, 1).setNumberFormat('@').setValues([[n]]);
    tab.col[n] = next; tab.head.push(n); next++;
  });
}

// Writes changed cells (text format) and logs each change in the Audit list.
function applyChanges(tab, changes, source, audit, cfg) {
  if (!changes.length) return;
  var cols = {};
  changes.forEach(function (c) { Object.keys(c.values).forEach(function (k) { cols[k] = 1; }); });
  ensureColumns(tab, AUTO_COLS.filter(function (k) { return cols[k]; }));
  var stamp = Utilities.formatDate(new Date(), timeZone(cfg), 'yyyy-MM-dd HH:mm');
  changes.forEach(function (c) {
    Object.keys(c.values).forEach(function (k) {
      var old = c.row.auto[k] || '', val = String(c.values[k]);
      tab.sheet.getRange(c.row.sheetRow, tab.col[k] + 1, 1, 1).setNumberFormat('@').setValues([[val]]);
      c.row.auto[k] = val;
      audit.push([stamp, source, tab.unit + ' row ' + c.row.sheetRow + ' ' + c.row.flight + ' ' + k, old, val]);
    });
  });
}

function auditSheet(ss) {
  var sh = ss.getSheetByName(AUDIT_SHEET);
  if (!sh) { sh = ss.insertSheet(AUDIT_SHEET); sh.getRange(1, 1, 1, AUDIT_HEAD.length).setValues([AUDIT_HEAD]).setFontWeight('bold'); }
  return sh;
}
function writeAudit(ss, rows) {
  if (!rows.length) return;
  var sh = auditSheet(ss), start = Math.max(1, sh.getLastRow()) + 1;
  sh.getRange(start, 1, rows.length, AUDIT_HEAD.length).setNumberFormat('@').setValues(rows);
}

function scheduleSheet(ss) {
  var sh = ss.getSheetByName(SCHEDULE_SHEET);
  if (!sh) {
    sh = ss.insertSheet(SCHEDULE_SHEET);
    sh.getRange(1, 1, 1, SCHEDULE_HEAD.length).setNumberFormat('@').setValues([SCHEDULE_HEAD]).setFontWeight('bold');
    sh.setFrozenRows(1);
  }
  return sh;
}

function historySheet(ss) {
  var sh = ss.getSheetByName(HISTORY_SHEET);
  if (!sh) {
    sh = ss.insertSheet(HISTORY_SHEET);
    sh.getRange(1, 1, sh.getMaxRows(), HISTORY_HEAD.length).setNumberFormat('@'); // keep dates and times as text
    sh.setFrozenRows(1);
  }
  sh.getRange(1, 1, 1, HISTORY_HEAD.length).setValues([HISTORY_HEAD]).setFontWeight('bold');
  return sh;
}

function readHistory(sh) {
  var v = sh.getDataRange().getDisplayValues(), rows = [], byKey = {};
  v.slice(1).forEach(function (r) {
    if (!r[0]) return;
    var o = {};
    HISTORY_HEAD.forEach(function (h, i) { o[h] = r[i] === undefined ? '' : String(r[i]); });
    rows.push(o);
    byKey[key(o.UNIT, o.DATE, o.FLIGHT, o.ETA_SCHEDULED)] = o;
  });
  return { rows: rows, byKey: byKey };
}

function key(unit, date, flight, eta) { return (unit || '') + '|' + date + '|' + String(flight).toUpperCase() + '|' + eta; }

// Upsert on UNIT + DATE + FLIGHT + ETA_SCHEDULED: one row per scheduled arrival, never duplicated.
function upsert(table, r, fields) {
  var k = key(r.unit, r.date, r.flight, r.etaText), o = table.byKey[k];
  if (!o) {
    o = {};
    HISTORY_HEAD.forEach(function (h) { o[h] = ''; });
    o.DATE = r.date; o.FLIGHT = r.flight; o.ETA_SCHEDULED = r.etaText; o.UNIT = r.unit || '';
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

function norm(h) { return String(h || '').trim().toUpperCase().replace(/[\s/.-]+/g, '_').replace(/^_|_$/g, ''); }
function cleanUnit(u) { var s = String(u || '').trim().toUpperCase(); return /^[A-Z0-9_]{1,40}$/.test(s) ? s : ''; }
function timeZone(cfg) { return cfg.TIMEZONE || Session.getScriptTimeZone(); }
function tzWarning(cfg) {
  var tz = Session.getScriptTimeZone();
  return cfg.TIMEZONE && cfg.TIMEZONE !== tz
    ? 'Project time zone ' + tz + ' differs from RULES TIMEZONE ' + cfg.TIMEZONE + ': set it in Project Settings' : '';
}
function minutesOfDay(d, tz) { return parseInt(Utilities.formatDate(d, tz, 'H'), 10) * 60 + parseInt(Utilities.formatDate(d, tz, 'm'), 10) + d.getSeconds() / 60; }
function t2m(t) { var m = /^(\d{1,2}):(\d{2})(?::\d{2})?$/.exec(String(t || '').trim()); return m && +m[1] < 24 && +m[2] < 60 ? parseInt(m[1], 10) * 60 + parseInt(m[2], 10) : null; }
function hhmm(m) { m = ((Math.round(m) % 1440) + 1440) % 1440; return ('0' + Math.floor(m / 60)).slice(-2) + ':' + ('0' + (m % 60)).slice(-2); }
function isTrue(v) { return String(v).trim().toUpperCase() === 'TRUE'; }
function toNum(v, d) { var n = parseFloat(v); return isFinite(n) ? n : d; }
function unique(a) { return a.filter(function (x, i) { return a.indexOf(x) === i; }); }
function mode(a) {
  var c = {}, best = null;
  a.forEach(function (x) { c[x] = (c[x] || 0) + 1; if (best === null || c[x] > c[best]) best = x; });
  return best;
}
function prevDate(d) { var t = new Date(d + 'T12:00:00Z'); t.setUTCDate(t.getUTCDate() - 1); return t.toISOString().slice(0, 10); }
function weekday(d) { var w = new Date(d + 'T12:00:00Z').getUTCDay(); return String(w === 0 ? 7 : w); }
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
// Same rule as the dashboard (js/rules.js): uppercase, no spaces, no leading zeros; IATA or ICAO prefix.
function normFlight(s) {
  var code = String(s || '').replace(/[\s-]+/g, '').toUpperCase(), kind = 'ICAO';
  var m = /^([A-Z]{3})(\d{1,5})([A-Z]?)$/.exec(code);
  if (!m) { m = /^([A-Z0-9]{2})(\d{1,5})([A-Z]?)$/.exec(code); kind = 'IATA'; }
  if (!m || (kind === 'IATA' && /^\d\d$/.test(m[1]))) return null;
  var number = String(parseInt(m[2], 10));
  return { norm: m[1] + number + m[3], prefix: m[1], number: number, suffix: m[3], kind: kind, raw: code };
}
function neighbours(flight) {
  var n = normFlight(flight);
  if (!n) return [];
  var k = parseInt(n.number, 10);
  return [k - 1, k + 1].filter(function (x) { return x > 0; }).map(function (x) { return n.prefix + x + n.suffix; });
}
function callsignCandidates(flight, prefixes) {
  var n = normFlight(flight);
  if (!n) return [];
  var icao = n.kind === 'ICAO' ? n.prefix : prefixes[n.prefix];
  if (!icao) return [];
  var digits = n.raw.slice(n.prefix.length).replace(/[A-Z]$/, '');
  var a = icao + n.number + n.suffix, b = icao + digits + n.suffix;
  return a === b ? [a] : [a, b];
}
function list(s) {
  return unique(String(s || '').split(',').map(function (x) { return x.trim().toUpperCase(); })
    .filter(function (x) { return /^[A-Z0-9]{2,8}$/.test(x); })).slice(0, MAX_CS);
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
