/*
 * ANGA live tracking runtime (behind the LIVE_ADSB feature flag).
 * Polls the Apps Script relay (never the tracking API directly), keeps one shared state for every
 * view, applies estimates only when they move by RECALC_THRESHOLD_MIN, logs every recalculation,
 * and falls back to scheduled times when the relay does not answer.
 */
(function (root) {
  const C = root.AngaLiveCore;
  const STATE_KEY = 'anga_live_state';
  const LOG_KEY = 'anga_live_log';
  const LOG_MAX = 300;
  const POINT_RADIUS_NM = 40;    // point query around the airport: landing and departure detection
  const GROUND_NM = 5;           // on ground within this distance = at the airport
  const FINAL_NM = 30;           // confidence label "final"
  const APPROACH_NM = 150;       // confidence label "approach", beyond: "far"
  const DEP_WATCH_BEFORE = 60;   // watch for the departure from ETD - 60 min
  const DEP_WATCH_AFTER = 240;   // until ETD + 240 min
  const D1_GAP_FLAG_MIN = 30;    // D-1 Box Time slots are never moved, a gap this large is flagged

  let data, cfg, listeners = [], timer = null, failures = 0;
  let status = { state: 'off', at: null, error: null };
  let lastPayload = null, diag = { rows: [], near: [], at: null };
  let state = loadJSON(STATE_KEY, null);
  let log = loadJSON(LOG_KEY, []);

  function loadJSON(k, d) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch (e) { return d; } }
  function saveJSON(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* quota */ } }

  function todayKey(d) { return d.getFullYear() + '-' + (d.getMonth() + 1) + '-' + d.getDate(); }
  function nowMins(d) { return d.getHours() * 60 + d.getMinutes() + d.getSeconds() / 60; }
  const DOW = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'];

  function settings() {
    const g = (k, d) => data.setting(k, d);
    return {
      relay: String(g('LIVE_RELAY_URL', '')).trim(),
      lat: g('AIRPORT_LAT', NaN), lon: g('AIRPORT_LON', NaN), airportIcao: String(g('AIRPORT_ICAO', '')).toUpperCase(),
      refreshSec: Math.max(30, g('ADSB_REFRESH_SEC', 60)),
      before: g('ADSB_WINDOW_BEFORE_MIN', 60), after: g('ADSB_WINDOW_AFTER_MIN', 240),
      approachMarginMin: g('APPROACH_MARGIN_MIN', 5), minGsKt: g('MIN_GS_KT', 150), maxPosAgeSec: g('MAX_POSITION_AGE_SEC', 120),
      minRotationMin: g('MIN_ROTATION_MIN', 60), dayStopMinGround: g('DAY_STOP_MIN_GROUND', 360),
      threshold: g('RECALC_THRESHOLD_MIN', 5), tight: g('TIGHT_SLOT_MIN', 30),
      groundNm: GROUND_NM, finalNm: FINAL_NM, approachNm: APPROACH_NM,
    };
  }

  function ensureState(day) {
    if (!state || state.day !== day) state = { day, flights: {} };
    return state;
  }
  function fs(id) { return state.flights[id] || (state.flights[id] = {}); }

  function addLog(entry) {
    log.unshift(Object.assign({ at: new Date().toISOString() }, entry));
    if (log.length > LOG_MAX) log.length = LOG_MAX;
    saveJSON(LOG_KEY, log);
  }

  function notify() { listeners.forEach(cb => { try { cb(); } catch (e) { console.error(e); } }); }

  function todaysFlights(now) {
    const dow = DOW[now.getDay()];
    return data.get().flights.filter(f => f.days.includes(dow));
  }

  function pickAircraft(lists) {
    const all = [].concat(...lists.filter(Boolean));
    if (!all.length) return null;
    return all.slice().sort((a, b) => (a.seen_pos ?? 999) - (b.seen_pos ?? 999))[0];
  }

  function routeStatus(item, icao) {
    if (!item) return 'unknown';
    const txt = JSON.stringify(item).toUpperCase();
    if (icao && txt.includes(icao)) return 'ok';
    return /[A-Z]{4}-[A-Z]{4}/.test(txt) ? 'mismatch' : 'unknown';
  }

  async function tick() {
    const p = settings();
    if (!p.relay) { status = { state: 'not-configured', at: null, error: 'LIVE_RELAY_URL is empty' }; notify(); return schedule(p.refreshSec); }
    const now = new Date(), nm = nowMins(now), day = todayKey(now);
    ensureState(day);
    const prefixes = data.icaoPrefixes();
    const flights = todaysFlights(now);

    // Inbound flights whose scheduled ETA is in [now - before, now + after], not landed yet.
    const inbound = flights.filter(f => {
      const s = C.schedule(f);
      return s.eta !== null && s.eta >= nm - p.before && s.eta <= nm + p.after && !fs(f.id).landedAt;
    });
    const csMap = {};
    // The arriving aircraft flies under FLIGHT_IN when set; Flight is the departing flight number.
    inbound.forEach(f => { csMap[f.id] = C.callsignCandidates(f.flightIn || f.flight, prefixes); });
    const cs = [...new Set(Object.values(csMap).flat())].slice(0, 30);
    const routeAsk = inbound.map(f => fs(f.id).callsign).filter(Boolean).filter(c => !(lastPayload && lastPayload.routes && lastPayload.routes[c]));

    const qs = new URLSearchParams({ cs: cs.join(','), route: [...new Set(routeAsk)].join(',') });
    if (Number.isFinite(p.lat) && Number.isFinite(p.lon)) { qs.set('lat', p.lat); qs.set('lon', p.lon); qs.set('r', POINT_RADIUS_NM); }

    let payload;
    try {
      const r = await fetch(p.relay + (p.relay.includes('?') ? '&' : '?') + qs.toString());
      if (!r.ok) throw new Error('HTTP ' + r.status);
      payload = await r.json();
      const upstream = (payload.errors || []).filter(e => e.status === 429 || (e.status >= 500));
      if (upstream.length) throw new Error('tracking API ' + upstream.map(e => e.status).join(','));
    } catch (e) {
      failures++;
      status = { state: 'fallback', at: status.at, error: String(e.message || e) };
      notify();
      return schedule(Math.min(p.refreshSec * 2 ** failures, Math.max(900, p.refreshSec * 4))); // exponential backoff
    }
    failures = 0;
    lastPayload = Object.assign({}, payload, { routes: Object.assign({}, lastPayload && lastPayload.routes, payload.routes) });
    process(payload, p, now, nm, flights, inbound, csMap);
    status = { state: 'ok', at: Date.now(), error: null };
    saveJSON(STATE_KEY, state);
    notify();
    return schedule(p.refreshSec);
  }

  function process(payload, p, now, nm, flights, inbound, csMap) {
    const point = payload.point || [];
    const routes = lastPayload.routes || {};
    const rows = [];

    inbound.forEach(f => {
      const st = fs(f.id), cands = csMap[f.id];
      const found = cands.filter(c => (payload.cs[c] || []).length || point.some(a => C.cleanCallsign(a.flight) === c));
      const ac = pickAircraft(cands.map(c => (payload.cs[c] || []).concat(point.filter(a => C.cleanCallsign(a.flight) === c))));
      const row = { flight: f.flightIn ? f.flight + ' (arrives as ' + f.flightIn + ')' : f.flight + ' (FLIGHT_IN empty)', candidates: cands, found, reason: '' };
      if (!cands.length) row.reason = 'no ICAO prefix in the Airlines tab';
      if (!ac) { row.reason = row.reason || 'not found'; rows.push(row); return; }
      const callsign = C.cleanCallsign(ac.flight) || found[0];
      st.callsign = callsign;
      const route = routeStatus(routes[callsign], p.airportIcao);
      row.route = route;
      if (route === 'mismatch') { row.reason = 'route does not match the airport, ignored'; rows.push(row); return; }
      const est = C.liveEta(ac, nm, p);
      row.dist = est.dist !== undefined ? Math.round(est.dist) : null;
      if (!est.usable) { row.reason = est.reason; rows.push(row); return; }
      if (est.landed) {
        st.landedAt = nm;
        st.eta = nm; st.confidence = 'landed';
        addLog({ flight: f.flight, field: 'ETA', old: f.eta, new: C.m2t(nm), reason: 'landing detected' });
      } else {
        st.eta = C.round5(est.etaM); st.confidence = est.confidence;
      }
      st.routeOk = route === 'ok';
      st.seenAt = Date.now() - (ac.seen_pos || 0) * 1000;
      st.pos = { lat: ac.lat, lon: ac.lon, dist: est.dist, gs: ac.gs, alt: ac.alt_baro, callsign };
      row.eta = C.m2t(st.eta); row.confidence = st.confidence;
      rows.push(row);
    });

    // Departure detection around the airport: on ground, then airborne.
    flights.forEach(f => {
      const s = C.schedule(f);
      if (s.etd === null || nm < s.etd - DEP_WATCH_BEFORE || nm > s.etd + DEP_WATCH_AFTER) return;
      const st = fs(f.id);
      if (st.departedAt) return;
      const out = C.callsignCandidates(f.flightOut || f.flight, data.icaoPrefixes());
      const ac = pickAircraft(out.map(c => point.filter(a => C.cleanCallsign(a.flight) === c)));
      if (!ac || typeof ac.lat !== 'number') return;
      const dist = C.haversineNm(ac.lat, ac.lon, p.lat, p.lon);
      if (ac.alt_baro === 'ground' && dist <= GROUND_NM) st.depState = 'ground';
      else if (ac.alt_baro !== 'ground' && st.depState === 'ground') {
        st.departedAt = Math.round(nm - (ac.seen_pos || 0) / 60);
        addLog({ flight: f.flightOut || f.flight, field: 'ETD', old: f.etd, new: C.m2t(st.departedAt), reason: 'departure detected' });
      }
    });

    flights.forEach(f => recalc(f, p, nm));
    diag = { rows, near: [...new Set(point.map(a => C.cleanCallsign(a.flight)).filter(Boolean))].sort(), at: Date.now() };
  }

  // Estimated ETD, Sealing, Truck and Box Time (D slots only), applied with the threshold.
  function recalc(f, p, nm) {
    const st = fs(f.id), s = C.schedule(f);
    if (st.eta === undefined) return;
    const est = C.estimateDeparture(f, st.eta, p);
    if (!est) return;
    st.dayStop = est.dayStop;
    const prev = st.applied || { etd: s.etd, seal: s.seal, truck: s.truck };
    const next = {};
    const reason = 'live ETA ' + C.m2t(st.eta) + (est.dayStop ? ' (day stop, ETD kept)' : '');
    [['etd', 'ETD'], ['seal', 'Sealing'], ['truck', 'Truck Dep']].forEach(([k, label]) => {
      const r = C.applyWithThreshold(prev[k], est[k], p.threshold);
      next[k] = r.value;
      if (r.changed && prev[k] !== null) {
        addLog({ flight: f.flight, field: label, old: C.m2t(prev[k]), new: C.m2t(r.value), reason });
        if (k !== 'etd' && r.value - nm < p.tight) {
          tightQueue.push({ flight: f.flight, airline: f.airline, type: k === 'seal' ? 'seal' : 'truck', lbl: label, time: C.m2t(r.value), minsLeft: Math.round(r.value - nm) });
        }
      }
    });
    st.applied = next;
    st.boxShift = next.seal !== null && s.seal !== null ? next.seal - s.seal : 0;
  }

  let tightQueue = [];

  // Box Time slot for one BoxTime row: { m, auto, flagged }.
  // D slots follow the live Sealing shift unless they are already past. D-1 slots never move.
  function boxSlot(b, f, base, nm) {
    const st = f && state && state.flights[f.id];
    if (!st || !st.applied || !st.boxShift || status.state !== 'ok') return { m: base, auto: false, flagged: false };
    if (b.day !== 'D' || base <= nm) return { m: base, auto: false, flagged: Math.abs(st.boxShift) >= D1_GAP_FLAG_MIN };
    return { m: base + st.boxShift, auto: true, flagged: false };
  }

  // Live view of one flight for the UI, or null when nothing live applies.
  function forFlight(f) {
    if (status.state !== 'ok' || !state || !f) return null;
    const st = state.flights[f.id];
    if (!st || st.eta === undefined) return st && st.departedAt !== undefined ? { departedAt: st.departedAt } : null;
    const s = C.schedule(f), a = st.applied || {};
    return {
      eta: st.eta, confidence: st.confidence, landed: !!st.landedAt, routeOk: st.routeOk, pos: st.pos, seenAt: st.seenAt,
      etd: a.etd, seal: a.seal, truck: a.truck, dayStop: st.dayStop, departedAt: st.departedAt,
      sealAuto: a.seal !== undefined && a.seal !== s.seal, truckAuto: a.truck !== undefined && a.truck !== s.truck, etdAuto: a.etd !== undefined && a.etd !== s.etd,
    };
  }

  function schedule(sec) { clearTimeout(timer); timer = setTimeout(tick, sec * 1000); }

  root.AngaLive = {
    start(d, c) { data = d; cfg = c; status = { state: 'starting', at: null, error: null }; tick(); },
    refreshNow() { clearTimeout(timer); tick(); },
    onUpdate(cb) { listeners.push(cb); },
    status: () => status,
    forFlight, boxSlot,
    takeTightAlerts() { const q = tightQueue; tightQueue = []; return q; },
    log: () => log.slice(),
    diagnostic: () => diag,
  };
})(typeof window !== 'undefined' ? window : globalThis);
