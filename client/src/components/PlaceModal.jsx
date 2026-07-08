import React, { useState } from 'react';
import { api } from '../api';
import Button from './ui/Button';
import PhoneInput, { isCompletePhone } from './ui/PhoneInput';

// Create a new place (organization) manually from the Places directory.
// Opened from Places.jsx's "Add place" button.
export default function PlaceModal({ categories = [], onClose, onSaved }) {
  const [form, setForm] = useState({
    name: '',
    category: '',
    tier: '3',
    is_priority: false,
    address: '',
    city: '',
    state: 'NE',
    zip: '',
    phone: '',
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
      const place = await api.createPlace(form);
      onSaved?.(place);
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
          <h2>Add a place</h2>
          <button className="close" onClick={onClose}>×</button>
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
          <Button variant="secondary" onClick={onClose} disabled={saving}>Cancel</Button>
          <Button onClick={save} disabled={saving || !form.name.trim() || !isCompletePhone(form.phone)}>
            {saving ? 'Saving…' : 'Add place'}
          </Button>
        </div>
      </div>
    </div>
  );
}
