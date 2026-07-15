import React, { useEffect, useState } from 'react';
import { api, today, formatDate, getToken, clearToken } from './api';
import Dashboard from './components/Dashboard';
import PlanVisits from './components/PlanVisits';
import Places from './components/Places';
import People from './components/People';
import NeedsMapping from './components/NeedsMapping';
import Login from './components/Login';
import ChangePassword from './components/ChangePassword';
import Header from './components/ui/Header';
import Splash from './components/ui/Splash';
import Button from './components/ui/Button';

// The tabs shown in the nav bar under the header. `id` picks which
// component renders below; `label` is the button text.
const TABS = [
  { id: 'dashboard', label: 'Dashboard' },
  { id: 'planner', label: 'Plan My Visits' },
  { id: 'places', label: 'Places' },
  { id: 'people', label: 'People' },
  { id: 'mapping', label: 'Needs Mapping' },
];

// The root component: handles login/session state and renders either the
// Login screen or the main app shell (header + tabs + whichever tab is active).
export default function App() {
  const [tab, setTab] = useState('dashboard'); // which of the 4 tabs is showing
  const date = today(); // always "today" — there's no date picker (see HANDOFF/README)
  const [mappingCount, setMappingCount] = useState(0); // pending "Needs Mapping" count, for the tab badge

  const [authUser, setAuthUser] = useState(null); // the logged-in user, or null if not logged in
  const [authLoading, setAuthLoading] = useState(true); // true while checking for a saved session on load
  const [showChangePassword, setShowChangePassword] = useState(false); // whether the change-password modal is open

  const refreshMappingCount = () =>
    api.notesReviewCount().then((r) => setMappingCount(r.pending)).catch(() => {});

  // If any API call gets a 401 (see api.js), it fires this event — treat it as
  // an instant logout so the app drops back to the login screen.
  useEffect(() => {
    const onUnauthorized = () => setAuthUser(null);
    window.addEventListener('ga:unauthorized', onUnauthorized);
    return () => window.removeEventListener('ga:unauthorized', onUnauthorized);
  }, []);

  // On first load, if there's a saved token, ask the server who it belongs to
  // (GET /api/auth/me) to restore the session without making the user log in again.
  useEffect(() => {
    if (!getToken()) {
      setAuthLoading(false);
      return;
    }
    api.auth.me()
      .then((u) => setAuthUser(u))
      .catch(() => clearToken()) // saved token was invalid/expired — clear it
      .finally(() => setAuthLoading(false));
  }, []);

  // Once we know who's logged in, load the Needs Mapping badge count.
  useEffect(() => {
    if (!authUser) return;
    refreshMappingCount();
  }, [authUser]);

  function logout() {
    api.auth.logout().catch(() => {}); // best-effort — log out locally regardless
    clearToken();
    setAuthUser(null);
  }

  // Three possible screens: branded loading splash, the login form, or the app itself.
  if (authLoading) return <Splash />;
  if (!authUser) return <Login onLogin={setAuthUser} />;

  return (
    <div className="app">
      <Header tagline="Sales Visit CRM · Lincoln, NE">
        <div>
          <label className="field">Date</label>
          <div className="static-date">{formatDate(date)}</div>
        </div>
        <div className="user-menu">
          <label className="field">Signed in as</label>
          <div className="tag-list">
            <span>{authUser.name}</span>
            <Button variant="ghost" size="small" onClick={() => setShowChangePassword(true)}>Change password</Button>
            <Button variant="ghost" size="small" onClick={logout}>Log out</Button>
          </div>
        </div>
      </Header>

      {showChangePassword && <ChangePassword onClose={() => setShowChangePassword(false)} />}

      {/* Tab bar — clicking a tab just swaps which component renders below. */}
      <nav className="tabs">
        {TABS.map((t) => (
          <button key={t.id} className={`tab ${tab === t.id ? 'active' : ''}`} onClick={() => setTab(t.id)}>
            {t.label}
            {t.id === 'mapping' && mappingCount > 0 && <span className="count">{mappingCount}</span>}
          </button>
        ))}
      </nav>

      {/* Only the active tab's component is mounted — the others unmount entirely,
          resetting their state each time you come back to them. */}
      {tab === 'dashboard' && <Dashboard date={date} userId={authUser.id} />}
      {tab === 'planner' && <PlanVisits />}
      {tab === 'places' && <Places userId={authUser.id} />}
      {tab === 'people' && <People userId={authUser.id} />}
      {tab === 'mapping' && <NeedsMapping onChanged={refreshMappingCount} />}
    </div>
  );
}
