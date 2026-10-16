/*
 * Ops On Time live runtime (behind the LIVE_ADSB feature flag).
 * Main source: the AeroDataBox times the relay writes to the unit tab (AUTO_ live columns), read with
 * the Sheet: statuses, revised and actual times, cancellations, aircraft. They work without the relay.
 * Bonus: live aircraft tracking (ADS-B, adsb.lol) through the Apps Script relay: position, landing and
 * take-off detection. It never replaces an AeroDataBox time, except a landing or take-off AeroDataBox
 * has not reported yet. Estimates apply only when they move by RECALC_THRESHOLD_MIN; every
 * recalculation is logged.
 */
(function (root) {
  const C = root.AngaLiveCore;
  const RU = root.AngaRules;
  const STATE_KEY = 'anga_live_state';
  const LOG_KEY = 'anga_live_log';
  const LOG_MAX = 300;
  const POINT_RADIUS_NM = 250;   // point query around the airport (one request): approach, landing, take-off
  const GROUND_NM = 5;           // on ground within this distance = at the airport
  const FINAL_NM = 30;           // confidence label "final"
  const APPROACH_NM = 150;       // confidence label "approach", beyond: "far"
  const DEP_WATCH_BEFORE = 60;   // watch for the departure from ETD - 60 min
  const DEP_WATCH_AFTER = 240;   // until ETD + 240 min

  let data, cfg, listeners = [], timer = null, failures = 0;
  let status = { state: 'off', at: null, error: null };
  let lastPayload = null, diag = { rows: [], near: [], at: null };
  let state = loadJSON(STATE_KEY, null);
  let log = loadJSON(LOG_KEY, []);

  function loadJSON(k, d) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch (e) { return d; } }
  function saveJSON(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* quota */ } }

  function todayKey(d) { return d.getFullYear() + '-' + (d.getMonth() + 1) + '-' + d.getDate(); }
  function unitNow() { return RU.clock.now(); } // wall clock of the unit (TIMEZONE)
  function nowMins(d) { return d.getHours() * 60 + d.getMinutes() + d.getSeconds() / 60; }
  const DOW = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'];

  function settings() {
    const g = (k, d) => data.setting(k, d);
    return {
      relay: String(g('LIVE_RELAY_URL', '')).trim(),
      lat: g('AIRPORT_LAT', NaN), lon: g('AIRPORT_LON', NaN), airportIcao: String(g('AIRPORT_ICAO', '')).toUpperCase(),
      refreshSec: Math.max(30, g('ADSB_REFRESH_SEC', 60)),
      before: g('ADSB_WINDOW_BEFORE_MIN', 60), after: Math.max(g('ADSB_WINDOW_AFTER_MIN', 600), 60),
      depLateMin: g('DEP_LATE_MIN', 15),
      approachMarginMin: g('APPROACH_MARGIN_MIN', 5), minGsKt: g('MIN_GS_KT', 150), maxPosAgeSec: g('MAX_POSITION_AGE_SEC', 120),
      minRotationMin: g('MIN_ROTATION_MIN', 60), dayStopMinGround: g('DAY_STOP_MIN_GROUND', 360),
      threshold: g('RECALC_THRESHOLD_MIN', 5), tight: g('TIGHT_SLOT_MIN', 30),
      groundNm: g('LANDED_RADIUS_NM', GROUND_NM), finalNm: FINAL_NM, approachNm: APPROACH_NM,
      posFreshMult: g('POS_FRESH_MULT', 2), posMediumMin: g('POS_MEDIUM_MIN', 30), posLowMin: g('POS_LOW_MIN', 60),
      uncertaintyFactor: g('UNCERTAINTY_FACTOR', 0.15), mapMaxKm: g('MAP_MAX_KM', 9000), dueTolMin: g('DUE_TOLERANCE_MIN', 5),
      historyEnabled: String(g('HISTORY_ENABLED', 'TRUE')).toUpperCase() === 'TRUE', historyMinSamples: g('HISTORY_MIN_SAMPLES', 5),
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
    return data.get().flights.filter(f => f.days.includes(dow) && !f.cancelled && !sims[f.id]);
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
    applyAdb();
    if (!p.relay) { status = { state: 'not-configured', at: null, error: 'LIVE_RELAY_URL is empty' }; notify(); return schedule(p.refreshSec); }
    const now = unitNow(), nm = nowMins(now), day = todayKey(now);
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
    // Candidates: the callsign already found today, else FLIGHT_IN (ICAO), CALLSIGN, the callsign
    // learned by the relay, then number - 1 and + 1 when FLIGHT_IN is unknown.
    inbound.forEach(f => {
      const st = fs(f.id), sure = f.callsigns || C.callsignCandidates(f.flightIn || f.flight, prefixes);
      csMap[f.id] = st.inCallsign ? [st.inCallsign] : sure.concat((f.inGuess || []).filter(c => !sure.includes(c)));
    });
    // Departing aircraft (Flight, or FLIGHT_OUT when set): watched from ETD - 60 min to ETD + 240 min.
    const outMap = {};
    flights.forEach(f => {
      const s = C.schedule(f);
      if (s.etd !== null && nm >= s.etd - DEP_WATCH_BEFORE && nm <= s.etd + DEP_WATCH_AFTER) outMap[f.id] = f.outCallsigns || C.callsignCandidates(f.flightOut || f.flight, prefixes);
    });
    // Priority (the relay answers at most 30 callsigns per call): the flight open on screen, then the
    // closest scheduled times. Each flight brings its sure callsigns before its guesses.
    const prio = [];
    if (focusId && csMap[focusId]) prio.push(csMap[focusId]);
    if (focusId && outMap[focusId]) prio.push(outMap[focusId]);
    const byId = Object.fromEntries(flights.map(f => [f.id, f]));
    const near = [];
    Object.keys(csMap).forEach(id => near.push([Math.abs(C.t2m(byId[id].eta) - nm), csMap[id]]));
    Object.keys(outMap).forEach(id => near.push([Math.abs(C.t2m(byId[id].etd) - nm), outMap[id]]));
    near.sort((a, b) => a[0] - b[0]).forEach(x => prio.push(x[1]));
    const cs = [...new Set(prio.flat())].slice(0, 30);
    const routeAsk = inbound.map(f => fs(f.id).callsign).filter(Boolean).filter(c => !(lastPayload && lastPayload.routes && lastPayload.routes[c]));

    // Mode S hex given by AeroDataBox: the exact aircraft, looked up first.
    const hexes = [...new Set(inbound.concat(flights.filter(f => outMap[f.id])).map(f => fs(f.id).airline && fs(f.id).airline.hex).filter(h => /^[0-9a-f]{6}$/.test(h || '')))].slice(0, 30);
    const qs = new URLSearchParams({ cs: cs.join(','), hex: hexes.join(','), route: [...new Set(routeAsk)].join(','), u: data.unit || '' });
    if (Number.isFinite(p.lat) && Number.isFinite(p.lon)) { qs.set('lat', p.lat); qs.set('lon', p.lon); qs.set('r', POINT_RADIUS_NM); }

    let payload;
    try {
      const r = await fetch(p.relay + (p.relay.includes('?') ? '&' : '?') + qs.toString());
      if (!r.ok) throw new Error('HTTP ' + r.status);
      payload = await r.json();
      // Some callsigns refused by the tracking API (rate limit): the others are still used.
      // Only an answer with nothing usable at all counts as a failure.
      const upstream = (payload.errors || []).filter(e => e.status === 429 || (e.status >= 500));
      const answered = Object.keys(payload.cs || {}).length + (payload.point ? 1 : 0);
      if (upstream.length && !answered) throw new Error('tracking API ' + [...new Set(upstream.map(e => e.status))].join(','));
      payload.partial = upstream.length ? upstream.length + ' lookups refused by the tracking API, retried next update' : null;
    } catch (e) {
      failures++;
      status = { state: 'fallback', at: status.at, error: String(e.message || e) };
      notify();
      return schedule(Math.min(p.refreshSec * 2 ** failures, Math.max(900, p.refreshSec * 4))); // exponential backoff
    }
    failures = 0;
    lastPayload = Object.assign({}, payload, { routes: Object.assign({}, lastPayload && lastPayload.routes, payload.routes) });
    process(payload, p, now, nm, flights, inbound, csMap, outMap);
    status = { state: 'ok', at: Date.now(), error: payload.partial || null };
    if (state.since === undefined) state.since = nm; // live tracking watching since (minutes of the day)
    saveJSON(STATE_KEY, state);
    notify();
    return schedule(p.refreshSec);
  }

  function process(payload, p, now, nm, flights, inbound, csMap, outMap) {
    const point = payload.point || [];
    const routes = lastPayload.routes || {};
    const rows = [];

    inbound.forEach(f => {
      const st = fs(f.id), cands = csMap[f.id];
      const found = cands.filter(c => (payload.cs[c] || []).length || point.some(a => C.cleanCallsign(a.flight) === c));
      const row = { flight: f.flightIn ? f.flight + ' (arrives as ' + f.flightIn + ')' : f.flight + ' (FLIGHT_IN empty: ' + f.flight + ', number - 1 and + 1 tried)', candidates: cands, found, reason: '' };
      if (!cands.length) row.reason = 'no ICAO prefix in the Airlines tab';
      // Every aircraft answering one of the candidates, evaluated; the one coming to the airport wins.
      // The callsign already followed for this flight is kept first, so the choice does not jump.
      const options = [];
      cands.forEach(c => (payload.cs[c] || []).concat(point.filter(a => C.cleanCallsign(a.flight) === c)).forEach(ac => {
        const cs = C.cleanCallsign(ac.flight) || c, route = routeStatus(routes[cs], p.airportIcao), est = C.liveEta(ac, nm, p);
        options.push({ ac, cs, route, est });
      }));
      // The aircraft AeroDataBox assigned (hex): accepted under one of the candidates, or flying to the airport.
      const hex = st.airline && st.airline.hex;
      ((hex && payload.hex && payload.hex[hex]) || []).forEach(ac => {
        const cs = C.cleanCallsign(ac.flight), est = C.liveEta(ac, nm, p);
        if (cands.includes(cs) || (est.usable && !est.landed)) options.push({ ac, cs: cs || cands[0] || hex, route: cands.includes(cs) ? routeStatus(routes[cs], p.airportIcao) : 'ok', est, byHex: true });
      });
      const score = o => (o.route === 'mismatch' ? 0 : !o.est.usable ? 1 : o.est.landed ? (st.airborneSeen && o.cs === st.callsign ? 4 : 2) : 3) + (o.cs === st.callsign ? 0.5 : 0);
      options.sort((a, b) => score(b) - score(a) || (a.ac.seen_pos ?? 999) - (b.ac.seen_pos ?? 999));
      const best = options[0];
      if (!best) { row.reason = row.reason || 'not found'; st.inState = st.inState === 'airborne' ? 'lost' : st.inState || 'notseen'; rows.push(row); return; }
      const ac = best.ac, callsign = best.cs, route = best.route, est = best.est;
      row.found = [...new Set(options.map(o => o.cs))];
      row.route = route;
      if (route === 'mismatch') { row.reason = 'route does not match the airport, ignored'; rows.push(row); return; }
      row.dist = est.dist !== undefined ? Math.round(est.dist) : null;
      if (!est.usable) { row.reason = est.reason; if (!st.inCallsign) st.inState = 'notseen'; rows.push(row); return; }
      st.callsign = callsign;
      // The incoming flight is identified (seen flying, or landed after being seen flying): kept for the day.
      if (!est.landed || st.airborneSeen) { st.inCallsign = callsign; st.inState = est.landed ? 'landed' : 'airborne'; }
      const ri = routes[callsign] || {}, codes = String(ri._airport_codes_iata || ri.airport_codes || '');
      if (/^[A-Z]{3}-[A-Z]{3}/.test(codes)) st.inOrigin = codes.slice(0, 3);
      // Landed only after being seen in flight: a parked aircraft with the same callsign is not a landing.
      if (est.landed && !st.airborneSeen) { row.reason = 'on the ground at the airport, never seen in flight: not counted as landed'; rows.push(row); return; }
      if (!est.landed) st.airborneSeen = true;
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

    // Departure: the departing aircraft seen on the ground at the airport, then airborne and flying away.
    // If it is first seen already airborne, the take-off time is estimated from its distance and speed.
    const outRows = [];
    flights.forEach(f => {
      const cands = outMap[f.id];
      if (!cands) return;
      const st = fs(f.id);
      const hex = st.airline && st.airline.hex;
      const ac = pickAircraft(cands.map(c => (payload.cs[c] || []).concat(point.filter(a => C.cleanCallsign(a.flight) === c)))
        .concat([((hex && payload.hex && payload.hex[hex]) || []).filter(a => cands.includes(C.cleanCallsign(a.flight)))]));
      const row = { flight: f.flight + ' (departure)', candidates: cands, found: ac ? [C.cleanCallsign(ac.flight)] : [], reason: '' };
      if (!ac || typeof ac.lat !== 'number') { row.reason = st.departedAt !== undefined ? 'departed, out of live coverage' : 'not found'; outRows.push(row); return; }
      const dist = C.haversineNm(ac.lat, ac.lon, p.lat, p.lon);
      row.dist = Math.round(dist);
      if (ac.alt_baro === 'ground') {
        if (dist <= GROUND_NM) { st.depState = 'ground'; row.reason = 'on the ground at the airport'; }
        else row.reason = 'on the ground elsewhere';
        outRows.push(row); return;
      }
      const away = typeof ac.track !== 'number' || dist <= GROUND_NM ||
        Math.abs(((ac.track - C.bearingDeg(p.lat, p.lon, ac.lat, ac.lon)) % 360 + 540) % 360 - 180) <= 100;
      if (!away) { row.reason = 'airborne but flying towards the airport'; outRows.push(row); return; }
      if (st.departedAt === undefined) {
        const fromGround = st.depState === 'ground';
        const flown = !fromGround && ac.gs > 50 ? (dist / ac.gs) * 60 : 0;
        st.departedAt = C.round5(nm - (ac.seen_pos || 0) / 60 - flown);
        st.depEstimated = !fromGround;
        addLog({ flight: f.flightOut || f.flight, field: 'ETD', old: f.etd, new: C.m2t(st.departedAt), reason: fromGround ? 'take-off detected' : 'seen in flight, take-off time estimated' });
      }
      st.out = { lat: ac.lat, lon: ac.lon, dist, gs: ac.gs, alt: ac.alt_baro, seenAt: Date.now() - (ac.seen_pos || 0) * 1000 };
      row.reason = 'in flight, departed ' + C.m2t(st.departedAt) + (st.depEstimated ? ' (estimated)' : '');
      outRows.push(row);
    });

    seedFromRelay(payload, flights, now);
    seedFromAdb(flights, now);
    flights.forEach(f => recalc(f, p, nm));
    diag = { rows: rows.concat(outRows), near: [...new Set(point.map(a => C.cleanCallsign(a.flight)).filter(Boolean))].sort(), at: Date.now() };
  }

  // Landings and take-offs the relay trigger already detected today (every 15 min, without any screen
  // open): a screen opened later, when the aircraft is out of live coverage, still knows them.
  function seedFromRelay(payload, flights, now) {
    const t = payload.today, iso = d => d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
    if (!t || t.date !== iso(now)) return;
    flights.forEach(f => {
      const st = fs(f.id);
      const arr = t.arr && t.arr[String(f.flightIn || f.flight).toUpperCase() + '|' + f.eta];
      if (arr && st.landedAt === undefined && C.t2m(arr) !== null) {
        st.landedAt = st.eta = C.t2m(arr); st.confidence = 'landed'; st.airborneSeen = true; st.seenAt = Date.now(); st.fromRelay = true;
        addLog({ flight: f.flight, field: 'ETA', old: f.eta, new: arr, reason: 'landing detected by the relay' });
      }
      const dep = t.dep && t.dep[String(f.flightOut || f.flight).toUpperCase() + '|' + f.etd];
      if (dep && st.departedAt === undefined && C.t2m(dep.at) !== null) {
        st.departedAt = C.t2m(dep.at) + (dep.day && dep.day > t.date ? 1440 : 0); st.depEstimated = !!dep.est;
        addLog({ flight: f.flightOut || f.flight, field: 'ETD', old: f.etd, new: dep.at, reason: 'take-off detected by the relay' + (dep.est ? ' (estimated)' : '') });
      }
    });
  }

  // AeroDataBox times of today (AUTO_ live columns of the unit tab, read with the Sheet, no relay needed).
  // st.airline: { eta, etd (actual, else revised, else scheduled), kinds, statuses, delays, cancelled,
  // diverted, aircraft change, hex, gate, match with the Sheet times, checkedAt }.
  function seedFromAdb(flights, now) {
    const iso = d => d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
    const und = v => (v === null ? undefined : v);
    flights.forEach(f => {
      const st = fs(f.id), a = RU.adbDay(f.adb, iso(now));
      if (!a) { delete st.airline; return; }
      const prev = st.airline || {};
      const al = {
        at: a.checkedAt.slice(11, 16), checkedAt: a.checkedAt, updatedUtc: a.updatedUtc,
        eta: und(a.arr.time), etaKind: a.arr.kind, etaStatus: a.arr.status, etaSched: und(a.arr.sched), arrDelay: a.arr.delay,
        etd: und(a.dep.time), etdKind: a.dep.kind, etdStatus: a.dep.status, etdSched: und(a.dep.sched), depDelay: a.dep.delay,
        landed: und(a.arr.actual), departed: und(a.dep.actual), cancelled: a.cancelled, diverted: a.diverted,
        aircraftChange: a.aircraftChange, aircraft: a.aircraft, reg: a.reg, hex: a.hex, gate: a.gate, terminal: a.terminal, origin: a.origin, dest: a.dest,
        match: { eta: RU.schedMatch(C.t2m(f.eta), a.arr.sched), etd: RU.schedMatch(C.t2m(f.etd), a.dep.sched) },
      };
      const why = (k, s0) => 'AeroDataBox ' + k + (s0 ? ' (' + s0 + ')' : '') + ', read ' + al.at;
      if (al.eta !== undefined && al.eta !== prev.eta) addLog({ flight: f.flight, field: 'ETA', old: f.eta, new: C.m2t(al.eta), reason: why(al.etaKind, al.etaStatus) });
      if (al.etd !== undefined && al.etd !== prev.etd) addLog({ flight: f.flightOut || f.flight, field: 'ETD', old: f.etd, new: C.m2t(al.etd), reason: why(al.etdKind, al.etdStatus) });
      if (al.cancelled && !prev.cancelled) addLog({ flight: f.flight, field: 'Flight', old: f.etd, new: al.diverted ? 'DIVERTED' : 'CANCELLED', reason: why('status', al.etdStatus || al.etaStatus) });
      if (al.aircraftChange && !st.acAlerted) {
        st.acAlerted = true;
        addLog({ flight: f.flight, field: 'Aircraft', old: al.aircraftChange.from, new: al.aircraftChange.to, reason: 'AeroDataBox: aircraft change, check the galley configuration' });
        tightQueue.push({ flight: f.flight, airline: f.airline, type: 'aircraft', lbl: 'Aircraft change', time: f.etd || f.eta || '', minsLeft: null,
          badge: 'Aircraft change: ' + al.aircraftChange.from + ' to ' + al.aircraftChange.to });
      }
      st.airline = al;
      // Landing and take-off reported by AeroDataBox are facts: they win over the live detection.
      if (al.landed !== undefined && st.landedAt !== al.landed) {
        st.landedAt = st.eta = al.landed; st.confidence = 'landed'; st.airborneSeen = true; st.landedBy = 'adb';
        if (st.seenAt === undefined) st.seenAt = Date.now();
        addLog({ flight: f.flight, field: 'ETA', old: f.eta, new: C.m2t(al.landed), reason: 'landing reported by AeroDataBox' });
      }
      if (al.departed !== undefined && st.departedAt !== al.departed) {
        st.departedAt = al.departed; st.depEstimated = false; st.depBy = 'adb';
        addLog({ flight: f.flightOut || f.flight, field: 'ETD', old: f.etd, new: C.m2t(al.departed), reason: 'take-off reported by AeroDataBox' });
      }
    });
  }

  // AeroDataBox applied on its own (every tick and every Sheet refresh), even when the relay is down.
  function applyAdb() {
    if (!data) return;
    const p = settings(), now = unitNow(), nm = nowMins(now);
    ensureState(todayKey(now));
    const flights = todaysFlights(now);
    seedFromAdb(flights, now);
    flights.forEach(f => recalc(f, p, nm));
    saveJSON(STATE_KEY, state);
  }

  // Plan after the live ETA (rule engine: TURN slides with the ETA, DAYSTOP keeps its plan),
  // applied only when a value moves by RECALC_THRESHOLD_MIN. Every change is logged.
  function recalc(f, p, nm) {
    const st = fs(f.id), plan = f.plan, al = st.airline;
    // ETA used: a landing (AeroDataBox, else detected), else the AeroDataBox time, else the live estimate.
    const src = st.landedAt !== undefined ? 'landed' : al && al.eta !== undefined ? 'airline' : 'live';
    const eta = src === 'landed' ? st.landedAt : src === 'airline' ? al.eta : st.eta;
    if (eta === undefined || !plan || (al && al.cancelled)) return;
    const rules = data.get().rules || RU.readRules(() => undefined);
    const res = RU.applyEta(plan, eta, rules);
    st.dayStop = plan.profile === 'DAYSTOP';
    st.d1Check = res.d1Check;
    if (res.marginAlert && !st.marginAlerted && plan.truck - nm >= 0) {
      st.marginAlerted = true;
      addLog({ flight: f.flight, field: 'Day stop margin', old: C.m2t(plan.truck), new: 'ETA ' + C.m2t(eta), reason: res.reason });
      tightQueue.push({ flight: f.flight, airline: f.airline, type: 'truck', lbl: 'Truck Dep', time: C.m2t(plan.truck), minsLeft: Math.round(plan.truck - nm), badge: 'Day stop margin' });
    }
    const prev = st.applied || { etd: plan.etd, seal: plan.seal, truck: plan.truck };
    const next = {};
    const reason = (src === 'airline' ? 'AeroDataBox ETA ' : src === 'landed' ? 'landed ' : 'live ETA ') + C.m2t(eta) + (res.reason ? ' (' + res.reason + ')' : '');
    // Projected ETD (inbound + MIN_ROTATION_MIN) later than the published ETD (AeroDataBox, else the Sheet): flagged.
    const published = al && al.etd !== undefined ? al.etd : plan.etd;
    st.projEtd = res.etd !== null && published !== null && published !== undefined && res.etd - published >= p.threshold ? res.etd : null;
    [['etd', 'ETD'], ['seal', 'Sealing'], ['truck', 'Truck Dep']].forEach(([k, label]) => {
      // A Sealing or Truck already past is done: a late live estimate never moves it afterwards.
      const r = k !== 'etd' && prev[k] !== null && prev[k] < nm ? { value: prev[k], changed: false } : C.applyWithThreshold(prev[k], res[k], p.threshold);
      next[k] = r.value;
      if (r.changed && prev[k] !== null) {
        addLog({ flight: f.flight, field: label, old: C.m2t(prev[k]), new: C.m2t(r.value), reason });
        if (k !== 'etd' && r.value - nm >= 0 && r.value - nm < p.tight) { // past times never alert
          tightQueue.push({ flight: f.flight, airline: f.airline, type: k === 'seal' ? 'seal' : 'truck', lbl: label, time: C.m2t(r.value), minsLeft: Math.round(r.value - nm) });
        }
      }
    });
    st.applied = next;
    st.boxShift = next.seal !== null && plan.seal !== null ? next.seal - plan.seal : 0;
  }

  let tightQueue = [];
  let focusId = null, lastFocusAt = 0;

  // Box Time of one flight: { day, m, base, auto, check, hold, source }.
  // D slots follow the Sealing shift unless already past. D-1 slots never move: they are marked Check.
  function boxSlot(f, nm) {
    const b = f && f.box;
    if (!b) return null;
    const out = { day: b.day, m: b.m, base: b.m, auto: false, check: false, hold: false, source: b.source };
    const v = forFlight(f);
    if (f.cancelled || (v && v.cancelled)) { out.hold = true; return out; }
    if (!v || !v.boxShift) return out;
    if (b.day !== 'D') { out.check = true; return out; }
    if (!v.simulated && nm !== undefined && nm >= 0 && b.m <= nm) return out;
    out.m = b.m + v.boxShift; out.auto = true;
    return out;
  }

  // Live (or simulated) view of one flight for the UI, or null when nothing applies.
  // level: 'live' (fresh position), 'lost' (seen then lost: estimated, never shown as live),
  // 'landed' (detected on the ground after being seen in flight), 'sim' (demo simulation).
  function forFlight(f) {
    if (!f) return null;
    if (sims[f.id]) return simView(f);
    if (demo && f.id === demo.id) return demo.view();
    const st = state && state.day === todayKey(unitNow()) ? state.flights[f.id] : null;
    if (!st) return null;
    // Relay down: only AeroDataBox (and what it reported) is shown; live tracking data is left aside.
    const relayOk = status.state === 'ok', al = st.airline;
    if (!relayOk && !al) return null;
    const extra = { airline: al, cancelled: !!(al && al.cancelled), projEtd: st.projEtd || null };
    if (st.landedAt === undefined && al && al.eta !== undefined) return Object.assign(airlineView(f, st, relayOk), extra);
    if (st.eta === undefined || (!relayOk && st.landedBy !== 'adb')) {
      const v = Object.assign({ inbound: relayOk ? inboundView(f, st) : null, depGround: relayOk && st.depState === 'ground' }, extra);
      if (st.departedAt !== undefined && (relayOk || st.depBy === 'adb')) Object.assign(v, { departedAt: st.departedAt, depEstimated: st.depEstimated, out: relayOk ? st.out : null, depBy: st.depBy });
      return v.inbound || v.departedAt !== undefined || v.depGround || v.airline ? v : null;
    }
    const plan = f.plan || {}, a = st.applied || {}, p = settings();
    const level = C.arrivalLevel(st, Date.now(), p), ageMin = st.seenAt ? (Date.now() - st.seenAt) / 60000 : null;
    let dr = null;
    if (level === 'lost' && st.pos && Number.isFinite(p.lat)) {
      dr = C.deadReckon(st.pos, { lat: p.lat, lon: p.lon }, st.eta, nowMins(unitNow()), ageMin, p);
    }
    return {
      level, ageMin, dr, landedAt: st.landedAt,
      eta: st.eta, confidence: st.confidence, landed: !!st.landedAt, routeOk: st.routeOk, pos: st.pos, seenAt: st.seenAt,
      etd: a.etd, seal: a.seal, truck: a.truck, dayStop: st.dayStop, departedAt: st.departedAt, depEstimated: st.depEstimated, out: st.out,
      sealAuto: a.seal !== undefined && a.seal !== plan.seal, truckAuto: a.truck !== undefined && a.truck !== plan.truck, etdAuto: a.etd !== undefined && a.etd !== plan.etd,
      boxShift: st.boxShift || 0, d1Check: !!st.d1Check, delay: plan.eta !== null && plan.eta !== undefined ? st.eta - plan.eta : null,
      inbound: inboundView(f, st), depGround: st.depState === 'ground', airline: st.airline, landedBy: st.landedBy, depBy: st.depBy,
      cancelled: !!(st.airline && st.airline.cancelled), projEtd: st.projEtd || null,
    };
  }

  // ETA from AeroDataBox (not landed yet): level 'airline'. Live tracking, when it sees the aircraft, adds
  // its position as a bonus (adsb: { level, pos, seenAt, ageMin, dr }) without changing the ETA.
  function airlineView(f, st, relayOk) {
    const plan = f.plan || {}, a = st.applied || {}, al = st.airline, p = settings();
    let adsb = null;
    if (relayOk && st.eta !== undefined && st.seenAt !== undefined && st.pos) {
      const lv = C.arrivalLevel(st, Date.now(), p), ageMin = (Date.now() - st.seenAt) / 60000;
      adsb = { level: lv, pos: st.pos, seenAt: st.seenAt, ageMin, eta: st.eta,
        dr: lv === 'lost' && Number.isFinite(p.lat) ? C.deadReckon(st.pos, { lat: p.lat, lon: p.lon }, st.eta, nowMins(unitNow()), ageMin, p) : null };
    }
    const departed = st.departedAt !== undefined && (relayOk || st.depBy === 'adb');
    return {
      level: 'airline', airline: al, adsb, eta: al.eta, landedAt: undefined, landed: false,
      etd: a.etd, seal: a.seal, truck: a.truck, dayStop: plan.profile === 'DAYSTOP', departedAt: departed ? st.departedAt : undefined, depEstimated: st.depEstimated, out: relayOk ? st.out : null,
      sealAuto: a.seal !== undefined && a.seal !== plan.seal, truckAuto: a.truck !== undefined && a.truck !== plan.truck, etdAuto: a.etd !== undefined && a.etd !== plan.etd,
      boxShift: st.boxShift || 0, d1Check: !!st.d1Check, delay: al.arrDelay !== null && al.arrDelay !== undefined ? al.arrDelay : plan.eta !== null && plan.eta !== undefined ? al.eta - plan.eta : null,
      inbound: relayOk ? inboundView(f, st) : null, depGround: relayOk && st.depState === 'ground',
    };
  }

  // Incoming flight of a departure: number (IATA when the airline is known), state and origin.
  // state: airborne, landed, lost (seen then out of coverage), notseen (searched, not found yet).
  function inboundView(f, st) {
    if (!st || !st.inState) return null;
    const cs = st.inCallsign || '';
    let number = '';
    if (cs) {
      const al = (data.get().airlines || []).find(a => a.icao && cs.startsWith(a.icao) && /^\d/.test(cs.slice(a.icao.length)));
      number = al && al.iata ? al.iata + cs.slice(al.icao.length) : cs;
    }
    return { callsign: cs, number, state: st.inState, origin: st.inOrigin || '', guessed: !f.flightIn && !!cs && !(f.callsigns || []).includes(cs) };
  }

  /* ---------- demo simulation: delays, early arrivals, cancellations. Never written anywhere. ---------- */
  const sims = {};
  let simLog = [];
  function simView(f) {
    const s = sims[f.id], plan = f.plan, rules = data.get().rules;
    if (s.kind === 'cancel') return { level: 'sim', simulated: true, cancelled: true, sim: s, eta: plan.eta, boxShift: 0 };
    const eta = plan.eta !== null ? plan.eta + s.delta : null;
    // DAYSTOP with no STA: a delay simulates a later departure handling, nothing moves (rule)
    const res = eta === null ? { moved: false, etd: plan.etd, seal: plan.seal, truck: plan.truck, d1Check: false } : RU.applyEta(plan, eta, rules);
    return {
      level: 'sim', simulated: true, sim: s, eta: eta, etd: res.etd, seal: res.seal, truck: res.truck, dayStop: plan.profile === 'DAYSTOP',
      sealAuto: res.seal !== plan.seal, truckAuto: res.truck !== plan.truck, etdAuto: res.etd !== plan.etd,
      boxShift: res.seal !== null && plan.seal !== null ? res.seal - plan.seal : 0, d1Check: !!res.d1Check, marginAlert: !!res.marginAlert,
      delay: s.delta, reason: res.reason || '',
    };
  }
  // kind: 'delay' (delta > 0), 'early' (delta < 0), 'cancel', or 'reset'.
  function simulate(f, kind, minutes) {
    if (!f || !f.plan) return null;
    const before = sims[f.id] ? simView(f) : null;
    if (kind === 'reset') { delete sims[f.id]; simLog.unshift({ at: new Date().toISOString(), flight: f.flight, field: 'All', old: '', new: 'reset', reason: 'demo reset', sim: true }); notify(); return null; }
    const delta = kind === 'cancel' ? 0 : Math.round(minutes || 0);
    sims[f.id] = { kind, delta, at: Date.now() };
    const v = simView(f), plan = f.plan;
    const entry = (field, a, b) => simLog.unshift({ at: new Date().toISOString(), flight: f.flight, field, old: C.m2t(a), new: b, reason: kind === 'cancel' ? 'demo: cancellation' : 'demo: ' + (delta > 0 ? '+' : '') + delta + ' min' + (v.reason ? ' (' + v.reason + ')' : ''), sim: true });
    if (kind === 'cancel') entry('Flight', plan.etd, 'CANCELLED');
    else {
      entry('ETA', plan.eta, C.m2t(v.eta));
      [['truck', 'Truck Dep'], ['seal', 'Sealing'], ['etd', 'ETD']].forEach(([k, lbl]) => { if (v[k] !== plan[k]) entry(lbl, plan[k], C.m2t(v[k])); });
    }
    if (simLog.length > LOG_MAX) simLog.length = LOG_MAX;
    notify();
    return { before, after: v };
  }
  function resetAll() { Object.keys(sims).forEach(k => delete sims[k]); notify(); }

  // Median deviation of past days for a flight, computed by the relay from the private History tab.
  // Key: arriving flight number and scheduled ETA (one flight number can have several Sheet rows).
  function historyFor(f) {
    if (demo && f && f.id === demo.id) return demo.history();
    const p = data ? settings() : null;
    if (!p || !p.historyEnabled || !lastPayload || !lastPayload.history || !f || !f.eta) return null;
    const h = lastPayload.history[String(f.flightIn || f.flight).toUpperCase() + '|' + f.eta];
    return h && h.n >= p.historyMinSamples && Number.isFinite(h.median) ? h : null;
  }

  /* ---------- demo mode: simulated observations for a fictive flight, never real data ---------- */
  let demo = null;
  function setDemo(kind, f, airport) {
    const t0 = Date.now(), nm0 = nowMins(unitNow()), eta = C.t2m(f.eta);
    const at = (nm) => ({ lat: airport.lat + nm / 60, lon: airport.lon }); // nm due north of the airport
    const base = { etd: undefined, sealAuto: false, truckAuto: false, etdAuto: false, simulated: true };
    // lost: last observation 35 min before the demo started, at the distance matching the ETA then
    const lostSeenAt = t0 - 35 * 60e3, lostGs = 460;
    const lostLast = Object.assign(at((eta - (nm0 - 35) - 5) / 60 * lostGs), { gs: lostGs, alt: 35000 });
    const views = {
      live: () => {
        const nm = nowMins(unitNow()), distNm = Math.max(0, (eta - nm - 5) / 60 * 450);
        return Object.assign({}, base, { level: 'live', ageMin: 1.5, eta, confidence: 'far', seenAt: Date.now() - 90e3,
          pos: Object.assign(at(distNm), { dist: distNm, gs: 450, alt: 33000 }) });
      },
      lost: () => {
        const ageMin = (Date.now() - lostSeenAt) / 60000;
        return Object.assign({}, base, { level: 'lost', ageMin, eta, seenAt: lostSeenAt, pos: lostLast,
          dr: C.deadReckon(lostLast, airport, eta, nowMins(unitNow()), ageMin, settings()) });
      },
      landed: () => Object.assign({}, base, { level: 'landed', ageMin: (Date.now() - t0) / 60000 + 10, eta: nm0 - 10, landedAt: nm0 - 10, landed: true, seenAt: t0 - 10 * 60e3 }),
      never: () => null,
    };
    demo = { id: f.id, view: views[kind] || views.never, history: () => (kind === 'never' ? { median: 12, n: 7, simulated: true } : null) };
  }

  function schedule(sec) { clearTimeout(timer); timer = setTimeout(tick, sec * 1000); }

  root.AngaLive = {
    start(d, c) {
      data = d; cfg = c; status = { state: 'starting', at: null, error: null };
      if (data.onChange) data.onChange(() => { applyAdb(); notify(); });
      tick();
    },
    refreshNow() { clearTimeout(timer); tick(); },
    // A flight opened on screen is looked up first, right away (at most once a minute).
    focus(f) {
      focusId = f ? f.id : null;
      if (f && status.state !== 'off' && data && Date.now() - lastFocusAt > 60000) { lastFocusAt = Date.now(); clearTimeout(timer); tick(); }
    },
    onUpdate(cb) { listeners.push(cb); },
    status: () => status,
    // Minutes of the day since which live tracking has answered today (null: not yet).
    watchingSince: () => (state && state.day === todayKey(unitNow()) && state.since !== undefined ? state.since : null),
    forFlight, boxSlot, historyFor, setDemo, simulate, resetAll,
    simulated: () => Object.keys(sims),
    settings: () => (data ? settings() : null),
    takeTightAlerts() { const q = tightQueue; tightQueue = []; return q; },
    log: () => simLog.concat(log),
    diagnostic: () => diag,
  };
})(typeof window !== 'undefined' ? window : globalThis);
