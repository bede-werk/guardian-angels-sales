import React, { useState } from 'react';
import { api, setToken } from '../api';

const MIN_PASSWORD_LENGTH = 6;

export default function ChangePassword({ onClose }) {
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [error, setError] = useState(null);
  const [done, setDone] = useState(false);
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
            <div className="muted">Password updated.</div>
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
              <button className="btn" type="submit" disabled={saving || !currentPassword || !newPassword || !confirmPassword}>
                {saving ? 'Saving…' : 'Save new password'}
              </button>
            </form>
          )}
        </div>
        <div className="modal-foot">
          <button className="btn secondary" onClick={onClose}>{done ? 'Close' : 'Cancel'}</button>
        </div>
      </div>
    </div>
  );
}
