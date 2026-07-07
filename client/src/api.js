// Thin fetch wrapper around the backend API. All calls go through the Vite proxy
// (/api -> localhost:4000 in dev; same-origin in production).
const BASE = '/api';
const TOKEN_KEY = 'ga_auth_token';

export const getToken = () => localStorage.getItem(TOKEN_KEY);
export const setToken = (token) => localStorage.setItem(TOKEN_KEY, token);
export const clearToken = () => localStorage.removeItem(TOKEN_KEY);

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
    let msg = res.statusText;
    try {
      const j = await res.json();
      msg = j.error || msg;
    } catch (_) {
      /* ignore */
    }
    if (res.status === 401) {
      clearToken();
      window.dispatchEvent(new Event('ga:unauthorized'));
    }
    throw new Error(msg);
  }
  if (res.status === 204) return null;
  return res.json();
}

export const api = {
  // Users
  users: () => request('/users'),

  // Partners
  partners: (params = {}) => {
    const q = new URLSearchParams(
      Object.entries(params).filter(([, v]) => v !== '' && v != null)
    ).toString();
    return request(`/partners${q ? `?${q}` : ''}`);
  },
  partner: (id) => request(`/partners/${id}`),
  filters: () => request('/partners/meta/filters'),

  // Schedule
  schedule: (date, userId) =>
    request(`/schedule?date=${date}${userId ? `&userId=${userId}` : ''}`),
  generateSchedule: (body) => request('/schedule/generate', { method: 'POST', body }),
  reorder: (orderedVisitIds) =>
    request('/schedule/reorder', { method: 'PATCH', body: { orderedVisitIds } }),

  // Visits
  createVisit: (body) => request('/visits', { method: 'POST', body }),
  updateVisit: (id, body) => request(`/visits/${id}`, { method: 'PATCH', body }),
  skipVisit: (id) => request(`/visits/${id}/skip`, { method: 'POST' }),
  deleteVisit: (id) => request(`/visits/${id}`, { method: 'DELETE' }),

  // Dashboard
  dashboard: (userId, date) =>
    request(`/dashboard?${userId ? `userId=${userId}&` : ''}${date ? `date=${date}` : ''}`),

  // Notes review ("needs mapping")
  notesReview: () => request('/notes-review?status=pending'),
  notesReviewCount: () => request('/notes-review/count'),
  assignNote: (id, body) => request(`/notes-review/${id}/assign`, { method: 'POST', body }),
  createPartnerFromNote: (id, body) =>
    request(`/notes-review/${id}/create-partner`, { method: 'POST', body }),
  dismissNote: (id, body) => request(`/notes-review/${id}/dismiss`, { method: 'POST', body }),
  createPartner: (body) => request('/partners', { method: 'POST', body }),

  // Auth
  auth: {
    users: () => request('/auth/users'),
    setPassword: (userId, newPassword) =>
      request('/auth/set-password', { method: 'POST', body: { userId, newPassword } }),
    login: (userId, password) =>
      request('/auth/login', { method: 'POST', body: { userId, password } }),
    me: () => request('/auth/me'),
    changePassword: (currentPassword, newPassword) =>
      request('/auth/change-password', { method: 'POST', body: { currentPassword, newPassword } }),
    logout: () => request('/auth/logout', { method: 'POST' }),
  },
};

export const OUTCOME_LABELS = {
  interested: 'Interested',
  not_ready: 'Not ready',
  follow_up: 'Follow up',
  no_answer: 'No answer',
};

export function today() {
  return new Date().toISOString().slice(0, 10);
}
