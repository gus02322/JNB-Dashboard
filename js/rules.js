/*
 * Ops On Time rule engine: pure functions, no browser API (tested with node --test).
 * Every timing rule is read from the RULES tab of the Sheet (and RULES_<UNIT> overrides).
 * DEFAULTS below only apply when a key is missing from the Sheet.
 * Times are minutes from midnight of the flight's operating day (the day of its ETA).
 * An ETD earlier than the ETA is on the next day and is stored as ETD + 1440.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.AngaRules = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
  const DAY = 1440;

  // Default value and plain description of every timing rule (also written to the RULES tab).
  const RULE_DEFS = [
    ['TURN_TRUCK_OFFSET_MIN', '-30', 'Profile TURN: Truck = ETA + this offset, minutes'],
    ['DAYSTOP_TRUCK_OFFSET_MIN', '-180', 'Profile DAYSTOP: Truck = ETD + this offset, minutes'],
    ['DAY_STOP_MIN_GROUND', '360', 'Scheduled ground time (STD - STA) from which a flight is a DAYSTOP, minutes'],
    ['SEAL_TO_TRUCK_MIN', '60', 'Sealing = Truck - this many minutes (narrowbody)'],
    ['SEAL_TO_TRUCK_WIDE_MIN', '120', 'Sealing = Truck - this many minutes (widebody)'],
    ['WIDEBODY_AIRLINES', '', 'Airlines treated as widebody when the aircraft type is unknown'],
    ['WIDEBODY_TYPES', 'A330,A332,A333,A338,A339,A340,A343,A346,A350,A359,A35K,A380,A388,B744,B748,B763,B764,B772,B77L,B77W,B778,B779,B788,B789,B78X,747,767,777,787,MD11', 'Aircraft types treated as widebody (matched in the aircraft model)'],
    ['TRUCK_EXCEPTIONS', '', 'Per flight Truck rule: FLIGHT:ETA or ETD +/- minutes, separated by |'],
    ['SEAL_EXCEPTIONS', '', 'Per flight Sealing gap: FLIGHT:minutes before Truck, separated by |'],
    ['MIN_ROTATION_MIN', '60', 'TURN: estimated ETD = max(STD, live ETA + this), minutes'],
    ['RECALC_THRESHOLD_MIN', '5', 'A live ETA moves the plan only when it differs by at least this many minutes'],
    ['TIGHT_SLOT_MIN', '30', 'Alert "Slot too tight" when a moved Sealing or Truck is less than this many minutes from now'],
    ['DAYSTOP_MARGIN_MIN', '60', 'DAYSTOP: alert when the live ETA leaves less than this many minutes before Truck'],
    ['BOX_THRESHOLD_ETD', '17:00', 'ETD after this time: Box Time slot on the day (D)'],
    ['BOX_D_OFFSET_MIN', '-240', 'Slot D = Sealing + this offset, minutes'],
    ['BOX_D1_OFFSET_MIN', '120', 'Slot D-1 = ETD + this offset, minutes'],
    ['BOX_D1_CAP', '15:00', 'Latest D-1 slot from the ETD rule'],
    ['BOX_D1_LATE_SLOT', '19:00', 'D-1 slot when ETD is after BOX_D1_CAP and not after BOX_THRESHOLD_ETD'],
    ['HEALTH_GAP_MIN', '5', 'Data health: flag a Sheet time that differs from the rule by at least this many minutes'],
  ];
  const DEFAULTS = Object.fromEntries(RULE_DEFS.map(r => [r[0], r[1]]));

  /* ---------- times ---------- */

  // Accepts H:MM, HH:MM and HH:MM:SS. Anything else is null (never guessed).
  function t2m(t) {
    const m = /^(\d{1,2}):(\d{2})(?::\d{2})?$/.exec(String(t === undefined || t === null ? '' : t).trim());
    if (!m) return null;
    const h = parseInt(m[1], 10), mi = parseInt(m[2], 10);
    return h < 24 && mi < 60 ? h * 60 + mi : null;
  }
  function m2t(m) {
    if (m === null || m === undefined || !Number.isFinite(m)) return '';
    const x = ((Math.round(m) % DAY) + DAY) % DAY;
    return String(Math.floor(x / 60)).padStart(2, '0') + ':' + String(x % 60).padStart(2, '0');
  }
  // Signed difference a - b in minutes, folded to [-720, 720) (midnight safe).
  function diff(a, b) {
    if (a === null || b === null || a === undefined || b === undefined) return null;
    return ((((a - b) % DAY) + DAY + 720) % DAY) - 720;
  }
  function fmtOffset(min) {
    const s = min < 0 ? '-' : '+', a = Math.abs(min), h = Math.floor(a / 60), m = a % 60;
    return s + ' ' + (h ? h + 'h' + (m ? String(m).padStart(2, '0') : '') : m + ' min');
  }

  /* ---------- flight numbers ---------- */

  // Normalised flight number: uppercase, no spaces, no leading zeros (KP0073 = KP73).
  // Accepts IATA (2 characters) and ICAO (3 letters) prefixes.
  function normFlight(s) {
    const code = String(s || '').replace(/[\s-]+/g, '').toUpperCase();
    let m = /^([A-Z]{3})(\d{1,5})([A-Z]?)$/.exec(code), kind = 'ICAO';
    if (!m) { m = /^([A-Z0-9]{2})(\d{1,5})([A-Z]?)$/.exec(code); kind = 'IATA'; }
    if (!m || (kind === 'IATA' && /^\d\d$/.test(m[1]))) return null;
    const number = String(parseInt(m[2], 10));
    return { norm: m[1] + number + m[3], prefix: m[1], number, suffix: m[3], kind, raw: code };
  }
  function sameFlight(a, b) {
    const x = normFlight(a), y = normFlight(b);
    return !!(x && y && x.norm === y.norm);
  }

  // ICAO callsign candidates for a flight number. prefixes: IATA -> ICAO map from the Airlines tab.
  function callsigns(flight, prefixes) {
    const n = normFlight(flight);
    if (!n) return [];
    const icao = n.kind === 'ICAO' ? n.prefix : (prefixes || {})[n.prefix];
    if (!icao) return [];
    const digits = String(n.raw).slice(n.prefix.length).replace(/[A-Z]$/, '');
    const out = [icao + n.number + n.suffix];
    if (digits !== n.number) out.push(icao + digits + n.suffix);
    return out;
  }

  /* ---------- rules ---------- */

  function listOf(v) { return String(v || '').split(/[,;|\s]+/).map(x => x.trim().toUpperCase()).filter(Boolean); }

  // "ETD-120", "ETA - 30", "-30" (reference given separately). Returns { ref, off } or null.
  function parseOffset(v, defaultRef) {
    const s = String(v || '').replace(/\s+/g, '').toUpperCase();
    const m = /^(ETA|ETD|STA|STD)?([+-]?\d+)$/.exec(s);
    if (!m) return null;
    const ref = m[1] ? (m[1] === 'STA' ? 'ETA' : m[1] === 'STD' ? 'ETD' : m[1]) : defaultRef;
    return ref ? { ref, off: parseInt(m[2], 10) } : null;
  }
  // "ET848:ETD-120|UA187:ETD-150" -> Map(norm -> value string)
  function parseExceptions(v) {
    const map = new Map();
    String(v || '').split('|').forEach(part => {
      const i = part.indexOf(':');
      if (i < 0) return;
      const n = normFlight(part.slice(0, i));
      if (n) map.set(n.norm, part.slice(i + 1).trim());
    });
    return map;
  }

  // get(key) returns the Sheet value (string) or undefined. Missing or invalid keys use DEFAULTS.
  function readRules(get) {
    const raw = k => { const v = get ? get(k) : undefined; return v === undefined || v === null || String(v).trim() === '' ? DEFAULTS[k] : String(v).trim(); };
    const num = k => { const n = Number(String(raw(k)).replace(',', '.')); return Number.isFinite(n) ? n : Number(DEFAULTS[k]); };
    const time = k => { const t = t2m(raw(k)); return t === null ? t2m(DEFAULTS[k]) : t; };
    const truckExc = new Map();
    parseExceptions(raw('TRUCK_EXCEPTIONS')).forEach((v, k) => { const o = parseOffset(v, null); if (o) truckExc.set(k, o); });
    const sealExc = new Map();
    parseExceptions(raw('SEAL_EXCEPTIONS')).forEach((v, k) => { const n = parseInt(v, 10); if (Number.isFinite(n)) sealExc.set(k, Math.abs(n)); });
    return {
      turnTruck: num('TURN_TRUCK_OFFSET_MIN'), dayStopTruck: num('DAYSTOP_TRUCK_OFFSET_MIN'), dayStopMinGround: num('DAY_STOP_MIN_GROUND'),
      sealToTruck: num('SEAL_TO_TRUCK_MIN'), sealToTruckWide: num('SEAL_TO_TRUCK_WIDE_MIN'),
      wideAirlines: new Set(listOf(raw('WIDEBODY_AIRLINES'))), wideTypes: listOf(raw('WIDEBODY_TYPES')),
      truckExc, sealExc,
      minRotation: num('MIN_ROTATION_MIN'), threshold: num('RECALC_THRESHOLD_MIN'), tight: num('TIGHT_SLOT_MIN'),
      dayStopMargin: num('DAYSTOP_MARGIN_MIN'), healthGap: num('HEALTH_GAP_MIN'),
      box: {
        threshold: time('BOX_THRESHOLD_ETD'), dOffset: num('BOX_D_OFFSET_MIN'), d1Offset: num('BOX_D1_OFFSET_MIN'),
        d1Cap: time('BOX_D1_CAP'), d1LateSlot: time('BOX_D1_LATE_SLOT'),
      },
    };
  }

  // Widebody: by aircraft type when known (AUTO_AIRCRAFT), otherwise by airline.
  function isWidebody(row, R) {
    const ac = String(row.aircraft || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (ac) return R.wideTypes.some(t => ac.includes(t));
    const n = normFlight(row.flight);
    const codes = [n && n.prefix, row.airlineIata, row.airlineIcao].filter(Boolean).map(x => String(x).toUpperCase());
    return codes.some(c => R.wideAirlines.has(c));
  }

  // Profile: RULE_PROFILE when set, otherwise from the scheduled ground time (STD - STA).
  // No STA (aircraft already on the ground, e.g. arrived the day before): DAYSTOP.
  function profileOf(row, R) {
    const eta = t2m(row.eta);
    let etd = t2m(row.etd);
    if (etd !== null && eta !== null && etd < eta) etd += DAY;
    const ground = eta !== null && etd !== null ? etd - eta : null;
    const manual = String(row.profile || '').trim().toUpperCase().replace(/[\s_-]/g, '');
    if (manual === 'TURN' || manual === 'DAYSTOP') return { profile: manual, source: 'manual', ground, eta, etd };
    if (ground !== null) return { profile: ground >= R.dayStopMinGround ? 'DAYSTOP' : 'TURN', source: 'ground time', ground, eta, etd };
    const dflt = String(row.defaultProfile || '').trim().toUpperCase().replace(/[\s_-]/g, '');
    if (dflt === 'TURN' || dflt === 'DAYSTOP') return { profile: dflt, source: 'airline default', ground, eta, etd };
    return { profile: 'DAYSTOP', source: eta === null ? 'no STA' : 'no STD', ground, eta, etd };
  }

  // Box Time slot from the rule. etd may be >= 1440 (next day). Returns { day, m } or null.
  function boxSlot(etd, seal, R) {
    if (etd === null || etd === undefined) return null;
    const b = R.box;
    if (etd > b.threshold) return seal === null || seal === undefined ? null : { day: 'D', m: seal + b.dOffset };
    if (etd > b.d1Cap) return { day: 'D-1', m: b.d1LateSlot };
    return { day: 'D-1', m: Math.min(etd + b.d1Offset, b.d1Cap) };
  }

  // Full plan of one row. Manual Sealing / Truck in the Sheet win; the rule fills what is empty.
  // row: { flight, eta, etd, sealing, truck, profile, sealToTruck, truckOffset, aircraft, airlineIata, defaultProfile }
  function computeRow(row, R) {
    const p = profileOf(row, R), n = normFlight(row.flight);
    const { eta, etd } = p;
    // Truck rule: TRUCK_OFFSET column, then TRUCK_EXCEPTIONS, then the profile.
    let tr = parseOffset(row.truckOffset, p.profile === 'TURN' ? 'ETA' : 'ETD'), trSrc = 'TRUCK_OFFSET column';
    if (!tr && n && R.truckExc.has(n.norm)) { tr = R.truckExc.get(n.norm); trSrc = 'TRUCK_EXCEPTIONS'; }
    if (!tr) { tr = p.profile === 'TURN' ? { ref: 'ETA', off: R.turnTruck } : { ref: 'ETD', off: R.dayStopTruck }; trSrc = 'profile ' + p.profile; }
    if (tr.ref === 'ETA' && eta === null) { tr = { ref: 'ETD', off: R.dayStopTruck }; trSrc = 'no STA: ETD rule'; }
    const refM = tr.ref === 'ETA' ? eta : etd;
    const truckRule = refM === null ? null : refM + tr.off;
    // Sealing rule: SEAL_TO_TRUCK column, then SEAL_EXCEPTIONS, then widebody / narrowbody.
    const wide = isWidebody(row, R);
    let gap = parseInt(row.sealToTruck, 10), sealSrc = 'SEAL_TO_TRUCK column';
    if (!Number.isFinite(gap)) { gap = n && R.sealExc.has(n.norm) ? R.sealExc.get(n.norm) : null; sealSrc = 'SEAL_EXCEPTIONS'; }
    if (gap === null) { gap = wide ? R.sealToTruckWide : R.sealToTruck; sealSrc = wide ? 'widebody' : 'narrowbody'; }
    gap = Math.abs(gap);
    const truckManual = t2m(row.truck), sealManual = t2m(row.sealing);
    const truck = truckManual !== null ? alignTo(truckManual, truckRule !== null ? truckRule : etd) : truckRule;
    const sealRule = truckRule === null ? null : truckRule - gap;
    const seal = sealManual !== null ? alignTo(sealManual, truck !== null ? truck - gap : etd) : (truck === null ? null : truck - gap);
    const box = boxSlot(etd, seal, R);
    return {
      profile: p.profile, profileSource: p.source, ground: p.ground, eta, etd, wide,
      truck, seal, truckRule, sealRule, box,
      truckSource: truckManual !== null ? 'manual' : 'rule', sealSource: sealManual !== null ? 'manual' : 'rule',
      truckText: tr.ref + ' ' + fmtOffset(tr.off) + ' (' + trSrc + ')',
      sealText: 'Truck ' + fmtOffset(-gap) + ' (' + sealSrc + ')',
      sealGap: gap,
    };
  }

  // A clock time read from the Sheet, placed on the same side of midnight as a reference.
  function alignTo(m, ref) {
    if (ref === null || ref === undefined) return m;
    return ref + diff(m, ref);
  }

  /* ---------- live and simulated changes ---------- */

  // Plan after a live (or simulated) ETA. TURN: Truck, Sealing, ETD and Box Time D slide with the
  // ETA once the delay reaches the threshold. DAYSTOP: nothing moves, the margin is checked.
  // Returns { delay, moved, etd, truck, seal, box, d1Check, marginAlert, reason }.
  function applyEta(plan, etaLive, R) {
    const out = { delay: null, moved: false, eta: etaLive, etd: plan.etd, truck: plan.truck, seal: plan.seal, box: plan.box, d1Check: false, marginAlert: false, reason: '' };
    if (etaLive === null || etaLive === undefined || plan.eta === null) return out;
    const delay = etaLive - plan.eta;
    out.delay = delay;
    if (plan.profile === 'DAYSTOP') {
      out.reason = 'day stop: plan kept';
      if (plan.truck !== null && plan.truck - etaLive < R.dayStopMargin) {
        out.marginAlert = true;
        out.reason = 'day stop: live ETA leaves ' + Math.round(plan.truck - etaLive) + ' min before Truck';
      }
      return out;
    }
    if (Math.abs(delay) < R.threshold) return out;
    out.moved = true;
    out.truck = plan.truck === null ? null : plan.truck + delay;
    out.seal = plan.seal === null ? null : plan.seal + delay;
    out.etd = plan.etd === null ? null : Math.max(plan.etd, etaLive + R.minRotation);
    if (plan.box && plan.box.day === 'D') out.box = { day: 'D', m: plan.box.m + delay };
    else if (plan.box) { out.box = plan.box; out.d1Check = true; }
    out.reason = (delay > 0 ? 'delay +' : 'early ') + Math.round(delay) + ' min';
    return out;
  }

  // Cancelled flight: every event struck, alerts off, Box Time "Hold production".
  function cancelPlan(plan) {
    return Object.assign({}, plan, { cancelled: true, holdProduction: true });
  }

  /* ---------- check against the Sheet ---------- */

  // Rule vs entered values for one row (minutes, rule minus Sheet). override: BoxTime OVERRIDE "HH:MM" or ''.
  function checkRow(row, R, override) {
    const plan = computeRow(row, R);
    const truckSheet = t2m(row.truck), sealSheet = t2m(row.sealing), ov = t2m(override);
    return {
      flight: row.flight, si: row.si, profile: plan.profile, profileSource: plan.profileSource, ground: plan.ground,
      eta: plan.eta, etd: plan.etd,
      truckSheet, truckRule: plan.truckRule, truckGap: diff(plan.truckRule, truckSheet), truckText: plan.truckText,
      sealSheet, sealRule: plan.sealRule, sealGap: diff(plan.sealRule, sealSheet), sealText: plan.sealText,
      boxDay: plan.box ? plan.box.day : '', boxRule: plan.box ? plan.box.m : null, boxOverride: ov, boxGap: plan.box ? diff(plan.box.m, ov) : null,
      wide: plan.wide,
    };
  }

  /* ---------- unit clock ---------- */

  // Minutes the time zone is ahead of UTC at a given instant (Intl, no library).
  function tzOffsetMin(tz, at) {
    try {
      const d = new Date(at), f = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
      const p = Object.fromEntries(f.formatToParts(d).map(x => [x.type, x.value]));
      const asUtc = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour % 24, +p.minute, +p.second);
      return Math.round((asUtc - (d.getTime() - d.getMilliseconds())) / 60000);
    } catch (e) { return null; }
  }
  // now() returns a Date whose local getters read the unit's wall clock (TIMEZONE of the unit).
  const clock = {
    zone: '',
    setZone(tz) { clock.zone = tz && tzOffsetMin(tz, Date.now()) !== null ? tz : ''; },
    shiftMs(at) {
      if (!clock.zone) return 0;
      const unit = tzOffsetMin(clock.zone, at);
      return unit === null ? 0 : (unit + new Date(at).getTimezoneOffset()) * 60000;
    },
    now() { const t = Date.now(); return new Date(t + clock.shiftMs(t)); },
  };

  return {
    DAY, RULE_DEFS, DEFAULTS, t2m, m2t, diff, fmtOffset, normFlight, sameFlight, callsigns, parseOffset, parseExceptions,
    readRules, isWidebody, profileOf, boxSlot, computeRow, applyEta, cancelPlan, checkRow, tzOffsetMin, clock,
  };
});
