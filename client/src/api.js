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
    try {
      const j = await res.json();
      msg = j.error || msg;
    } catch (_) {
      /* ignore */
    }
    if (res.status === 401) {
      // The token is missing/invalid/expired — clear it and tell App.jsx to
      // drop back to the login screen (it listens for this event).
      clearToken();
      window.dispatchEvent(new Event('ga:unauthorized'));
    }
    throw new Error(msg);
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
  createPlace: (body) => request('/places', { method: 'POST', body }),
  updatePlace: (id, body) => request(`/places/${id}`, { method: 'PATCH', body }),
  deletePlace: (id) => request(`/places/${id}`, { method: 'DELETE' }),

  // Today's Route — server/src/routes/schedule.js
  schedule: (date, userId) =>
    request(`/schedule?date=${date}${userId ? `&userId=${userId}` : ''}`),
  generateSchedule: (body) => request('/schedule/generate', { method: 'POST', body }),
  reorder: (orderedVisitIds) =>
    request('/schedule/reorder', { method: 'PATCH', body: { orderedVisitIds } }),

  // Visits (logging a call) — server/src/routes/visits.js
  createVisit: (body) => request('/visits', { method: 'POST', body }),
  updateVisit: (id, body) => request(`/visits/${id}`, { method: 'PATCH', body }),
  skipVisit: (id) => request(`/visits/${id}/skip`, { method: 'POST' }),
  deleteVisit: (id) => request(`/visits/${id}`, { method: 'DELETE' }),

  // Dashboard rollup — server/src/routes/dashboard.js
  dashboard: (userId, date) =>
    request(`/dashboard?${userId ? `userId=${userId}&` : ''}${date ? `date=${date}` : ''}`),

  // Notes review ("Needs Mapping") — server/src/routes/notesReview.js
  notesReview: () => request('/notes-review?status=pending'),
  notesReviewCount: () => request('/notes-review/count'), // pending count for the tab badge
  assignNote: (id, body) => request(`/notes-review/${id}/assign`, { method: 'POST', body }),
  createPlaceFromNote: (id, body) =>
    request(`/notes-review/${id}/create-place`, { method: 'POST', body }),
  dismissNote: (id, body) => request(`/notes-review/${id}/dismiss`, { method: 'POST', body }),

  // People — server/src/routes/people.js
  people: {
    // Cross-place People directory tab. params: search, placeId, category, neverContacted, needsAttention
    list: (params = {}) => {
      const q = new URLSearchParams(
        Object.entries(params).filter(([, v]) => v !== '' && v != null)
      ).toString();
      return request(`/people${q ? `?${q}` : ''}`);
    },
    get: (id) => request(`/people/${id}`), // a person + their place + full visit history
    listForPlace: (placeId) => request(`/places/${placeId}/people`),
    create: (body) => request('/people', { method: 'POST', body }), // place_id in body is optional
    update: (id, body) => request(`/people/${id}`, { method: 'PATCH', body }),
    remove: (id) => request(`/people/${id}`, { method: 'DELETE' }),
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
    reorderDay: (draftId, date, placeIds) =>
      request(`/schedule-drafts/${draftId}/days/${date}/reorder`, { method: 'PATCH', body: { placeIds } }),
    addStop: (draftId, date, placeId, visitType) =>
      request(`/schedule-drafts/${draftId}/days/${date}/stops`, { method: 'POST', body: { placeId, visitType } }),
    removeStop: (draftId, date, placeId) =>
      request(`/schedule-drafts/${draftId}/days/${date}/stops/${placeId}`, { method: 'DELETE' }),
    setVisitType: (draftId, date, placeId, visitType) =>
      request(`/schedule-drafts/${draftId}/days/${date}/stops/${placeId}`, { method: 'PATCH', body: { visitType } }),
  },

  // Address -> coordinates, for the route planner's manual-location fallback
  // when browser geolocation is denied/unavailable — server/src/routes/geocode.js
  geocode: (body) => request('/geocode', { method: 'POST', body }),

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

// Display labels for the visit outcome enum (server/src/routes/visits.js's OUTCOMES).
export const OUTCOME_LABELS = {
  interested: 'Interested',
  not_ready: 'Not ready',
  follow_up: 'Follow up',
  no_answer: 'No answer',
  left_materials: 'Left materials',
};

// Display labels for a person's role_type enum (server/src/routes/people.js's ROLE_TYPES).
export const ROLE_TYPE_LABELS = {
  decision_maker: 'Decision maker',
  gatekeeper: 'Gatekeeper',
  champion: 'Champion',
  other: 'Other',
};

// Display labels for a draft stop's visit type (server/src/config/visitTypes.js's VISIT_TYPES).
export const VISIT_TYPE_LABELS = {
  drop_in: 'Drop-in',
  check_in: 'Check-in',
  working_visit: 'Working visit',
  presentation: 'Presentation / in-service',
  pre_qualification: 'Pre-qualification',
};

// Today's date as 'YYYY-MM-DD', matching how dates are stored/compared everywhere else.
export function today() {
  return new Date().toISOString().slice(0, 10);
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
