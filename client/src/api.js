// Thin fetch wrapper around the backend API. All calls go through the Vite proxy
// (/api -> localhost:4000 in dev; same-origin in production).
// Every component in the app imports `api` from here rather than calling
// fetch() directly, so auth headers/error handling stay in one place.
const BASE = '/api';
const TOKEN_KEY = 'ga_auth_token'; // localStorage key the session token is saved under

// Read/write/clear the saved login token. Login.jsx calls setToken() on
// success; App.jsx calls getToken() on load to check if there's a saved
// session; logout (and a 401 response, see below) calls clearToken().
export const getToken = () => localStorage.getItem(TOKEN_KEY);
export const setToken = (token) => localStorage.setItem(TOKEN_KEY, token);
export const clearToken = () => localStorage.removeItem(TOKEN_KEY);

// The one function that actually calls fetch(). Every method in `api` below
// is a small wrapper around this. Automatically attaches the saved auth
// token (if any) and turns a JSON `body` option into a real request body.
async function request(path, options = {}) {
  const token = getToken();
  const res = await fetch(BASE + path, {
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    ...options,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  if (!res.ok) {
    // Try to pull the backend's { error: "..." } message out of the response;
    // fall back to the plain HTTP status text if the body isn't JSON.
    let msg = res.statusText;
    let code;
    let conflicts;
    try {
      const j = await res.json();
      msg = j.error || msg;
      code = j.code;
      // Structured, named/dated collision detail (see
      // server/src/services/conflictDetection.js's Conflict shape) — carried
      // by addStop/POST-visits 409s so a caller can render every applicable
      // notice instead of just the one summary string in `error`.
      conflicts = j.conflicts;
    } catch (_) {
      /* ignore */
    }
    if (res.status === 401) {
      // The token is missing/invalid/expired — clear it and tell App.jsx to
      // drop back to the login screen (it listens for this event).
      clearToken();
      window.dispatchEvent(new Event('ga:unauthorized'));
    }
    const err = new Error(msg);
    if (code) err.code = code;
    if (conflicts) err.conflicts = conflicts;
    throw err;
  }
  if (res.status === 204) return null; // no body (e.g. a successful DELETE)
  return res.json();
}

// Every function below is grouped by the backend route file it talks to
// (see server/src/routes/*.js) and just builds the URL/body for `request()`.
export const api = {
  // Places — server/src/routes/places.js
  places: (params = {}) => {
    // Turns { search: 'foo', tier: 1 } into "?search=foo&tier=1", dropping
    // any empty/undefined filter so it doesn't get sent at all.
    const q = new URLSearchParams(
      Object.entries(params).filter(([, v]) => v !== '' && v != null)
    ).toString();
    return request(`/places${q ? `?${q}` : ''}`);
  },
  place: (id) => request(`/places/${id}`),
  filters: () => request('/places/meta/filters'), // distinct categories/regions for the filter dropdowns
  checkAddress: (params = {}) => {
    const q = new URLSearchParams(
      Object.entries(params).filter(([, v]) => v !== '' && v != null)
    ).toString();
    return request(`/places/check-address${q ? `?${q}` : ''}`);
  },
  checkDuplicatePlace: (params = {}) => {
    const q = new URLSearchParams(
      Object.entries(params).filter(([, v]) => v !== '' && v != null)
    ).toString();
    return request(`/places/check-duplicate${q ? `?${q}` : ''}`);
  },
  createPlace: (body) => request('/places', { method: 'POST', body }),
  updatePlace: (id, body) => request(`/places/${id}`, { method: 'PATCH', body }),
  deletePlace: (id) => request(`/places/${id}`, { method: 'DELETE' }),

  // Visits (logging a call) — server/src/routes/visits.js
  // A visit is a TRIP (place, date, rep, notes); who was met lives in its
  // `encounters` array. List endpoints return a lightweight summary of that
  // array; `visit(id)` is the only call that returns every encounter in full.
  visit: (id) => request(`/visits/${id}`),
  createVisit: (body) => request('/visits', { method: 'POST', body }),
  updateVisit: (id, body) => request(`/visits/${id}`, { method: 'PATCH', body }),
  deleteVisit: (id) => request(`/visits/${id}`, { method: 'DELETE' }),
  // Removes ONE person/category from a trip. If it was the last encounter on
  // a completed trip the server deletes the trip too — callers must confirm
  // that with the user first (see VisitDetailModal).
  deleteVisitEncounter: (visitId, encounterId) =>
    request(`/visits/${visitId}/encounters/${encounterId}`, { method: 'DELETE' }),
  visitsCalendar: (month, userId) => request(`/visits/calendar?month=${month}${userId ? `&userId=${userId}` : ''}`),

  // Dashboard rollup — server/src/routes/dashboard.js
  dashboard: (userId, date) =>
    request(`/dashboard?${userId ? `userId=${userId}&` : ''}${date ? `date=${date}` : ''}`),

  // People — server/src/routes/people.js
  people: {
    // Cross-place People directory tab. params: search, placeId, category, sort
    list: (params = {}) => {
      const q = new URLSearchParams(
        Object.entries(params).filter(([, v]) => v !== '' && v != null)
      ).toString();
      return request(`/people${q ? `?${q}` : ''}`);
    },
    get: (id) => request(`/people/${id}`), // a person + their place + full visit history
    listForPlace: (placeId) => request(`/places/${placeId}/people`),
    checkDuplicate: (name) => request(`/people/check-duplicate?name=${encodeURIComponent(name)}`),
    create: (body) => request('/people', { method: 'POST', body }), // place_id in body is optional
    update: (id, body) => request(`/people/${id}`, { method: 'PATCH', body }),
    remove: (id) => request(`/people/${id}`, { method: 'DELETE' }),
    birthdays: (month) => request(`/people/birthdays?month=${month}`), // month is 1-12; Calendar tab's birthday badges
    // One-time relationship seeding (see the Seed Relationships screen).
    // Body: [{ person_id, seed }] — a null/'' seed clears that person's.
    // All-or-nothing server-side; re-runnable (re-seeding resets the decay clock).
    seedRelationships: (entries) => request('/people/seed-relationships', { method: 'POST', body: entries }),
  },

  // Referrals — server/src/routes/referrals.js
  referrals: {
    create: (body) => request('/referrals', { method: 'POST', body }),
    update: (id, body) => request(`/referrals/${id}`, { method: 'PATCH', body }),
    remove: (id) => request(`/referrals/${id}`, { method: 'DELETE' }),
  },

  // Route planner draft/commit lifecycle — server/src/routes/scheduleDrafts.js
  scheduleDrafts: {
    generate: (body) => request('/schedule-drafts/generate', { method: 'POST', body }),
    active: () => request('/schedule-drafts/active'),
    committedDates: () => request('/schedule-drafts/committed-dates'),
    committedDayVisits: (date) => request(`/schedule-drafts/committed-dates/${date}/visits`),
    deleteCommittedDay: (date) => request(`/schedule-drafts/committed-dates/${date}`, { method: 'DELETE' }),
    discard: (draftId) => request(`/schedule-drafts/${draftId}`, { method: 'DELETE' }),
    discardDay: (draftId, date) => request(`/schedule-drafts/${draftId}/days/${date}`, { method: 'DELETE' }),
    reorderDay: (draftId, date, placeIds) =>
      request(`/schedule-drafts/${draftId}/days/${date}/reorder`, { method: 'PATCH', body: { placeIds } }),
    addStop: (draftId, date, placeId, visitType) =>
      request(`/schedule-drafts/${draftId}/days/${date}/stops`, { method: 'POST', body: { placeId, visitType } }),
    removeStop: (draftId, date, placeId) =>
      request(`/schedule-drafts/${draftId}/days/${date}/stops/${placeId}`, { method: 'DELETE' }),
    setVisitType: (draftId, date, placeId, visitType) =>
      request(`/schedule-drafts/${draftId}/days/${date}/stops/${placeId}`, { method: 'PATCH', body: { visitType } }),
    reoptimizeDay: (draftId, date) =>
      request(`/schedule-drafts/${draftId}/days/${date}/reoptimize`, { method: 'POST' }),
    getDayZones: (draftId, date) =>
      request(`/schedule-drafts/${draftId}/days/${date}/zones`),
    selectZone: (draftId, date, zone) =>
      request(`/schedule-drafts/${draftId}/days/${date}/zone`, { method: 'POST', body: { zone } }),
    getSuggestions: (draftId, date) =>
      request(`/schedule-drafts/${draftId}/days/${date}/suggestions`),
    commitDay: (draftId, date) =>
      request(`/schedule-drafts/${draftId}/days/${date}/commit`, { method: 'POST' }),
    commitAll: (draftId) =>
      request(`/schedule-drafts/${draftId}/commit`, { method: 'POST' }),
    reopenDay: (date, homeBase) =>
      request(`/schedule-drafts/days/${date}/reopen`, { method: 'POST', body: { homeBase } }),
  },

  // Categories (add/rename/retire a place category) — server/src/routes/categories.js
  categories: {
    list: () => request('/categories'), // [{ id, name, place_count }], alphabetical
    create: (name) => request('/categories', { method: 'POST', body: { name } }),
    rename: (id, name) => request(`/categories/${id}`, { method: 'PATCH', body: { name } }),
    remove: (id) => request(`/categories/${id}`, { method: 'DELETE' }), // { deleted, affectedPlaces }
  },

  // Team members — server/src/routes/users.js
  users: {
    list: () => request('/users'),
  },

  // Auth (login/logout/password) — server/src/routes/auth.js
  auth: {
    users: () => request('/auth/users'), // list for the login picker (name + hasPassword only)
    setPassword: (userId, newPassword) =>
      request('/auth/set-password', { method: 'POST', body: { userId, newPassword } }),
    login: (userId, password) =>
      request('/auth/login', { method: 'POST', body: { userId, password } }),
    me: () => request('/auth/me'), // restores a session from a saved token on app load
    changePassword: (currentPassword, newPassword) =>
      request('/auth/change-password', { method: 'POST', body: { currentPassword, newPassword } }),
    logout: () => request('/auth/logout', { method: 'POST' }),
  },
};

// Display labels for the visit outcome enum (server/src/routes/visits.js's
// OUTCOMES). These six replaced the original evaluative set
// (interested/not_ready/follow_up/no_answer/left_materials) — they describe
// what OBSERVABLY happened rather than how it felt, which is what makes them
// safe to score a relationship against without inflating over time.
// Ordered strongest-signal-first, which is also the order they're offered in
// the picker.
export const OUTCOME_LABELS = {
  substantive: 'Substantive conversation',
  introduced_new: 'Introduced to someone new',
  brief: 'Brief exchange',
  materials_only: 'Left materials only',
  unavailable: 'They were unavailable',
  declined: 'Not interested right now',
};

// Any outcome string not in the map above is a pre-cutover value still on an
// old row. Rendered as-is (prettified) rather than blank, so historical
// visits stay readable instead of looking corrupted.
export function outcomeLabel(outcome) {
  if (!outcome) return null;
  return OUTCOME_LABELS[outcome] || String(outcome).replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase());
}

// Who the rep actually spoke to (server/src/routes/visits.js's MET_WITH_TYPES).
// The single biggest input to relationship scoring — only 'named_person'
// builds an individual's score, so this is deliberately asked as a required
// question rather than inferred from whether a person happened to be picked.
export const MET_WITH_LABELS = {
  named_person: 'A specific person',
  staff: 'A staff member (name unknown)',
  receptionist: 'Receptionist or front desk',
  nobody: 'Nobody — drop-off',
};

// Display labels for a computed relationship level (services/relationship.js).
export const RELATIONSHIP_LABELS = {
  strong: 'Strong',
  medium: 'Medium',
  weak: 'Weak',
};


// Display labels for a draft stop's visit type (server/src/config/visitTypes.js's VISIT_TYPES).
export const VISIT_TYPE_LABELS = {
  drop_in: 'Drop-in',
  check_in: 'Check-in',
  working_visit: 'Working visit',
  presentation: 'Presentation / in-service',
  pre_qualification: 'Pre-qualification',
};

// Planned minutes per visit type — a MIRROR of server/src/config/visitTypes.js's
// VISIT_TYPES[*].minutes, used only to prefill the "how long did it actually
// take?" field so the rep is correcting a sensible number instead of typing
// into a blank. Keep in sync with that file (same standing arrangement as
// VISIT_TYPE_LABELS mirroring its keys). Nothing is computed from this
// client-side — the server never reads it back.
export const VISIT_TYPE_MINUTES = {
  drop_in: 7,
  check_in: 18,
  working_visit: 30,
  presentation: 60,
  pre_qualification: 15,
};

// Today's date as 'YYYY-MM-DD', matching how dates are stored/compared everywhere else.
export function today() {
  return new Date().toISOString().slice(0, 10);
}

// Month names for the birthday picker (PersonModal.jsx/PersonDetail.jsx) and
// the Calendar tab's birthday badges — a separate array from
// ui/MonthCalendar.jsx's own internal one rather than a refactor of that
// working file, same small-duplication tradeoff as VISIT_TYPE_LABELS above.
export const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

// Birthdays have no year on file (often unknown), so this is generic per
// month rather than leap-year-aware for a specific year — February is
// capped at 29 so a leap-day birthday can still be entered.
const DAYS_IN_MONTH = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
export function daysInMonth(month) {
  return DAYS_IN_MONTH[month - 1] || 31;
}

// Formats a 'YYYY-MM-DD' date string as 'M/D/YYYY' for display (no leading
// zeros on month/day). Dates are stored/compared as 'YYYY-MM-DD' throughout
// the app (see today() above) — this is only for rendering, never for
// <input type="date"> values.
export function formatDate(dateStr) {
  if (!dateStr) return dateStr;
  const [year, month, day] = dateStr.slice(0, 10).split('-');
  if (!year || !month || !day) return dateStr;
  return `${Number(month)}/${Number(day)}/${year}`;
}

// Phrases a `crossRepFloorWarning` ({ userName, scheduledDate, status }) —
// shared by every surface that renders one (PlaceDetail, VisitDetailModal,
// PlannedDayModal, CompletedVisitsModal, UpcomingVisitDetailModal,
// RoutePlanner) so the tense always matches reality: a completed visit is a
// past fact ("visited... on"), a planned one is still upcoming
// ("planned... for") — using one sentence for both misrepresents whichever
// one it doesn't match.
export function crossRepFloorWarningText(warning) {
  if (!warning) return '';
  return warning.status === 'planned'
    ? `Also planned by ${warning.userName} for ${formatDate(warning.scheduledDate)}`
    : `Also visited by ${warning.userName} on ${formatDate(warning.scheduledDate)}`;
}

// Shared by Login.jsx (first-time password setup) and ChangePassword.jsx.
// Returns an error string, or null if the new/confirm pair is valid.
export const MIN_PASSWORD_LENGTH = 6;
export function passwordError(newPassword, confirmPassword, label = 'Password') {
  if (newPassword.length < MIN_PASSWORD_LENGTH) {
    return `${label} must be at least ${MIN_PASSWORD_LENGTH} characters`;
  }
  if (newPassword !== confirmPassword) {
    return `${label}s do not match`;
  }
  return null;
}

// A Google Maps directions link, so "Navigate" hands off to Apple/Google Maps.
export function navigateUrl(place) {
  const dest = [place.address, place.city, place.state, place.zip].filter(Boolean).join(', ');
  return `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(dest)}`;
}
