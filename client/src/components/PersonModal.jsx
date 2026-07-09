import React, { useState } from 'react';
import { api, ROLE_TYPE_LABELS } from '../api';
import Button from './ui/Button';
import PhoneInput, { isCompletePhone } from './ui/PhoneInput';

// Create or edit a person. `person` present = editing (form is pre-filled from
// it); absent = creating a brand-new one from a blank form.
// Opened from PlaceDetail.jsx's "New person" button or PersonDetail.jsx's
// "Edit" button (both pass a fixed `placeId`), or from People.jsx's
// "+ Add person" button (passes `places` instead, so the form includes a
// place picker).
export default function PersonModal({ placeId, placeName, places, person, onClose, onSaved }) {
  const [form, setForm] = useState({
    place_id: placeId || person?.place_id || '',
    name: person?.name || '',
    title: person?.title || '',
    role_type: person?.role_type || '',
    email: person?.email || '',
    phone: person?.phone || '',
    birthday: person?.birthday || '',
    preferences: person?.preferences || '',
    notes: person?.notes || '',
    departed: person?.departed || false,
    is_primary: person?.is_primary || false,
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value })); // wires a text input/select to `form`
  const toggle = (k) => () => setForm((f) => ({ ...f, [k]: !f[k] })); // wires a checkbox to `form`

  // PATCH if editing an existing person, POST if creating a new one.
  async function save() {
    if (!isCompletePhone(form.phone)) {
      setError('Phone must be a complete number, e.g. (402) 555-1234');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const saved = person
        ? await api.people.update(person.id, form)
        : await api.people.create({ ...form, place_id: placeId || form.place_id || null });
      onSaved?.(saved);
      onClose();
    } catch (e) {
      setError(e.message);
    } finally {
      setSaving(false);
    }
  }

  const needsPlacePicker = !placeId && !person && places;

  return (
    <div className="modal-backdrop" onClick={(e) => { e.stopPropagation(); onClose(); }}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h2>{person ? 'Edit person' : placeName ? `Add a person to ${placeName}` : 'Add a person'}</h2>
          <button className="close" title="Close without saving" onClick={onClose}>×</button>
        </div>
        <div className="modal-body">
          {error && <div className="error-banner">{error}</div>}

          {needsPlacePicker && (
            <div>
              <label className="field">Place</label>
              <select value={form.place_id} onChange={set('place_id')}>
                <option value="">No place (unassigned)</option>
                {places.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
            </div>
          )}

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
              <label className="field">Email</label>
              <input type="email" value={form.email} onChange={set('email')} />
            </div>
            <div>
              <label className="field">Phone</label>
              <PhoneInput value={form.phone} onChange={(v) => setForm((f) => ({ ...f, phone: v }))} />
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
            {/* is_primary: only one person per place can be primary — the
                server automatically un-checks it on any other person at this
                same place when this one is saved as primary. */}
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
          <Button variant="secondary" title="Close without saving" onClick={onClose} disabled={saving}>Cancel</Button>
          <Button
            title={person ? "Save changes to this person's details" : 'Create this new person'}
            onClick={save}
            disabled={saving || !form.name.trim() || !isCompletePhone(form.phone)}
          >
            {saving ? 'Saving…' : person ? 'Save changes' : 'Add person'}
          </Button>
        </div>
      </div>
    </div>
  );
}
