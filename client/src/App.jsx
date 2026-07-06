import React, { useEffect, useState } from 'react';
import { api, today } from './api';
import Dashboard from './components/Dashboard';
import Schedule from './components/Schedule';
import Partners from './components/Partners';

const TABS = [
  { id: 'dashboard', label: 'Dashboard' },
  { id: 'schedule', label: "Today's Route" },
  { id: 'partners', label: 'Partners' },
];

export default function App() {
  const [tab, setTab] = useState('dashboard');
  const [date, setDate] = useState(today());
  const [users, setUsers] = useState([]);
  const [userId, setUserId] = useState(undefined);

  useEffect(() => {
    api.users().then((u) => {
      setUsers(u);
      if (u.length) setUserId(u[0].id);
    }).catch(() => {});
  }, []);

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
          <div>
            <label className="field">Team member</label>
            <select value={userId ?? ''} onChange={(e) => setUserId(Number(e.target.value))}>
              {users.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
            </select>
          </div>
        </div>
      </header>

      <nav className="tabs">
        {TABS.map((t) => (
          <button key={t.id} className={`tab ${tab === t.id ? 'active' : ''}`} onClick={() => setTab(t.id)}>
            {t.label}
          </button>
        ))}
      </nav>

      {tab === 'dashboard' && (
        <Dashboard date={date} userId={userId} onGoToSchedule={() => setTab('schedule')} />
      )}
      {tab === 'schedule' && <Schedule date={date} userId={userId} />}
      {tab === 'partners' && <Partners />}
    </div>
  );
}
