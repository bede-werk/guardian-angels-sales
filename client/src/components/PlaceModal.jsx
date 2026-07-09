import React, { useState } from 'react';
import { api } from '../api';
import Button from './ui/Button';
import PhoneInput, { isCompletePhone } from './ui/PhoneInput';

// Create or edit a place (organization). `place` present = editing (form is
// pre-filled from it); absent = creating a brand-new one from a blank form.
// Opened from Places.jsx's "Add place" button, or PlaceDetail.jsx's "Edit" button.
export default function PlaceModal({ place, categories = [], onClose, onSaved }) {
  const [form, setForm] = useState({
    name: place?.name || '',
    category: place?.category || '',
    tier: place ? String(place.tier) : '3',
    is_priority: place?.is_priority || false,
    address: place?.address || '',
    city: place?.city || '',
    state: place?.state || 'NE',
    zip: place?.zip || '',
    phone: place?.phone || '',
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));
  const toggle = (k) => () => setForm((f) => ({ ...f, [k]: !f[k] }));

  async function save() {
    if (!isCompletePhone(form.phone)) {
      setError('Phone must be a complete number, e.g. (402) 555-1234');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const saved = place ? await api.updatePlace(place.id, form) : await api.createPlace(form);
      onSaved?.(saved);
      onClose();
    } catch (e) {
      setError(e.message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="modal-backdrop" onClick={(e) => { e.stopPropagation(); onClose(); }}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h2>{place ? 'Edit place' : 'Add a place'}</h2>
          <button className="close" title="Close without saving" onClick={onClose}>×</button>
        </div>
        <div className="modal-body">
          {error && <div className="error-banner">{error}</div>}

          <div>
            <label className="field">Organization name</label>
            <input value={form.name} onChange={set('name')} autoFocus />
          </div>

          <div className="row">
            <div>
              <label className="field">Category</label>
              <input list="place-category-options" value={form.category} onChange={set('category')} placeholder="e.g. Hospitals" />
              <datalist id="place-category-options">
                {categories.map((c) => <option key={c} value={c} />)}
              </datalist>
            </div>
            <div>
              <label className="field">Tier</label>
              <select value={form.tier} onChange={set('tier')}>
                <option value="1">Tier 1</option>
                <option value="2">Tier 2</option>
                <option value="3">Tier 3</option>
              </select>
            </div>
          </div>

          <label className="tiny" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <input type="checkbox" style={{ width: 'auto' }} checked={form.is_priority} onChange={toggle('is_priority')} />
            ★ Priority
          </label>

          <div>
            <label className="field">Address</label>
            <input value={form.address} onChange={set('address')} />
          </div>

          <div className="row">
            <div>
              <label className="field">City</label>
              <input value={form.city} onChange={set('city')} />
            </div>
            <div style={{ maxWidth: 100 }}>
              <label className="field">State</label>
              <input value={form.state} onChange={set('state')} />
            </div>
            <div style={{ maxWidth: 140 }}>
              <label className="field">Zip</label>
              <input value={form.zip} onChange={set('zip')} />
            </div>
          </div>

          <div>
            <label className="field">Phone</label>
            <PhoneInput value={form.phone} onChange={(v) => setForm((f) => ({ ...f, phone: v }))} />
          </div>
        </div>
        <div className="modal-foot">
          <Button variant="secondary" title="Close without saving" onClick={onClose} disabled={saving}>Cancel</Button>
          <Button
            title={place ? "Save changes to this place's details" : 'Create this new place'}
            onClick={save}
            disabled={saving || !form.name.trim() || !isCompletePhone(form.phone)}
          >
            {saving ? 'Saving…' : place ? 'Save changes' : 'Add place'}
          </Button>
        </div>
      </div>
    </div>
  );
}
