import React, { useEffect, useState } from 'react';
import { api, setToken, passwordError } from '../api';
import Logo from './ui/Logo';
import Button from './ui/Button';

// Auth landing page: pick your name, then either log in (if you already have a
// password) or create one (first time). Calls onLogin({ user }) once signed in.
// App.jsx renders this instead of the main app whenever there's no logged-in user.
export default function Login({ onLogin }) {
  const [users, setUsers] = useState([]); // the team member list for the dropdown
  const [userId, setUserId] = useState(''); // currently selected user's id (as a string, matches <select> values)
  const [password, setPassword] = useState(''); // login form field
  const [newPassword, setNewPassword] = useState(''); // first-time setup form field
  const [confirmPassword, setConfirmPassword] = useState(''); // first-time setup form field
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false); // true while a login/setup request is in flight
  const [loadingUsers, setLoadingUsers] = useState(true);

  // Load the user list once on mount, and default the dropdown to the first person.
  useEffect(() => {
    api.auth.users()
      .then((u) => {
        setUsers(u);
        if (u.length) setUserId(String(u[0].id));
      })
      .catch((e) => setError(e.message))
      .finally(() => setLoadingUsers(false));
  }, []);

  // The full user object for whichever id is currently selected — used to
  // decide whether to show the "log in" form or the "set a password" form.
  const selected = users.find((u) => String(u.id) === String(userId));

  // Switching the selected person clears whatever was typed for the previous one.
  function selectUser(id) {
    setUserId(id);
    setPassword('');
    setNewPassword('');
    setConfirmPassword('');
    setError(null);
  }

  // Shown when the selected user already has a password set.
  async function submitLogin(e) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const { token, user } = await api.auth.login(Number(userId), password);
      setToken(token);
      onLogin(user); // tells App.jsx we're logged in now
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  // Shown when the selected user has never set a password before.
  async function submitCreatePassword(e) {
    e.preventDefault();
    setError(null);
    const err = passwordError(newPassword, confirmPassword);
    if (err) {
      setError(err);
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
          <div className="auth-brand">
            <Logo variant="full-original" />
            <div className="sub">Sales Visit CRM · Lincoln, NE</div>
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

              {/* Two different forms depending on whether this person has a password yet. */}
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
                  <Button type="submit" disabled={busy || !password}>
                    {busy ? 'Logging in…' : 'Log in'}
                  </Button>
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
                    <Button type="submit" disabled={busy || !newPassword || !confirmPassword}>
                      {busy ? 'Creating…' : 'Create password & log in'}
                    </Button>
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
