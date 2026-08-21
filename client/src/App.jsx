import React, { useEffect, useState } from 'react';
import { api, today, formatDate, getToken, clearToken } from './api';
import Dashboard from './components/Dashboard';
import RoutePlanner from './components/RoutePlanner';
import VisitsCalendar from './components/VisitsCalendar';
import Places from './components/Places';
import People from './components/People';
import Login from './components/Login';
import ChangePassword from './components/ChangePassword';
import Header from './components/ui/Header';
import Splash from './components/ui/Splash';
import ProfileMenu from './components/ui/ProfileMenu';
import Settings from './components/Settings';

// The tabs shown in the nav bar under the header. `id` picks which
// component renders below; `label` is the button text.
//
// Settings is deliberately NOT in here. It's reached from the gear button in
// the header rather than the tab bar: it's a place you visit occasionally to
// tune how the app behaves, not one of the five screens the daily job runs
// through, and putting it in the row would give it the same standing as
// Dashboard or Places. It still renders in the same slot below, so the tab
// bar stays visible and clicking any tab is the way back out.
const TABS = [
  { id: 'dashboard', label: 'Dashboard' },
  { id: 'planner', label: 'Route Planner' },
  { id: 'calendar', label: 'Calendar' },
  { id: 'places', label: 'Places' },
  { id: 'people', label: 'People' },
];

// The root component: handles login/session state and renders either the
// Login screen or the main app shell (header + tabs + whichever tab is active).
export default function App() {
  const [tab, setTab] = useState('dashboard'); // which of the tabs is showing
  const date = today(); // always "today" - there's no date picker (see HANDOFF/README)
  // The Calendar tab's own "Mine/All reps" toggle, lifted up here (rather
  // than living in VisitsCalendar itself) so it survives switching to
  // another tab and back - VisitsCalendar unmounts entirely when its tab
  // isn't active. Reset on logout so a fresh session always starts on "Mine".
  const [calendarScope, setCalendarScope] = useState('mine');

  const [authUser, setAuthUser] = useState(null); // the logged-in user, or null if not logged in
  const [authLoading, setAuthLoading] = useState(true); // true while checking for a saved session on load
  const [showChangePassword, setShowChangePassword] = useState(false); // whether the change-password modal is open

  // If any API call gets a 401 (see api.js), it fires this event - treat it as
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
      .catch(() => clearToken()) // saved token was invalid/expired - clear it
      .finally(() => setAuthLoading(false));
  }, []);

  function logout() {
    api.auth.logout().catch(() => {}); // best-effort - log out locally regardless
    clearToken();
    setAuthUser(null);
    setCalendarScope('mine');
  }

  // Three possible screens: branded loading splash, the login form, or the app itself.
  if (authLoading) return <Splash />;
  if (!authUser) return <Login onLogin={setAuthUser} />;

  return (
    <div className="app">
      <Header tagline="Sales Visit CRM · Lincoln, NE">
        <button
          type="button"
          className={`settings-trigger ${tab === 'settings' ? 'active' : ''}`}
          onClick={() => setTab('settings')}
          title="Algorithm settings - tune how visits are scheduled and scored"
          aria-label="Algorithm settings"
          aria-current={tab === 'settings' ? 'page' : undefined}
        >
          <span aria-hidden="true">⚙</span>
        </button>
        <ProfileMenu name={authUser.name} date={formatDate(date)} onLogout={logout} />
      </Header>

      {showChangePassword && <ChangePassword onClose={() => setShowChangePassword(false)} />}

      {/* Tab bar - clicking a tab just swaps which component renders below. */}
      <nav className="tabs">
        {TABS.map((t) => (
          <button key={t.id} className={`tab ${tab === t.id ? 'active' : ''}`} onClick={() => setTab(t.id)}>
            {t.label}
          </button>
        ))}
      </nav>

      {/* Only the active tab's component is mounted - the others unmount entirely,
          resetting their state each time you come back to them. */}
      {tab === 'dashboard' && <Dashboard date={date} userId={authUser.id} onNavigateToPlanner={() => setTab('planner')} />}
      {tab === 'planner' && <RoutePlanner userId={authUser.id} />}
      {tab === 'calendar' && (
        <VisitsCalendar
          userId={authUser.id}
          onNavigateToPlanner={() => setTab('planner')}
          scope={calendarScope}
          onScopeChange={setCalendarScope}
        />
      )}
      {tab === 'places' && <Places userId={authUser.id} />}
      {tab === 'people' && <People userId={authUser.id} />}
      {tab === 'settings' && <Settings />}
    </div>
  );
}
