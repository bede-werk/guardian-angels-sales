// Daily schedule generator.
//
// Goal: fill ~4 hours of a rep's day with the most valuable partners to visit,
// clustered geographically (same side of town / zip) so travel stays low, and
// ordered by priority within the cluster.
//
// Strategy:
//   1. Find partners that still need a first visit (no completed visit) and are not
//      already on this rep's plan for the day.
//   2. Seed the route with the single highest-priority candidate.
//   3. Prefer partners in the seed's region, then the seed's city, then nearest zip,
//      keeping priority as the primary sort — this yields a tight, high-value route.
//   4. Take as many as fit in the time budget.
const knex = require('../db/knex');
const { regionForPartner } = require('./priority');

const DEFAULT_VISIT_MINUTES = 30; // time spent per visit
const DEFAULT_TRAVEL_MINUTES = 15; // assumed travel between clustered stops
const DEFAULT_HOURS = 4;

// How many visits fit in the time budget.
function capacityFor({ hours = DEFAULT_HOURS, visitMinutes = DEFAULT_VISIT_MINUTES, travelMinutes = DEFAULT_TRAVEL_MINUTES }) {
  const perStop = visitMinutes + travelMinutes;
  return Math.max(1, Math.floor((hours * 60) / perStop));
}

function zipNum(zip) {
  const n = parseInt(String(zip || '').slice(0, 5), 10);
  return Number.isFinite(n) ? n : null;
}

// Rank candidates relative to a seed partner so the route stays clustered.
// Lower "distance" ranks first; ties broken by priority then zip proximity.
function clusterSort(candidates, seed) {
  const seedZip = zipNum(seed.zip);
  return [...candidates].sort((a, b) => {
    const region = (p) => (p.region === seed.region ? 0 : 1);
    const city = (p) => (p.city && seed.city && p.city === seed.city ? 0 : 1);
    // Same region first, then same city.
    if (region(a) !== region(b)) return region(a) - region(b);
    if (city(a) !== city(b)) return city(a) - city(b);
    // Within the cluster, highest priority first.
    if (b.priority_score !== a.priority_score) return b.priority_score - a.priority_score;
    // Then nearest zip to the seed to shorten hops.
    const da = seedZip == null ? 0 : Math.abs((zipNum(a.zip) ?? seedZip) - seedZip);
    const db = seedZip == null ? 0 : Math.abs((zipNum(b.zip) ?? seedZip) - seedZip);
    if (da !== db) return da - db;
    return a.name.localeCompare(b.name);
  });
}

// Partners that still need a first visit and aren't already planned for `date`.
async function candidatePartners(date, userId) {
  // Partner ids with a completed visit ever, or already on the plan for this date/user.
  // (Single-column subqueries — Knex wraps these in parentheses for the IN clause.)
  const completed = knex('visits').where({ status: 'completed' }).select('partner_id');
  const plannedToday = knex('visits')
    .where({ scheduled_date: date })
    .modify((qb) => userId && qb.andWhere({ user_id: userId }))
    .select('partner_id');

  return knex('partners')
    .whereNotIn('id', completed)
    .whereNotIn('id', plannedToday)
    .orderBy('priority_score', 'desc')
    .orderBy('name', 'asc');
}

// Build (and persist) a day's route. Returns the created visit rows joined to partners.
async function generateSchedule({ date, userId, hours, visitMinutes, travelMinutes, regenerate = false } = {}) {
  if (!date) throw new Error('date is required (YYYY-MM-DD)');

  const capacity = capacityFor({ hours, visitMinutes, travelMinutes });

  return knex.transaction(async (trx) => {
    // If regenerating, clear the day's *non-completed* visits first (keep logged work).
    if (regenerate) {
      await trx('visits')
        .where({ scheduled_date: date })
        .modify((qb) => userId && qb.andWhere({ user_id: userId }))
        .whereNot({ status: 'completed' })
        .del();
    }

    // If a plan already exists for the day, return it instead of duplicating.
    const existing = await trx('visits')
      .where({ scheduled_date: date })
      .modify((qb) => userId && qb.andWhere({ user_id: userId }));
    if (existing.length > 0) {
      return loadRoute(trx, date, userId);
    }

    // Candidates = partners never completed AND not already on *any* rep's route for
    // this date (so two team members can't be sent to the same partner on the same day).
    const completed = trx('visits').where({ status: 'completed' }).select('partner_id');
    const plannedThisDate = trx('visits').where({ scheduled_date: date }).select('partner_id');
    const candidates = await trx('partners')
      .whereNotIn('id', completed)
      .whereNotIn('id', plannedThisDate)
      .orderBy('priority_score', 'desc')
      .orderBy('name', 'asc');

    if (candidates.length === 0) return [];

    const seed = candidates[0];
    const ordered = clusterSort(candidates, seed).slice(0, capacity);

    const rows = ordered.map((p, i) => ({
      partner_id: p.id,
      user_id: userId || null,
      scheduled_date: date,
      status: 'planned',
      sort_order: i,
    }));
    await trx('visits').insert(rows);

    return loadRoute(trx, date, userId);
  });
}

// Load a day's route with partner details, in route order.
async function loadRoute(db, date, userId) {
  return db('visits as v')
    .join('partners as p', 'p.id', 'v.partner_id')
    .where('v.scheduled_date', date)
    .modify((qb) => userId && qb.andWhere('v.user_id', userId))
    .orderBy('v.sort_order', 'asc')
    .select(
      'v.id as visit_id',
      'v.status',
      'v.sort_order',
      'v.outcome',
      'v.notes',
      'v.contact_name',
      'v.contact_title',
      'v.contact_email',
      'v.contact_phone',
      'v.next_visit_date',
      'v.scheduled_date',
      'v.user_id',
      'p.id as partner_id',
      'p.name',
      'p.category',
      'p.tier',
      'p.is_priority',
      'p.priority_score',
      'p.address',
      'p.city',
      'p.state',
      'p.zip',
      'p.region'
    );
}

module.exports = {
  generateSchedule,
  loadRoute,
  candidatePartners,
  capacityFor,
  clusterSort,
};
