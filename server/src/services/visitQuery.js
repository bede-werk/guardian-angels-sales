// The Visits tab's query engine - GET /api/visits is a search/filter over
// every visit ever recorded, so unlike every other list route in this app
// (places.js/people.js, which return the whole filtered set in one shot)
// this one has to paginate, and its filters have to compose without the
// count/summary numbers drifting from what the page actually shows.
//
// Same pure/impure split as manualVisits.js/conflictDetection.js:
// parseVisitListParams is a plain, synchronous validator (directly
// testable, no DB); applyVisitFilters is the one WHERE-clause builder
// shared by the page query, the total count, and the status summary, so
// those three can never disagree with each other; listVisits/
// summarizeVisits are the thin async layer that actually hits the DB.
const STATUSES = ['planned', 'completed', 'skipped', 'snoozed'];
const ORIGINS = ['manual', 'planner'];
const SORTS = ['date_desc', 'date_asc', 'place_asc', 'rep', 'status'];
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

function badRequest(message) {
  const err = new Error(message);
  err.status = 400;
  return err;
}

// '' and undefined both mean "this filter wasn't set" - same convention
// api.js's client-side helpers use when building a query string (they drop
// empty/undefined params rather than sending them). Treating them
// identically here means a stray `?category=` from a cleared dropdown
// behaves exactly like the param being absent, not like an impossible
// "category is the empty string" filter.
function present(v) {
  return v !== undefined && v !== null && v !== '';
}

function parseCommaList(value, allowed, label) {
  if (!present(value)) return null;
  const parts = String(value).split(',').map((s) => s.trim()).filter(Boolean);
  if (!parts.length) return null;
  for (const p of parts) {
    if (!allowed.includes(p)) throw badRequest(`Unknown ${label} "${p}"`);
  }
  return [...new Set(parts)];
}

function parseDate(value, label) {
  if (!present(value)) return null;
  if (!DATE_RE.test(value)) throw badRequest(`${label} must be in YYYY-MM-DD format`);
  return value;
}

function parseIntParam(value, label) {
  if (!present(value)) return null;
  const n = Number(value);
  if (!Number.isInteger(n)) throw badRequest(`${label} must be an integer`);
  return n;
}

function parseFlag(value) {
  return present(value) && String(value) === '1';
}

// Validates and normalizes raw req.query into the shape applyVisitFilters/
// listVisits/summarizeVisits all read. Throws (err.status = 400) on
// anything malformed rather than silently ignoring it - a mistyped filter
// should fail loudly, not quietly return an unfiltered list.
function parseVisitListParams(query = {}) {
  const status = parseCommaList(query.status, STATUSES, 'status');
  const from = parseDate(query.from, 'from');
  const to = parseDate(query.to, 'to');
  const origin = present(query.origin) ? String(query.origin) : null;
  if (origin && !ORIGINS.includes(origin)) throw badRequest(`Unknown origin "${origin}"`);

  const sort = present(query.sort) ? String(query.sort) : 'date_desc';
  if (!SORTS.includes(sort)) throw badRequest(`Unknown sort "${sort}"`);

  let limit = present(query.limit) ? Number(query.limit) : DEFAULT_LIMIT;
  if (!Number.isFinite(limit)) limit = DEFAULT_LIMIT;
  limit = Math.max(1, Math.min(MAX_LIMIT, Math.trunc(limit)));

  let offset = present(query.offset) ? Number(query.offset) : 0;
  if (!Number.isFinite(offset) || offset < 0) offset = 0;
  offset = Math.trunc(offset);

  return {
    search: present(query.search) ? String(query.search).trim() : null,
    status,
    from,
    to,
    userId: parseIntParam(query.userId, 'userId'),
    plannedBy: parseIntParam(query.plannedBy, 'plannedBy'),
    placeId: parseIntParam(query.placeId, 'placeId'),
    personId: parseIntParam(query.personId, 'personId'),
    category: present(query.category) ? String(query.category) : null,
    tier: parseIntParam(query.tier, 'tier'),
    region: present(query.region) ? String(query.region) : null,
    visitType: present(query.visitType) ? String(query.visitType) : null,
    outcome: present(query.outcome) ? String(query.outcome) : null,
    metWith: present(query.metWith) ? String(query.metWith) : null,
    theyRequested: parseFlag(query.theyRequested),
    origin,
    hasNotes: parseFlag(query.hasNotes),
    madeCommitment: parseFlag(query.madeCommitment),
    sort,
    limit,
    offset,
  };
}

