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
  // Users (team members) — server/src/routes/users.js
  users: () => request('/users'),

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
  filters: () => request('/places/meta/filters'), // distinct categories/cities/zips for the filter dropdowns
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
    remove: (id) => request(`/referrals/${id}`, { method: 'DELETE' }),
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

// Today's date as 'YYYY-MM-DD', matching how dates are stored/compared everywhere else.
export function today() {
  return new Date().toISOString().slice(0, 10);
}

// A Google Maps directions link, so "Navigate" hands off to Apple/Google Maps.
export function navigateUrl(place) {
  const dest = [place.address, place.city, place.state, place.zip].filter(Boolean).join(', ');
  return `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(dest)}`;
}
