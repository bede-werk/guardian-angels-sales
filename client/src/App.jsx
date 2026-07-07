import React, { useEffect, useState } from 'react';
import { api, today, getToken, clearToken } from './api';
import Dashboard from './components/Dashboard';
import Schedule from './components/Schedule';
import Partners from './components/Partners';
import NeedsMapping from './components/NeedsMapping';
import Login from './components/Login';
import ChangePassword from './components/ChangePassword';
import Header from './components/ui/Header';
import Splash from './components/ui/Splash';
import Button from './components/ui/Button';

const TABS = [
  { id: 'dashboard', label: 'Dashboard' },
  { id: 'schedule', label: "Today's Route" },
  { id: 'partners', label: 'Partners' },
  { id: 'mapping', label: 'Needs Mapping' },
];

export default function App() {
  const [tab, setTab] = useState('dashboard');
  const date = today();
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

  if (authLoading) return <Splash />;
  if (!authUser) return <Login onLogin={setAuthUser} />;

  return (
    <div className="app">
      <Header tagline="Sales Visit CRM · Lincoln, NE">
        <div>
          <label className="field">Date</label>
          <div className="static-date">
            {new Date(`${date}T00:00:00`).toLocaleDateString('en-US', {
              weekday: 'long',
              month: 'long',
              day: 'numeric',
              year: 'numeric',
            })}
          </div>
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
