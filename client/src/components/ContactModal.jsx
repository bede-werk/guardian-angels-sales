import React, { useState } from 'react';
import { api, ROLE_TYPE_LABELS } from '../api';
import Button from './ui/Button';

const TEMPS = ['hot', 'warm', 'cold', 'dormant'];
const TEMP_LABELS = { hot: 'Hot', warm: 'Warm', cold: 'Cold', dormant: 'Dormant' };

// Create or edit a person at a place. `contact` present = editing; absent = creating.
export default function ContactModal({ partnerId, contact, onClose, onSaved }) {
  const [form, setForm] = useState({
    name: contact?.name || '',
    title: contact?.title || '',
    role_type: contact?.role_type || '',
    relationship_temp: contact?.relationship_temp || '',
    email: contact?.email || '',
    phone: contact?.phone || '',
    birthday: contact?.birthday || '',
    preferences: contact?.preferences || '',
    notes: contact?.notes || '',
    departed: contact?.departed || false,
    is_primary: contact?.is_primary || false,
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));
  const toggle = (k) => () => setForm((f) => ({ ...f, [k]: !f[k] }));

  async function save() {
    setSaving(true);
    setError(null);
    try {
      const saved = contact
        ? await api.contacts.update(contact.id, form)
        : await api.contacts.create(partnerId, form);
      onSaved?.(saved);
      onClose();
    } catch (e) {
      setError(e.message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h2>{contact ? 'Edit contact' : 'Add a contact'}</h2>
          <button className="close" onClick={onClose}>×</button>
        </div>
        <div className="modal-body">
          {error && <div className="error-banner">{error}</div>}

          <div className="row">
            <div>
              <label className="field">Name</label>
              <input value={form.name} onChange={set('name')} autoFocus />
            </div>
            <div>
              <label className="field">Title</label>
              <input value={form.title} onChange={set('title')} />
            </div>
          </div>

          <div className="row">
            <div>
              <label className="field">Role</label>
              <select value={form.role_type} onChange={set('role_type')}>
                <option value="">—</option>
                {Object.entries(ROLE_TYPE_LABELS).map(([val, label]) => (
                  <option key={val} value={val}>{label}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="field">Relationship</label>
              <select value={form.relationship_temp} onChange={set('relationship_temp')}>
                <option value="">—</option>
                {TEMPS.map((t) => (
                  <option key={t} value={t}>{TEMP_LABELS[t]}</option>
                ))}
              </select>
            </div>
          </div>

          <div className="row">
            <div>
              <label className="field">Email</label>
              <input type="email" value={form.email} onChange={set('email')} />
            </div>
            <div>
              <label className="field">Phone</label>
              <input value={form.phone} onChange={set('phone')} />
            </div>
          </div>

          <div>
            <label className="field">Preferences</label>
            <input value={form.preferences} onChange={set('preferences')} placeholder="Coffee order, how they like to be reached…" />
          </div>

          <div>
            <label className="field">Notes</label>
            <textarea rows={2} value={form.notes} onChange={set('notes')} />
          </div>

          <div className="row">
            <div style={{ maxWidth: 200 }}>
              <label className="field">Birthday</label>
              <input value={form.birthday} onChange={set('birthday')} placeholder="e.g. March 14" />
            </div>
            <div className="tag-list" style={{ alignItems: 'center', paddingTop: 20 }}>
              <label className="tiny" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <input type="checkbox" style={{ width: 'auto' }} checked={form.is_primary} onChange={toggle('is_primary')} />
                Primary contact
              </label>
              <label className="tiny" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <input type="checkbox" style={{ width: 'auto' }} checked={form.departed} onChange={toggle('departed')} />
                Departed
              </label>
            </div>
          </div>
        </div>
        <div className="modal-foot">
          <Button variant="secondary" onClick={onClose} disabled={saving}>Cancel</Button>
          <Button onClick={save} disabled={saving || !form.name.trim()}>
            {saving ? 'Saving…' : contact ? 'Save changes' : 'Add contact'}
          </Button>
        </div>
      </div>
    </div>
  );
}
