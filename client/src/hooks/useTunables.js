import { useEffect, useState } from 'react';
import { api } from '../api';

// Reads the tunable values currently in effect (see the Settings page and
// server/src/config/tunables.js) for screens that need to RESPECT a setting
// without explaining it.
//
// Two things worth knowing about the shape of this hook:
//
// 1. It ships fallbacks. A component that reads a bound has to render
//    something on the very first paint, before any request has come back,
//    and rendering a date picker with `undefined` days of range is worse
//    than briefly rendering it with the shipped default. The fallbacks below
//    must stay equal to the defaults in the matching server config module -
//    they only ever show for the few hundred milliseconds before the fetch
//    lands, but a wrong one there is a real (if brief) wrong answer.
//
// 2. It caches at module scope. Settings change rarely and are read on
//    several screens, so the first component to ask pays for the request and
//    everything mounted afterwards gets the cached copy. Saving on the
//    Settings page calls clearTunablesCache() so the next screen to mount
//    re-reads rather than serving a stale number for the rest of the session.
const FALLBACKS = {
  'planning.MAX_PLAN_DATES': 10,
  'planning.DEFAULT_HOURS_PER_DAY': 4,
  'planning.MAX_DAYS_AHEAD': 7,
  'relationship.RELATIONSHIP_THRESHOLDS.strong': 3.4,
  'relationship.RELATIONSHIP_THRESHOLDS.medium': 1.4,
  // The capacity rating choices and the thresholds they're measured against.
  // The rating screen renders which bucket each choice lands in from these
  // two together, so a wrong fallback here would briefly show a choice in the
  // wrong bucket - keep them equal to server config/scheduling.js.
  'scheduling.CAPACITY_SEED_VALUES.major': 15,
  'scheduling.CAPACITY_SEED_VALUES.strong': 13,
  'scheduling.CAPACITY_SEED_VALUES.steady': 7,
  'scheduling.CAPACITY_SEED_VALUES.occasional': 1,
  'scheduling.CAPACITY_THRESHOLDS.MEDIUM_MIN': 4,
  'scheduling.CAPACITY_THRESHOLDS.HIGH_MIN': 11,
};

let cache = null; // the last fetched values, or null if not fetched yet
let inFlight = null; // the in-progress request, so N components mounting at once make ONE call

export function clearTunablesCache() {
  cache = null;
  inFlight = null;
}

export function useTunables() {
  const [values, setValues] = useState(cache || FALLBACKS);

  useEffect(() => {
    if (cache) {
      setValues(cache);
      return undefined;
    }
    let alive = true;
    inFlight = inFlight || api.settings.values();
    inFlight
      .then((v) => {
        cache = { ...FALLBACKS, ...v };
        if (alive) setValues(cache);
      })
      // A failed settings read must never take a screen down with it - the
      // fallbacks above are a perfectly serviceable answer.
      .catch(() => { inFlight = null; });
    return () => { alive = false; };
  }, []);

  return values;
}
