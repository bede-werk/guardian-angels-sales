import React, { useState } from 'react';
import { api, setToken } from '../api';
import Button from './ui/Button';

const MIN_PASSWORD_LENGTH = 6;

// Modal opened from the header's "Change password" link (see App.jsx). Asks
// for the current password (to prove it's really you) plus a new one twice.
export default function ChangePassword({ onClose }) {
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [error, setError] = useState(null);
  const [done, setDone] = useState(false); // true after a successful save — swaps the form for a confirmation message
  const [saving, setSaving] = useState(false);

  async function submit(e) {
    e.preventDefault();
    setError(null);
    if (newPassword.length < MIN_PASSWORD_LENGTH) {
      setError(`New password must be at least ${MIN_PASSWORD_LENGTH} characters`);
      return;
    }
    if (newPassword !== confirmPassword) {
      setError('New passwords do not match');
      return;
    }
    setSaving(true);
    try {
      // The server rotates the session token on a password change (so other
      // devices get signed out) — save the new one here or this browser tab
      // would immediately be logged out too.
      const { token } = await api.auth.changePassword(currentPassword, newPassword);
      setToken(token);
      setDone(true);
    } catch (e) {
      setError(e.message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 420 }}>
        <div className="modal-head">
          <h2>Change password</h2>
          <button className="close" onClick={onClose}>×</button>
        </div>
        <div className="modal-body">
          {error && <div className="error-banner">{error}</div>}
          {done ? (
            <div className="muted">Password updated. Well done.</div>
          ) : (
            <form onSubmit={submit} className="stack" style={{ gap: 14 }}>
              <div>
                <label className="field">Current password</label>
                <input
                  type="password"
                  autoFocus
                  value={currentPassword}
                  onChange={(e) => setCurrentPassword(e.target.value)}
                />
              </div>
              <div>
                <label className="field">New password</label>
                <input
                  type="password"
                  value={newPassword}
                  onChange={(e) => setNewPassword(e.target.value)}
                />
              </div>
              <div>
                <label className="field">Confirm new password</label>
                <input
                  type="password"
                  value={confirmPassword}
                  onChange={(e) => setConfirmPassword(e.target.value)}
                />
              </div>
              <Button type="submit" disabled={saving || !currentPassword || !newPassword || !confirmPassword}>
                {saving ? 'Saving…' : 'Save new password'}
              </Button>
            </form>
          )}
        </div>
        <div className="modal-foot">
          <Button variant="secondary" onClick={onClose}>{done ? 'Close' : 'Cancel'}</Button>
        </div>
      </div>
    </div>
  );
}
