/**
 * ANGA live tracking relay (Google Apps Script web app, free).
 *
 * The browser cannot call the tracking API directly (CORS). This script calls it from Google's
 * servers, keeps each answer in cache for CACHE_SEC seconds so that every screen shares the same
 * request, and returns only the fields the dashboard needs.
 *
 * GET <web app url>?cs=CALLSIGN1,CALLSIGN2&lat=..&lon=..&r=40&route=CALLSIGN1,CALLSIGN2
 *   cs    callsigns to look up worldwide (max 30)
 *   lat, lon, r  optional point query around the airport (r in nm, max 250)
 *   route optional callsigns whose route should be checked (max 30)
 *
 * No secret here: the tracking API needs no key today. If a key is required later, store it in
 * Project Settings > Script Properties (never in this file) and read it with
 * PropertiesService.getScriptProperties().getProperty('API_KEY').
 */
var API = 'https://api.adsb.lol';
var CACHE_SEC = 55;
var ROUTE_CACHE_SEC = 3600;
var MAX_CS = 30;
var FIELDS = ['hex', 'flight', 'r', 't', 'lat', 'lon', 'gs', 'track', 'alt_baro', 'baro_rate', 'seen_pos'];

function doGet(e) {
  var p = (e && e.parameter) || {};
  var out = { now: Date.now(), cs: {}, point: null, routes: {}, errors: [] };
  try {
    var cache = CacheService.getScriptCache();
    var callsigns = list(p.cs);
    var requests = [], keys = [];

    callsigns.forEach(function (cs) {
      var hit = cache.get('cs:' + cs);
      if (hit) out.cs[cs] = JSON.parse(hit);
      else { keys.push({ kind: 'cs', id: cs }); requests.push({ url: API + '/v2/callsign/' + cs, muteHttpExceptions: true }); }
    });

    var lat = num(p.lat, -90, 90), lon = num(p.lon, -180, 180), r = num(p.r, 1, 250);
    if (lat !== null && lon !== null && r !== null) {
      var pkey = 'pt:' + lat.toFixed(3) + ',' + lon.toFixed(3) + ',' + Math.round(r);
      var phit = cache.get(pkey);
      if (phit) out.point = JSON.parse(phit);
      else { keys.push({ kind: 'pt', id: pkey }); requests.push({ url: API + '/v2/point/' + lat + '/' + lon + '/' + Math.round(r), muteHttpExceptions: true }); }
    }

    if (requests.length) {
      var responses = UrlFetchApp.fetchAll(requests);
      responses.forEach(function (res, i) {
        var k = keys[i], code = res.getResponseCode();
        if (code !== 200) { out.errors.push({ id: k.id, status: code }); return; }
        var ac = slim(JSON.parse(res.getContentText()).ac || []);
        if (k.kind === 'cs') { out.cs[k.id] = ac; cache.put('cs:' + k.id, JSON.stringify(ac), CACHE_SEC); }
        else { out.point = ac; cache.put(k.id, JSON.stringify(ac), CACHE_SEC); }
      });
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
  return ContentService.createTextOutput(JSON.stringify(out)).setMimeType(ContentService.MimeType.JSON);
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
