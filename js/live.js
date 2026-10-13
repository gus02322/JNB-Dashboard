/*
 * Ops On Time live tracking runtime (behind the LIVE_ADSB feature flag).
 * Polls the Apps Script relay (never the tracking API directly), keeps one shared state for every
 * view, applies estimates only when they move by RECALC_THRESHOLD_MIN, logs every recalculation,
 * and falls back to scheduled times when the relay does not answer.
 */
(function (root) {
  const C = root.AngaLiveCore;
  const RU = root.AngaRules;
  const STATE_KEY = 'anga_live_state';
  const LOG_KEY = 'anga_live_log';
  const LOG_MAX = 300;
  const POINT_RADIUS_NM = 40;    // point query around the airport: landing and departure detection
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
      before: g('ADSB_WINDOW_BEFORE_MIN', 60), after: g('ADSB_WINDOW_AFTER_MIN', 240),
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
    // Candidates: ICAO conversion of FLIGHT_IN, then CALLSIGN and the callsign learned by the relay.
    inbound.forEach(f => { csMap[f.id] = (f.callsigns || C.callsignCandidates(f.flightIn || f.flight, prefixes)).concat((f.inGuess || []).filter(c => !(f.callsigns || []).includes(c))); });
    // Departing aircraft (Flight, or FLIGHT_OUT when set): watched from ETD - 60 min to ETD + 240 min.
    const outMap = {};
    flights.forEach(f => {
      const s = C.schedule(f);
      if (s.etd !== null && nm >= s.etd - DEP_WATCH_BEFORE && nm <= s.etd + DEP_WATCH_AFTER) outMap[f.id] = f.outCallsigns || C.callsignCandidates(f.flightOut || f.flight, prefixes);
    });
    // Sure callsigns first, guesses (number - 1 / + 1) last: the relay answers at most 30 per call.
    const guesses = new Set(inbound.flatMap(f => f.inGuess || []));
    const all = [...new Set(Object.values(csMap).flat().concat(Object.values(outMap).flat()))];
    const cs = all.filter(c => !guesses.has(c)).concat(all.filter(c => guesses.has(c))).slice(0, 30);
    const routeAsk = inbound.map(f => fs(f.id).callsign).filter(Boolean).filter(c => !(lastPayload && lastPayload.routes && lastPayload.routes[c]));

    const qs = new URLSearchParams({ cs: cs.join(','), route: [...new Set(routeAsk)].join(','), u: data.unit || '' });
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
    process(payload, p, now, nm, flights, inbound, csMap, outMap);
    status = { state: 'ok', at: Date.now(), error: null };
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
      const score = o => (o.route === 'mismatch' ? 0 : !o.est.usable ? 1 : o.est.landed ? (st.airborneSeen && o.cs === st.callsign ? 4 : 2) : 3) + (o.cs === st.callsign ? 0.5 : 0);
      options.sort((a, b) => score(b) - score(a) || (a.ac.seen_pos ?? 999) - (b.ac.seen_pos ?? 999));
      const best = options[0];
      if (!best) { row.reason = row.reason || 'not found'; rows.push(row); return; }
      const ac = best.ac, callsign = best.cs, route = best.route, est = best.est;
      row.found = [...new Set(options.map(o => o.cs))];
      row.route = route;
      if (route === 'mismatch') { row.reason = 'route does not match the airport, ignored'; rows.push(row); return; }
      row.dist = est.dist !== undefined ? Math.round(est.dist) : null;
      if (!est.usable) { row.reason = est.reason; rows.push(row); return; }
      st.callsign = callsign;
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
      const ac = pickAircraft(cands.map(c => (payload.cs[c] || []).concat(point.filter(a => C.cleanCallsign(a.flight) === c))));
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

  // Plan after the live ETA (rule engine: TURN slides with the ETA, DAYSTOP keeps its plan),
  // applied only when a value moves by RECALC_THRESHOLD_MIN. Every change is logged.
  function recalc(f, p, nm) {
    const st = fs(f.id), plan = f.plan;
    if (st.eta === undefined || !plan) return;
    const rules = data.get().rules || RU.readRules(() => undefined);
    const res = RU.applyEta(plan, st.eta, rules);
    st.dayStop = plan.profile === 'DAYSTOP';
    st.d1Check = res.d1Check;
    if (res.marginAlert && !st.marginAlerted && plan.truck - nm >= 0) {
      st.marginAlerted = true;
      addLog({ flight: f.flight, field: 'Day stop margin', old: C.m2t(plan.truck), new: 'ETA ' + C.m2t(st.eta), reason: res.reason });
      tightQueue.push({ flight: f.flight, airline: f.airline, type: 'truck', lbl: 'Truck Dep', time: C.m2t(plan.truck), minsLeft: Math.round(plan.truck - nm), badge: 'Day stop margin' });
    }
    const prev = st.applied || { etd: plan.etd, seal: plan.seal, truck: plan.truck };
    const next = {};
    const reason = 'live ETA ' + C.m2t(st.eta) + (res.reason ? ' (' + res.reason + ')' : '');
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
    if (status.state !== 'ok' || !state) return null;
    const st = state.flights[f.id];
    if (!st || st.eta === undefined) return st && st.departedAt !== undefined ? { departedAt: st.departedAt, depEstimated: st.depEstimated, out: st.out } : null;
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
    };
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
    start(d, c) { data = d; cfg = c; status = { state: 'starting', at: null, error: null }; tick(); },
    refreshNow() { clearTimeout(timer); tick(); },
    onUpdate(cb) { listeners.push(cb); },
    status: () => status,
    forFlight, boxSlot, historyFor, setDemo, simulate, resetAll,
    simulated: () => Object.keys(sims),
    settings: () => (data ? settings() : null),
    takeTightAlerts() { const q = tightQueue; tightQueue = []; return q; },
    log: () => simLog.concat(log),
    diagnostic: () => diag,
  };
})(typeof window !== 'undefined' ? window : globalThis);
