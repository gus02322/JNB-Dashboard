// Recompute a whole unit tab with the rule engine and list the gaps with the times entered in the Sheet.
// Usage: node tools/check-unit.mjs UNIT.csv RULES.csv [Airlines.csv] [BoxTime.csv] [UNIT_NAME] > report.json
// CSV files: File > Download > CSV of each tab (nothing is fetched from the network).
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const R = require('../js/rules.js');
const DS = require('../js/data-source.js');

const [unitCsv, rulesCsv, airlinesCsv, boxCsv, unitName = 'UNIT'] = process.argv.slice(2);
if (!unitCsv || !rulesCsv) { console.error('Usage: node tools/check-unit.mjs UNIT.csv RULES.csv [Airlines.csv] [BoxTime.csv] [UNIT_NAME]'); process.exit(1); }
const read = p => (p ? readFileSync(p, 'utf8') : '');
const settings = DS.parseSettings(DS.parseCSV(read(rulesCsv)));
const airlines = DS.parseAirlines(DS.parseCSV(read(airlinesCsv)));
const boxTime = DS.parseBoxTime(DS.parseCSV(read(boxCsv)));
const raw = DS.readUnitRows(DS.parseCSV(read(unitCsv), true));
const built = DS.buildUnit(raw || [], { unit: unitName, defaultUnit: unitName, airlines, settings, boxTime });
const rules = built.rules;
const check = built.rows.map(f => {
  const c = R.checkRow(Object.assign({ si: f.si }, f.input), rules, f.box && f.box.source === 'override' ? R.m2t(f.box.m) : '');
  const t = R.m2t;
  return {
    si: f.si, flight: f.flight, airline: f.airline, active: f.days.length > 0, days: f.days.join(' '),
    eta: f.eta, etd: f.etd, profile: c.profile, profileSource: c.profileSource, ground: c.ground,
    truckSheet: t(c.truckSheet), truckRule: t(c.truckRule), truckGap: c.truckGap, truckText: c.truckText,
    sealSheet: t(c.sealSheet), sealRule: t(c.sealRule), sealGap: c.sealGap, sealText: c.sealText,
    boxDay: c.boxDay, boxOverride: t(c.boxOverride), boxRule: t(c.boxRule), boxGap: c.boxGap,
  };
});
console.log(JSON.stringify({ unit: unitName, check, health: built.health, stats: built.stats }, null, 1));
