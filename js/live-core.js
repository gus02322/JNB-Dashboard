/*
 * ANGA live estimates: pure functions, no browser API (tested with node --test).
 * Times are minutes from midnight of the flight's operating day (the day of its ETA and Sealing).
 * An ETD earlier than the ETA falls on the next day and is stored as ETD + 1440.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.AngaLiveCore = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
  const DAY = 1440;
  const EARTH_NM = 3440.065;

  function t2m(t) {
    const m = /^(\d{1,2}):(\d{2})$/.exec(String(t || '').trim());
    return m ? parseInt(m[1], 10) * 60 + parseInt(m[2], 10) : null;
  }
  function m2t(m) {
    const x = ((Math.round(m) % DAY) + DAY) % DAY;
    return String(Math.floor(x / 60)).padStart(2, '0') + ':' + String(x % 60).padStart(2, '0');
  }
  // Live estimates are shown to the nearest 5 minutes: no promise of minute accuracy.
  function round5(m) { return Math.round(m / 5) * 5; }

  // Scheduled times of one Sheet row, on its operating day.
  function schedule(row) {
    const eta = t2m(row.eta), seal = t2m(row.sealing), truck = t2m(row.truck);
    let etd = t2m(row.etd);
    if (etd !== null && eta !== null && etd < eta) etd += DAY;
    return { eta, etd, seal, truck, nextDayEtd: etd !== null && etd >= DAY };
  }

  /* ---------- Box Time rule ---------- */

  // Default slot from the timing rule. Returns { day: 'D' | 'D-1', m } or null.
  function boxSlotFormula(row, s) {
    const sc = schedule(row);
    if (sc.etd === null) return null;
    if (sc.etd > s.threshold) return sc.seal === null ? null : { day: 'D', m: sc.seal + s.dOffset };
    if (sc.etd > s.d1Cap) return { day: 'D-1', m: s.d1LateSlot };
    return { day: 'D-1', m: Math.min(sc.etd + s.d1Offset, s.d1Cap) };
  }

  function boxSettings(get) {
    return {
      threshold: t2m(get('BOX_THRESHOLD_ETD', '17:00')),
      dOffset: get('BOX_D_OFFSET_MIN', -240),
      d1Offset: get('BOX_D1_OFFSET_MIN', 120),
      d1Cap: t2m(get('BOX_D1_CAP', '15:00')),
      d1LateSlot: t2m(get('BOX_D1_LATE_SLOT', '19:00')),
    };
  }

  /* ---------- geometry and callsigns ---------- */

  function haversineNm(lat1, lon1, lat2, lon2) {
    const r = Math.PI / 180;
    const a = Math.sin((lat2 - lat1) * r / 2) ** 2 + Math.cos(lat1 * r) * Math.cos(lat2 * r) * Math.sin((lon2 - lon1) * r / 2) ** 2;
    return 2 * EARTH_NM * Math.asin(Math.min(1, Math.sqrt(a)));
  }

  // Candidate ADS-B callsigns for a flight number, using the IATA to ICAO prefixes of the Airlines tab.
  // "KP0073" gives ["KPE0073", "KPE73"]: both forms are tried, the diagnostic shows which one answers.
  function callsignCandidates(flight, prefixes) {
    const code = String(flight || '').replace(/\s+/g, '').toUpperCase();
    const m = /^([A-Z0-9]{2})(\d{1,4})([A-Z]?)$/.exec(code);
    if (!m) return [];
    const icao = prefixes[m[1]];
    if (!icao) return [];
    const out = [icao + m[2] + m[3]];
    const stripped = icao + String(parseInt(m[2], 10)) + m[3];
    if (!out.includes(stripped)) out.push(stripped);
    return out;
  }

  function cleanCallsign(s) { return String(s || '').trim().toUpperCase(); }

  /* ---------- live ETA ---------- */

  // Live ETA from one aircraft position. Returns null when the position cannot be used.
  // nowM: minutes from midnight of the operating day.
  function liveEta(ac, nowM, p) {
    if (!ac || typeof ac.lat !== 'number' || typeof ac.lon !== 'number') return { usable: false, reason: 'no position' };
    if (typeof ac.seen_pos === 'number' && ac.seen_pos > p.maxPosAgeSec) return { usable: false, reason: 'position too old' };
    const dist = haversineNm(ac.lat, ac.lon, p.lat, p.lon);
    if (ac.alt_baro === 'ground') {
      return dist <= p.groundNm ? { usable: true, landed: true, dist, confidence: 'landed' } : { usable: false, reason: 'on ground elsewhere', dist };
    }
    if (typeof ac.gs !== 'number' || ac.gs < p.minGsKt) return { usable: false, reason: 'ground speed too low', dist };
    const etaM = nowM + (dist / ac.gs) * 60 + p.approachMarginMin;
    const confidence = dist <= p.finalNm ? 'final' : dist <= p.approachNm ? 'approach' : 'far';
    return { usable: true, landed: false, dist, etaM, confidence };
  }

  /* ---------- recalculation ---------- */

  // Estimated ETD and the Sealing / Truck times that follow it.
  // A day stop (long scheduled ground time) keeps its ETD: a late arrival does not move it.
  function estimateDeparture(row, etaLiveM, p) {
    const sc = schedule(row);
    if (sc.etd === null) return null;
    const ground = sc.eta === null ? null : sc.etd - sc.eta;
    const dayStop = ground !== null && ground >= p.dayStopMinGround;
    let etd = sc.etd;
    if (!dayStop && etaLiveM !== null && etaLiveM !== undefined) etd = Math.max(sc.etd, etaLiveM + p.minRotationMin);
    const shift = etd - sc.etd;
    return {
      dayStop, ground,
      etd,
      seal: sc.seal === null ? null : sc.seal + shift, // keeps the flight's own ETD to Sealing gap
      truck: sc.truck === null ? null : sc.truck + shift, // keeps the flight's own ETD to Truck gap
      shift,
    };
  }

  // Applied value with a threshold: an estimate replaces the shown time only when it moved enough.
  function applyWithThreshold(applied, estimate, thresholdMin) {
    if (estimate === null || estimate === undefined) return { value: applied, changed: false };
    if (applied === null || applied === undefined || Math.abs(estimate - applied) >= thresholdMin) {
      return { value: estimate, changed: applied !== estimate };
    }
    return { value: applied, changed: false };
  }

  return {
    DAY, t2m, m2t, round5, schedule, boxSlotFormula, boxSettings,
    haversineNm, callsignCandidates, cleanCallsign, liveEta, estimateDeparture, applyWithThreshold,
  };
});
