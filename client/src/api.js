// Thin fetch wrapper around the backend API. All calls go through the Vite proxy
// (/api -> localhost:4000 in dev; same-origin in production).
const BASE = '/api';

async function request(path, options = {}) {
  const res = await fetch(BASE + path, {
    headers: { 'Content-Type': 'application/json' },
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
