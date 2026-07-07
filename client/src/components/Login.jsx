import React, { useEffect, useState } from 'react';
import { api, setToken } from '../api';

const MIN_PASSWORD_LENGTH = 6;

// Auth landing page: pick your name, then either log in (if you already have a
// password) or create one (first time). Calls onLogin({ user }) once signed in.
export default function Login({ onLogin }) {
  const [users, setUsers] = useState([]);
  const [userId, setUserId] = useState('');
  const [password, setPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [loadingUsers, setLoadingUsers] = useState(true);

  useEffect(() => {
    api.auth.users()
      .then((u) => {
        setUsers(u);
        if (u.length) setUserId(String(u[0].id));
      })
      .catch((e) => setError(e.message))
      .finally(() => setLoadingUsers(false));
  }, []);

  const selected = users.find((u) => String(u.id) === String(userId));

  function selectUser(id) {
    setUserId(id);
    setPassword('');
    setNewPassword('');
    setConfirmPassword('');
    setError(null);
  }

  async function submitLogin(e) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const { token, user } = await api.auth.login(Number(userId), password);
      setToken(token);
      onLogin(user);
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  async function submitCreatePassword(e) {
    e.preventDefault();
    setError(null);
    if (newPassword.length < MIN_PASSWORD_LENGTH) {
      setError(`Password must be at least ${MIN_PASSWORD_LENGTH} characters`);
      return;
    }
    if (newPassword !== confirmPassword) {
      setError('Passwords do not match');
      return;
    }
    setBusy(true);
    try {
      const { token, user } = await api.auth.setPassword(Number(userId), newPassword);
      setToken(token);
      onLogin(user);
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="auth-page">
      <div className="card auth-card">
        <div className="card-body">
          <div className="brand auth-brand">
            <div className="logo">GA</div>
            <div>
              <h1>Guardian Angels Homecare</h1>
              <div className="sub">Sales Visit Scheduler · Lincoln, NE</div>
            </div>
          </div>

          {error && <div className="error-banner">{error}</div>}

          {loadingUsers ? (
            <div className="loading">Loading…</div>
          ) : (
            <>
              <div>
                <label className="field">Who's logging in?</label>
                <select value={userId} onChange={(e) => selectUser(e.target.value)}>
                  {users.map((u) => (
                    <option key={u.id} value={u.id}>{u.name}</option>
                  ))}
                </select>
              </div>

              {selected?.hasPassword ? (
                <form onSubmit={submitLogin} className="stack" style={{ gap: 14, marginTop: 14 }}>
                  <div>
                    <label className="field">Password</label>
                    <input
                      type="password"
                      autoFocus
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                    />
                  </div>
                  <button className="btn" type="submit" disabled={busy || !password}>
                    {busy ? 'Logging in…' : 'Log in'}
                  </button>
                </form>
              ) : (
                selected && (
                  <form onSubmit={submitCreatePassword} className="stack" style={{ gap: 14, marginTop: 14 }}>
                    <div className="muted tiny">
                      Welcome, {selected.name}! Set up a password to continue — you'll use it to log in from now on.
                    </div>
                    <div>
                      <label className="field">New password</label>
                      <input
                        type="password"
                        autoFocus
                        value={newPassword}
                        onChange={(e) => setNewPassword(e.target.value)}
                      />
                    </div>
                    <div>
                      <label className="field">Confirm password</label>
                      <input
                        type="password"
                        value={confirmPassword}
                        onChange={(e) => setConfirmPassword(e.target.value)}
                      />
                    </div>
                    <button className="btn" type="submit" disabled={busy || !newPassword || !confirmPassword}>
                      {busy ? 'Creating…' : 'Create password & log in'}
                    </button>
                  </form>
                )
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
