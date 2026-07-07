import React, { useEffect, useState } from 'react';
import { api, today, getToken, clearToken } from './api';
import Dashboard from './components/Dashboard';
import Schedule from './components/Schedule';
import Partners from './components/Partners';
import NeedsMapping from './components/NeedsMapping';
import Login from './components/Login';
import ChangePassword from './components/ChangePassword';

const TABS = [
  { id: 'dashboard', label: 'Dashboard' },
  { id: 'schedule', label: "Today's Route" },
  { id: 'partners', label: 'Partners' },
  { id: 'mapping', label: 'Needs Mapping' },
];

export default function App() {
  const [tab, setTab] = useState('dashboard');
  const [date, setDate] = useState(today());
  const [mappingCount, setMappingCount] = useState(0);

  const [authUser, setAuthUser] = useState(null);
  const [authLoading, setAuthLoading] = useState(true);
  const [showChangePassword, setShowChangePassword] = useState(false);

  const refreshMappingCount = () =>
    api.notesReviewCount().then((r) => setMappingCount(r.pending)).catch(() => {});

  useEffect(() => {
    const onUnauthorized = () => setAuthUser(null);
    window.addEventListener('ga:unauthorized', onUnauthorized);
    return () => window.removeEventListener('ga:unauthorized', onUnauthorized);
  }, []);

  useEffect(() => {
    if (!getToken()) {
      setAuthLoading(false);
      return;
    }
    api.auth.me()
      .then((u) => setAuthUser(u))
      .catch(() => clearToken())
      .finally(() => setAuthLoading(false));
  }, []);

  useEffect(() => {
    if (!authUser) return;
    refreshMappingCount();
  }, [authUser]);

  function logout() {
    api.auth.logout().catch(() => {});
    clearToken();
    setAuthUser(null);
  }

  if (authLoading) return <div className="loading">Loading…</div>;
  if (!authUser) return <Login onLogin={setAuthUser} />;

  return (
    <div className="app">
      <header className="header">
        <div className="brand">
          <div className="logo">GA</div>
          <div>
            <h1>Guardian Angels Homecare</h1>
            <div className="sub">Sales Visit Scheduler · Lincoln, NE</div>
          </div>
        </div>
        <div className="controls">
          <div>
            <label className="field">Date</label>
            <input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
          </div>
          <div className="user-menu">
            <label className="field">Signed in as</label>
            <div className="tag-list">
              <span>{authUser.name}</span>
              <button className="btn ghost small" onClick={() => setShowChangePassword(true)}>Change password</button>
              <button className="btn ghost small" onClick={logout}>Log out</button>
            </div>
          </div>
        </div>
      </header>

      {showChangePassword && <ChangePassword onClose={() => setShowChangePassword(false)} />}

      <nav className="tabs">
        {TABS.map((t) => (
          <button key={t.id} className={`tab ${tab === t.id ? 'active' : ''}`} onClick={() => setTab(t.id)}>
            {t.label}
            {t.id === 'mapping' && mappingCount > 0 && <span className="count">{mappingCount}</span>}
          </button>
        ))}
      </nav>

      {tab === 'dashboard' && (
        <Dashboard date={date} userId={authUser.id} onGoToSchedule={() => setTab('schedule')} />
      )}
      {tab === 'schedule' && <Schedule date={date} userId={authUser.id} />}
      {tab === 'partners' && <Partners />}
      {tab === 'mapping' && <NeedsMapping onChanged={refreshMappingCount} />}
    </div>
  );
}
