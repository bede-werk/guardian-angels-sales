// Referral metrics — the objective, time-aware replacement for the old manual
// relationship_temp field (hot/warm/cold/dormant). Everything here is derived
// live from the `referrals` table: nothing is stored, nothing needs upkeep.
//
// Three numbers per person (and, rolled up, per place):
//   lifetime_referrals      — total referral rows attributed to them, ever
//   last_referral_date      — the most recent referral_date on file, or null
//   referrals_last_90_days  — how many landed within the trailing 90-day window
// Plus one derived flag:
//   needs_attention — they've referred before (lifetime > 0) but nothing in
//   the last 90 days. A brand-new contact with zero lifetime referrals is
//   just unstarted, not "cooling" — needs_attention stays false for them.

const RECENT_WINDOW_DAYS = 90;

const EMPTY_METRICS = {
  lifetime_referrals: 0,
  last_referral_date: null,
  referrals_last_90_days: 0,
  needs_attention: false,
};

// 'YYYY-MM-DD' cutoff for the recent window, RECENT_WINDOW_DAYS back from
// `now`. referral_date is stored as a plain YYYY-MM-DD string, so a string
// comparison against this cutoff is all a "recent" check needs.
// UTC throughout (not .getDate()/.setDate(), which read/write the host's
// LOCAL calendar day) so the cutoff can't shift by a day depending on the
// server's timezone — same convention schedulingEngine.js's daysSince() uses.
function recentWindowCutoff(now = new Date()) {
  const todayUTC = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return new Date(todayUTC - RECENT_WINDOW_DAYS * 86400000).toISOString().slice(0, 10);
}

// Turns aggregate query rows (see the two batch functions below) into a
// key -> metrics map.
function rowsToMetricsMap(rows, keyField) {
  const byKey = {};
  for (const r of rows) {
    const lifetime = Number(r.lifetime_referrals);
    const last90 = Number(r.referrals_last_90_days);
    byKey[r[keyField]] = {
      lifetime_referrals: lifetime,
      last_referral_date: r.last_referral_date || null,
      referrals_last_90_days: last90,
      needs_attention: lifetime > 0 && last90 === 0,
    };
  }
  return byKey;
}

// Looks up one id's metrics from a batch map, defaulting to "none yet" (not
// needs_attention) for an id with no referral rows at all.
function metricsFor(byKey, id) {
  return byKey[id] || EMPTY_METRICS;
}

// Batch per-person metrics: person_id -> metrics, one query for every id in
// `personIds`. Used by the People directory and a place's roster.
async function referralMetricsByPersonId(knex, personIds, now = new Date()) {
  if (!personIds.length) return {};
  const cutoff = recentWindowCutoff(now);
  const rows = await knex('referrals')
    .whereIn('person_id', personIds)
    .groupBy('person_id')
    .select(
      'person_id',
      knex.raw('COUNT(*) as lifetime_referrals'),
      knex.raw('MAX(referral_date) as last_referral_date'),
      knex.raw('SUM(CASE WHEN referral_date >= ? THEN 1 ELSE 0 END) as referrals_last_90_days', [cutoff])
    );
  return rowsToMetricsMap(rows, 'person_id');
}

// Batch per-place metrics, rolled up across each place's *current* people —
// same "live membership, not the referral's own place_id snapshot" rule the
// old referral_total used (see routes/places.js). Used by the places directory.
async function referralMetricsByPlaceId(knex, placeIds, now = new Date()) {
  if (!placeIds.length) return {};
  const cutoff = recentWindowCutoff(now);
  const rows = await knex('referrals as r')
    .join('people as pe', 'pe.id', 'r.person_id')
    .whereIn('pe.place_id', placeIds)
    .groupBy('pe.place_id')
    .select(
      'pe.place_id',
      knex.raw('COUNT(*) as lifetime_referrals'),
      knex.raw('MAX(r.referral_date) as last_referral_date'),
      knex.raw('SUM(CASE WHEN r.referral_date >= ? THEN 1 ELSE 0 END) as referrals_last_90_days', [cutoff])
    );
  return rowsToMetricsMap(rows, 'place_id');
}

// For a single entity whose referral rows are already in hand (e.g. a person
// detail page that already fetched its own `referrals` array) — computes the
// same three metrics without a second query.
function summarizeReferralDates(dates, now = new Date()) {
  const lifetime = dates.length;
  const dated = dates.filter(Boolean).sort(); // 'YYYY-MM-DD' sorts chronologically as a string
  const cutoff = recentWindowCutoff(now);
  const last90 = dated.filter((d) => d >= cutoff).length;
  return {
    lifetime_referrals: lifetime,
    last_referral_date: dated.length ? dated[dated.length - 1] : null,
    referrals_last_90_days: last90,
    needs_attention: lifetime > 0 && last90 === 0,
  };
}

module.exports = {
  EMPTY_METRICS,
  recentWindowCutoff,
  referralMetricsByPersonId,
  referralMetricsByPlaceId,
  summarizeReferralDates,
  metricsFor,
};
