/*
 * Ops On Time central configuration.
 * Every product string, URL and feature flag is read from here.
 * Never put a secret in this file: it is served publicly by GitHub Pages.
 */
(function () {
  const SHEET_BASE = 'https://docs.google.com/spreadsheets/d/e/2PACX-1vQKq3odF0k3pgL0sJYP7SZmFNkVVwSun02u79ipbE6qmecOxJinj6iZJxNEhHL0VbHxFYQSqSVQOlxA/pub';

  const CONFIG = {
    PRODUCT_NAME: 'Ops On Time',
    TAGLINE: 'Live catering operations, on one screen.',
    CONTACT_EMAIL: 'TODO@example.com', // TODO: real contact address
    SITE_URL: 'https://example.com',   // TODO: real public URL

    // The Sheet: one tab per unit (JNB, CLIENT_1...). Unit shown: ?unit=<TAB>, else ACTIVE_UNITS of the RULES tab. Read by tab name (gviz CSV,
    // needs "Anyone with the link: Viewer"), then from the published CSV with the gid below.
    SHEET_ID: '1y9gpbgaqLb1ktilolWX7XbwCyu47obmf0NH11m0PscU',
    DEFAULT_UNIT: 'JNB',
    // Published CSV of a tab: SHEET_BASE + '?gid=<gid>&single=true&output=csv'.
    SHEET_BASE_URL: SHEET_BASE,
    // gid of the known tabs, used when the read by name fails. A new tab works by name only.
    SHEET_TAB_GIDS: {
      JNB: '0', CLIENT_1: '2011', CLIENT_2: '2012', CLIENT_3: '2013',
      Airlines: '1001', RULES: '1002', BoxTime: '1003', Airports: '2200', ApiUsage: '2300',
      RULES_JNB: '2101', RULES_CLIENT_1: '2111', RULES_CLIENT_2: '2112', RULES_CLIENT_3: '2113',
    },
    SHEET_REFRESH_MS: 5 * 60 * 1000,

    // Non-versioned fallback file, used only when the Sheet and the cache are both unavailable.
    LOCAL_DATA_URL: 'data/local-data.json',

    // External flight page opened by the Live / History buttons. {code} = ICAO callsign.
    TRACKER_LIVE_URL: 'https://flightaware.com/live/flight/{code}',
    TRACKER_HISTORY_URL: 'https://flightaware.com/live/flight/{code}/history',

    // Feature flags. Off in production until validated.
    // Override on one screen with ?ff=NAME1,NAME2 (remembered on that device), ?ff=none to reset.
    FLAGS: {
      LIVE_ADSB: true,         // phase 2: live estimated ETA / ETD (validated on 5 Oct)
      DIAGNOSTIC: false,       // phase 2: callsign diagnostic panel
      CONFIG_PANEL: true,      // full Config panel: unit, flights and status, rules, data health, sync
      NEW_LOOK: true,          // refreshed visual: lighter background, Inter font, panel closed by default
      DEMO_MODE: true,         // Demo menu entry (simulated delays, cancellations); ?demo=live|lost|never|landed fictive flight
    },
  };

  const FF_KEY = 'anga_ff';
  let overrides = [];
  try {
    const qs = new URLSearchParams(window.location.search).get('ff');
    if (qs !== null) {
      overrides = qs === 'none' ? [] : qs.split(',').map(s => s.trim().toUpperCase()).filter(Boolean);
      localStorage.setItem(FF_KEY, JSON.stringify(overrides));
    } else {
      overrides = JSON.parse(localStorage.getItem(FF_KEY) || '[]');
    }
  } catch (e) { overrides = []; }

  CONFIG.flag = function (name) {
    return overrides.includes(name) || CONFIG.FLAGS[name] === true;
  };
  CONFIG.sheetTabUrl = function (gid) {
    return CONFIG.SHEET_BASE_URL + '?gid=' + encodeURIComponent(gid) + '&single=true&output=csv';
  };

  window.ANGA_CONFIG = CONFIG;
  if (CONFIG.flag('NEW_LOOK')) document.documentElement.classList.add('anga-v2');
})();
