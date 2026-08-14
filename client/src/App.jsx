import React, { useEffect, useRef, useState } from 'react';
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
import Button from './components/ui/Button';

// The tabs shown in the nav bar under the header. `id` picks which
// component renders below; `label` is the button text.
const TABS = [
  { id: 'dashboard', label: 'Dashboard' },
  { id: 'planner', label: 'Route Planner' },
  { id: 'calendar', label: 'Calendar' },
  { id: 'places', label: 'Places' },
  { id: 'people', label: 'People' },
];

// Header's account control: click the name to reveal today's date, Change
// password, and Log out. Same custom-dropdown shape as ui/PlacePicker.jsx (a
// ref'd wrapper + a mousedown listener that closes on any outside click).
function UserMenu({ name, date, onLogout, onChangePassword }) {
  const [open, setOpen] = useState(false);
  const boxRef = useRef(null);

  useEffect(() => {
    const onDoc = (e) => { if (boxRef.current && !boxRef.current.contains(e.target)) setOpen(false); };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, []);

  return (
    <div className="user-menu" ref={boxRef}>
      <button className="user-menu-trigger" onClick={() => setOpen((o) => !o)}>
        {name} <span className="caret">▾</span>
      </button>
      {open && (
        <div className="user-menu-dropdown">
          <div className="tiny muted">{date}</div>
          <div className="user-menu-divider" />
          <Button variant="ghost" size="small" onClick={() => { setOpen(false); onChangePassword(); }}>Change password</Button>
          <Button variant="ghost" size="small" onClick={() => { setOpen(false); onLogout(); }}>Log out</Button>
        </div>
      )}
    </div>
  );
}

// The root component: handles login/session state and renders either the
// Login screen or the main app shell (header + tabs + whichever tab is active).
export default function App() {
  const [tab, setTab] = useState('dashboard'); // which of the tabs is showing
  const date = today(); // always "today" — there's no date picker (see HANDOFF/README)
  // The Calendar tab's own "Mine/All reps" toggle, lifted up here (rather
  // than living in VisitsCalendar itself) so it survives switching to
  // another tab and back — VisitsCalendar unmounts entirely when its tab
  // isn't active. Reset on logout so a fresh session always starts on "Mine".
  const [calendarScope, setCalendarScope] = useState('mine');

  const [authUser, setAuthUser] = useState(null); // the logged-in user, or null if not logged in
  const [authLoading, setAuthLoading] = useState(true); // true while checking for a saved session on load
  const [showChangePassword, setShowChangePassword] = useState(false); // whether the change-password modal is open

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

  function logout() {
    api.auth.logout().catch(() => {}); // best-effort — log out locally regardless
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
        <UserMenu
          name={authUser.name}
          date={formatDate(date)}
          onLogout={logout}
          onChangePassword={() => setShowChangePassword(true)}
        />
      </Header>

      {showChangePassword && <ChangePassword onClose={() => setShowChangePassword(false)} />}

      {/* Tab bar — clicking a tab just swaps which component renders below. */}
      <nav className="tabs">
        {TABS.map((t) => (
          <button key={t.id} className={`tab ${tab === t.id ? 'active' : ''}`} onClick={() => setTab(t.id)}>
            {t.label}
          </button>
        ))}
      </nav>

      {/* Only the active tab's component is mounted — the others unmount entirely,
          resetting their state each time you come back to them. */}
      {tab === 'dashboard' && <Dashboard date={date} userId={authUser.id} />}
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
    </div>
  );
}
