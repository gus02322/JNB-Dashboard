/*
 * ANGA central configuration.
 * Every product string, URL and feature flag is read from here.
 * Never put a secret in this file: it is served publicly by GitHub Pages.
 */
(function () {
  const SHEET_BASE = 'https://docs.google.com/spreadsheets/d/e/2PACX-1vQKq3odF0k3pgL0sJYP7SZmFNkVVwSun02u79ipbE6qmecOxJinj6iZJxNEhHL0VbHxFYQSqSVQOlxA/pub';

  const CONFIG = {
    PRODUCT_NAME: 'ANGA',
    TAGLINE: 'Live catering operations, on one screen.',
    CONTACT_EMAIL: 'TODO@example.com', // TODO: real contact address
    SITE_URL: 'https://example.com',   // TODO: real public URL

    // Main flights tab (published CSV, first tab of the document).
    SHEET_CSV_URL: SHEET_BASE + '?output=csv',
    // Published CSV of another tab: SHEET_BASE + '?gid=<gid>&single=true&output=csv'.
    SHEET_BASE_URL: SHEET_BASE,
    // gid of each tab. null = tab not configured yet (the app falls back to cache or local file).
    SHEET_GIDS: {
      airlines: '1001', // "Airlines" tab
      config: '1002',   // "Config" tab
      boxTime: '1003',  // "BoxTime" tab
      audit: '1004',    // "Audit" tab (phase 4)
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
      BOX_TIME_FORMULA: false, // phase 2: Box Time default from the timing rule
      DIAGNOSTIC: false,       // phase 2: callsign diagnostic panel
      CONFIG_PANEL: false,     // phase 4: online configuration panel
      NEW_LOOK: false,         // refreshed visual: lighter background, Inter font, panel closed by default
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