// The one WHERE-clause builder, applied identically to the page query, the
// total count, and the status summary - a hand-rolled second copy of these
// conditions anywhere else is exactly how "showing 50 of 3" bugs happen.
// `qb` is expected to be knex('visits as v') already left-joined to
// `places as p` (on p.id = v.place_id) by the caller, since every caller
// needs that join anyway (for category/tier/region and for place_asc sort).
//
// Every filter that reaches into visit_encounters or place_commitments uses
// whereExists, never a join - joining would fan a trip with N matching
// encounters into N rows, corrupting both the page (duplicate rows) and the
// count/summary (inflated totals). See personId/outcome/metWith/
// theyRequested/madeCommitment/the encounter half of search below.
//
// `params.ignoreStatus` skips the status filter entirely - summarizeVisits
// uses this so the four status counts stay a stable segmented control
// (clicking one narrows the table; it doesn't also change what the other
// three counts say) while listVisits/its total still respect status like
// every other filter.
function applyVisitFilters(qb, params) {
  if (params.search) {
    const like = `%${params.search.toLowerCase()}%`;
    qb.where((outer) => {
      outer
        .whereRaw('LOWER(COALESCE(v.place_name, \'\')) LIKE ?', [like])
        .orWhereRaw('LOWER(COALESCE(p.name, \'\')) LIKE ?', [like])
        .orWhereRaw('LOWER(COALESCE(v.notes, \'\')) LIKE ?', [like])
        .orWhereExists(function () {
          this.select(1)
            .from('visit_encounters as ve')
            .whereRaw('ve.visit_id = v.id')
            .whereRaw('LOWER(COALESCE(ve.person_name, \'\')) LIKE ?', [like]);
        });
    });
  }

  if (params.status && params.status.length && !params.ignoreStatus) {
    qb.whereIn('v.status', params.status);
  }
  if (params.from) qb.where('v.scheduled_date', '>=', params.from);
  if (params.to) qb.where('v.scheduled_date', '<=', params.to);
  if (params.userId != null) qb.where('v.user_id', params.userId);
  if (params.plannedBy != null) qb.where('v.created_by_user_id', params.plannedBy);
  if (params.placeId != null) qb.where('v.place_id', params.placeId);

  // Place-attribute filters run against the LEFT-joined `p` row, so a
  // detached visit (place deleted, v.place_id NULL, p.* all NULL) never
  // matches one of these - that's intended, not an oversight: a category/
  // tier/region filter is asking "of the places I can still describe that
  // way," and a detached visit has no place left to describe. An
  // unfiltered list still shows it (via v.place_name's durable snapshot).
  if (params.category) qb.where('p.category', params.category);
  if (params.tier != null) qb.where('p.tier', params.tier);
  if (params.region) qb.where('p.region', params.region);

  if (params.visitType) qb.where('v.visit_type', params.visitType);
  if (params.hasNotes) qb.whereRaw('COALESCE(v.notes, \'\') != \'\'');

  if (params.origin === 'manual') qb.where('v.planned_manually', true);
  else if (params.origin === 'planner') qb.where((outer) => outer.whereNull('v.planned_manually').orWhere('v.planned_manually', false));

  if (params.personId != null) {
    qb.whereExists(function () {
      this.select(1).from('visit_encounters as ve').whereRaw('ve.visit_id = v.id').where('ve.person_id', params.personId);
    });
  }
  if (params.outcome) {
    qb.whereExists(function () {
      this.select(1).from('visit_encounters as ve').whereRaw('ve.visit_id = v.id').where('ve.outcome', params.outcome);
    });
  }
  if (params.metWith) {
    qb.whereExists(function () {
      this.select(1).from('visit_encounters as ve').whereRaw('ve.visit_id = v.id').where('ve.met_with_type', params.metWith);
    });
  }
  if (params.theyRequested) {
    qb.whereExists(function () {
      this.select(1).from('visit_encounters as ve').whereRaw('ve.visit_id = v.id').where('ve.they_requested', true);
    });
  }
  if (params.madeCommitment) {
    qb.whereExists(function () {
      this.select(1).from('place_commitments as pc').whereRaw('pc.source_visit_id = v.id');
    });
  }

  return qb;
}

