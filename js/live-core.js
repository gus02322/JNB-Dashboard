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

  // Initial bearing from point 1 to point 2, degrees from north.
  function bearingDeg(lat1, lon1, lat2, lon2) {
    const r = Math.PI / 180, y = Math.sin((lon2 - lon1) * r) * Math.cos(lat2 * r);
    const x = Math.cos(lat1 * r) * Math.sin(lat2 * r) - Math.sin(lat1 * r) * Math.cos(lat2 * r) * Math.cos((lon2 - lon1) * r);
    return (Math.atan2(y, x) / r + 360) % 360;
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
    // An aircraft flying away from the airport (for example the outbound leg) never gives an ETA.
    if (typeof ac.track === 'number' && dist > p.groundNm) {
      const off = Math.abs(((ac.track - bearingDeg(ac.lat, ac.lon, p.lat, p.lon)) % 360 + 540) % 360 - 180);
      if (off > 100) return { usable: false, reason: 'flying away from the airport', dist };
    }
    const etaM = nowM + (dist / ac.gs) * 60 + p.approachMarginMin;
    const confidence = dist <= p.finalNm ? 'final' : dist <= p.approachNm ? 'approach' : 'far';
    return { usable: true, landed: false, dist, etaM, confidence };
  }

  /* ---------- estimate levels: live, last known, scheduled ---------- */

  const KM_PER_NM = 1.852;

  // Point at fraction f (0..1) of the great circle from point 1 to point 2.
  function gcInterpolate(lat1, lon1, lat2, lon2, f) {
    const r = Math.PI / 180, p1 = lat1 * r, l1 = lon1 * r, p2 = lat2 * r, l2 = lon2 * r;
    const d = 2 * Math.asin(Math.sqrt(Math.sin((p2 - p1) / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin((l2 - l1) / 2) ** 2));
    if (d === 0) return { lat: lat1, lon: lon1 };
    const a = Math.sin((1 - f) * d) / Math.sin(d), b = Math.sin(f * d) / Math.sin(d);
    const x = a * Math.cos(p1) * Math.cos(l1) + b * Math.cos(p2) * Math.cos(l2);
    const y = a * Math.cos(p1) * Math.sin(l1) + b * Math.cos(p2) * Math.sin(l2);
    const z = a * Math.sin(p1) + b * Math.sin(p2);
    return { lat: Math.atan2(z, Math.sqrt(x * x + y * y)) / r, lon: Math.atan2(y, x) / r };
  }

  // Level of an inbound flight from its stored state: 'landed' (detected on the ground after being
  // seen in flight), 'live' (position fresh), 'lost' (seen, then lost), or null (never seen).
  function arrivalLevel(st, nowMs, p) {
    if (!st || st.eta === undefined || st.eta === null) return null;
    if (st.landedAt !== undefined && st.landedAt !== null) return 'landed';
    const ageSec = (nowMs - st.seenAt) / 1000;
    return ageSec <= p.posFreshMult * p.refreshSec ? 'live' : 'lost';
  }

  function confidenceFromAge(ageMin, p) {
    return ageMin <= p.posMediumMin ? 'high' : ageMin <= p.posLowMin ? 'medium' : 'low';
  }

  // Dead reckoning for a lost aircraft. The last live ETA stays the reference: the estimated
  // distance is what the aircraft still has to fly at its last ground speed to meet that ETA,
  // placed on the great circle between the last known position and the airport.
  function deadReckon(last, airport, etaM, nowM, ageMin, p) {
    const remainingMin = etaM - nowM - p.approachMarginMin;
    const distNm = Math.max(0, (last.gs || 0) * Math.max(0, remainingMin) / 60);
    const total = haversineNm(airport.lat, airport.lon, last.lat, last.lon);
    const f = total > 0 ? Math.min(1, distNm / total) : 0;
    const pos = gcInterpolate(airport.lat, airport.lon, last.lat, last.lon, f);
    const uncNm = p.uncertaintyFactor * (last.gs || 0) * ageMin / 60;
    return {
      lat: pos.lat, lon: pos.lon, distNm, distKm: distNm * KM_PER_NM, uncKm: uncNm * KM_PER_NM,
      confidence: confidenceFromAge(ageMin, p), arrived: distNm <= 0,
    };
  }

  // Position on the schematic map: 0 = far end of the arc, 1 = airport.
  function mapFraction(distKm, maxKm) {
    return 1 - Math.min(Math.max(distKm, 0), maxKm) / maxKm;
  }

  // Arrival status line. Times in minutes of the operating day.
  function arrivalStatus(etaM, nowM, landedAtM, tolMin) {
    if (landedAtM !== null && landedAtM !== undefined) return { kind: 'landed', text: 'Landed ' + m2t(landedAtM) + ' (detected)' };
    if (etaM === null || etaM === undefined) return { kind: 'none', text: '' };
    if (nowM < etaM - tolMin) {
      const left = Math.round(etaM - nowM), h = Math.floor(left / 60), m = left % 60;
      return { kind: 'before', text: 'ETA in ' + (h ? h + 'h ' + m + 'm' : m + 'm') };
    }
    if (nowM <= etaM + tolMin) return { kind: 'due', text: 'Due now' };
    return { kind: 'passed', text: 'Scheduled time passed, no live confirmation' };
  }

  function median(values) {
    const v = values.filter(x => Number.isFinite(x)).sort((a, b) => a - b);
    if (!v.length) return null;
    const m = Math.floor(v.length / 2);
    return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
  }

  // Optional, off by default: rough position of a flight never seen, from the schedule only.
  function scheduleEstimate(origin, airport, etaM, nowM, durationMin) {
    if (!origin || !durationMin) return null;
    const fraction = 1 - (etaM - nowM) / durationMin;
    if (!(fraction > 0 && fraction < 1)) return null;
    const totalKm = haversineNm(origin.lat, origin.lon, airport.lat, airport.lon) * KM_PER_NM;
    return { fraction, distKm: totalKm * (1 - fraction) };
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
    haversineNm, bearingDeg, callsignCandidates, KM_PER_NM, gcInterpolate, arrivalLevel, confidenceFromAge,
    deadReckon, mapFraction, arrivalStatus, median, scheduleEstimate, cleanCallsign, liveEta, estimateDeparture, applyWithThreshold,
  };
});
