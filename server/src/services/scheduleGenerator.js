// Pure multi-day draft schedule generator. No knex, no I/O — same discipline
// as schedulingEngine.js/driveTime.js: query the DB, shape rows into these
// input shapes, call this module. Wires the existing four-tier ranking
// engine and drive-time/packing machinery together: for each working day,
// re-rank the remaining candidate pool against that day's own date, pick a
// zone, pack it via packTimeBlock, then remove every packed place from the
// pool before moving to the next day.
//
// Deliberately out of scope here (see ROUTEPLANNER_PROGRESS.md's phase-4
// notes): within-day proximity resequencing (stops fill in rank order),
// the draft/commit lifecycle, multi-user collision handling, and the
// separate never-drop/flag-only packing function the later live-edit
// recalculation loop will need — packTimeBlock's trim-to-budget/truncating
// behavior is exactly right for this one-time generation fill.

const defaultSchedulingConfig = require('../config/scheduling');
const defaultDriveConfig = require('../config/driveTime');
const defaultVisitTypesConfig = require('../config/visitTypes');
const { rankCandidates } = require('./schedulingEngine');
const { packTimeBlock } = require('./driveTime');

// -- Date helpers: hand-rolled UTC-safe math, same convention as
// schedulingEngine.js's daysSince() — deliberately no dayjs in the pure
// service layer, even though dayjs is used elsewhere in routes/dashboard.js.

function addUTCDays(dateStr, n) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + n);
  return dt.toISOString().slice(0, 10);
}

// 0 (Sunday) .. 6 (Saturday) — JS-native Date.getUTCDay() convention. No ISO
// 1-7 remap: workingWeekdays is a generator input, not a public contract, so
// there's no reason to add a translation step for a value this only needs to
// compare against getUTCDay()'s own output.
function weekdayOf(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

// Returns exactly `daysAhead` 'YYYY-MM-DD' strings, in order, starting the
// day AFTER `today` (today itself is never included), skipping any weekday
// not in `workingWeekdays` (0=Sun..6=Sat) and any date in `exceptionDates`.
function workingDays({ today, daysAhead, workingWeekdays, exceptionDates = [] }) {
  const exceptionSet = new Set(exceptionDates);
  const days = [];
  let cursor = addUTCDays(today, 1);
  while (days.length < daysAhead) {
    if (workingWeekdays.includes(weekdayOf(cursor)) && !exceptionSet.has(cursor)) {
      days.push(cursor);
    }
    cursor = addUTCDays(cursor, 1);
  }
  return days;
}

// Shapes a ranked candidate into packTimeBlock's stop input. Keeps the
// fields needed to read/identify the draft; packTimeBlock spreads these
// through untouched into its output.
function toPackableStop({ place }) {
  return {
    place_id: place.id,
    place_name: place.name,
    region: place.region,
    lat: place.lat,
    lng: place.lng,
    visitType: place.default_visit_type,
    capacity_level: place.capacity_level,
    capacity_status: place.capacity_status,
    relationship_level: place.relationship_level,
  };
}

// Packs one day: filters `candidates` (already ranked) down to `zone`, then
// hands them to packTimeBlock in that same rank order. Does not choose the
// zone or manage the multi-day pool — that's generateDraft's job.
function fillDayFromZone({ candidates, zone, homeBase, budgetMinutes, driveConfig, visitTypesConfig }) {
  const inZone = candidates.filter((c) => c.place.region === zone);
  const stops = inZone.map(toPackableStop);
  return packTimeBlock(stops, { start: homeBase, budgetMinutes, driveConfig, visitTypesConfig });
}

// Top-level orchestrator. For each of `daysAhead` working days: re-ranks the
// remaining pool against THAT DAY'S OWN DATE (not once against `today`) — a
// place whose hard floor lapses by day 3, or a commitment that becomes due
// by day 4, is picked up correctly rather than frozen at today's view of the
// world. Picks a zone (zoneOverrides[date] if given, else the region of the
// top-ranked remaining candidate), packs it via fillDayFromZone, then
// removes every PACKED place from the pool before the next day — candidates
// merely considered (wrong zone, or excluded by budget truncation) remain
// available for a later day.
function generateDraft({ candidates, today, daysAhead, workingWeekdays, exceptionDates, hoursPerDay, homeBase, zoneOverrides = {}, config = {} }) {
  const schedulingConfig = { ...defaultSchedulingConfig, ...(config.scheduling ?? {}) };
  const driveConfig = { ...defaultDriveConfig, ...(config.drive ?? {}) };
  const visitTypesConfig = { ...defaultVisitTypesConfig, ...(config.visitTypes ?? {}) };
  const budgetMinutes = hoursPerDay * 60;

  const dates = workingDays({ today, daysAhead, workingWeekdays, exceptionDates });
  let remaining = candidates; // raw pool; shrinks as places get packed across days

  const days = dates.map((date) => {
    const ranked = rankCandidates(remaining, { today: date, config: schedulingConfig });

    if (ranked.length === 0) {
      return { date, zone: null, stops: [], totalMinutes: 0, remainingMinutes: budgetMinutes };
    }

    const zone = zoneOverrides[date] ?? ranked[0].place.region;
    const { stops, totalMinutes, remainingMinutes } = fillDayFromZone({
      candidates: ranked,
      zone,
      homeBase,
      budgetMinutes,
      driveConfig,
      visitTypesConfig,
    });

    const packedIds = new Set(stops.map((s) => s.place_id));
    remaining = remaining.filter((c) => !packedIds.has(c.place.id));

    return { date, zone, stops, totalMinutes, remainingMinutes };
  });

  return { days };
}

module.exports = {
  workingDays,
  toPackableStop,
  fillDayFromZone,
  generateDraft,
};