// Every sort tiebreaks all the way down to v.id - without that, LIMIT/
// OFFSET pagination can skip or duplicate rows across pages whenever the
// primary sort key has ties (two visits on the same date is the normal
// case, not an edge case).
function applySort(qb, sort) {
  if (sort === 'date_asc') return qb.orderBy('v.scheduled_date', 'asc').orderBy('v.sort_order', 'asc').orderBy('v.id', 'asc');
  if (sort === 'place_asc') {
    return qb
      .orderByRaw('COALESCE(p.name, v.place_name) asc')
      .orderBy('v.scheduled_date', 'desc')
      .orderBy('v.id', 'desc');
  }
  if (sort === 'rep') return qb.orderBy('u.name', 'asc').orderBy('v.scheduled_date', 'desc').orderBy('v.id', 'desc');
  if (sort === 'status') return qb.orderBy('v.status', 'asc').orderBy('v.scheduled_date', 'desc').orderBy('v.id', 'desc');
  // date_desc, the default.
  return qb.orderBy('v.scheduled_date', 'desc').orderBy('v.sort_order', 'asc').orderBy('v.id', 'desc');
}

const ROW_COLUMNS = [
  'v.id', 'v.place_id', 'v.place_name', 'p.category', 'p.tier', 'p.address', 'p.city', 'p.zip',
  'v.user_id', 'u.name as user_name', 'v.scheduled_date', 'v.status', 'v.notes', 'v.visit_type',
  'v.source', 'v.planned_manually', 'v.created_by_user_id', 'creator.name as created_by_name',
  'v.snoozed_until', 'v.actual_duration_minutes', 'v.completed_at', 'v.resolved_at', 'v.sort_order',
];

// The base query every one of listVisits/count/summarizeVisits filters
// against - LEFT joins throughout (never inner) because this app is
// detach-not-delete: a visit outlives its place or its rep being removed,
// and `rep` sort/filter needs the same join `u` provides regardless.
function baseQuery(db) {
  return db('visits as v')
    .leftJoin('places as p', 'p.id', 'v.place_id')
    .leftJoin('users as u', 'u.id', 'v.user_id')
    .leftJoin('users as creator', 'creator.id', 'v.created_by_user_id');
}

async function listVisits(db, params) {
  const rowsQuery = applySort(applyVisitFilters(baseQuery(db), params), params.sort)
    .limit(params.limit)
    .offset(params.offset)
    .select(...ROW_COLUMNS);

  const countRow = await applyVisitFilters(baseQuery(db), params).count('v.id as total').first();

  return {
    visits: await rowsQuery,
    total: Number(countRow?.total) || 0,
    limit: params.limit,
    offset: params.offset,
  };
}

// Status counts ignore the status filter itself (see applyVisitFilters'
// own comment on `ignoreStatus`) so the four numbers stay a stable
// segmented control - clicking "Skipped" narrows the table without also
// changing what "Completed" says next to it. `places` is a distinct count
// over that same status-ignoring set, for the "143 places touched" line.
async function summarizeVisits(db, params) {
  const statusParams = { ...params, ignoreStatus: true };

  const statusRows = await applyVisitFilters(baseQuery(db), statusParams)
    .groupBy('v.status')
    .select('v.status')
    .count('v.id as n');

  const summary = { planned: 0, completed: 0, skipped: 0, snoozed: 0 };
  let total = 0;
  for (const row of statusRows) {
    const n = Number(row.n) || 0;
    if (Object.prototype.hasOwnProperty.call(summary, row.status)) summary[row.status] = n;
    total += n;
  }

  const placesRow = await applyVisitFilters(baseQuery(db), statusParams)
    .whereNotNull('v.place_id')
    .countDistinct('v.place_id as n')
    .first();

  return { ...summary, total, places: Number(placesRow?.n) || 0 };
}

module.exports = {
  STATUSES,
  ORIGINS,
  SORTS,
  parseVisitListParams,
  applyVisitFilters,
  listVisits,
  summarizeVisits,
};
