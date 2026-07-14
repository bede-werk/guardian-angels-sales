import React, { useState } from 'react';
import { api } from '../api';
import Button from './ui/Button';
import PhoneInput, { isCompletePhone } from './ui/PhoneInput';
import ConfirmDialog from './ui/ConfirmDialog';

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
  const [confirmPrompt, setConfirmPrompt] = useState(null); // { message, onConfirm } | null — see ConfirmDialog

  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));
  const toggle = (k) => () => setForm((f) => ({ ...f, [k]: !f[k] }));

  // One save attempt against the API. Returns 'ok' or 'failed' ('error' is
  // already set in the latter case). `confirm_address` is always sent true
  // here since, by the time this runs, save() has already resolved any
  // address warning up front — this is just a safety-net re-check on the
  // server, not expected to fire in normal use.
  async function attemptSave(body) {
    setSaving(true);
    setError(null);
    try {
      const saved = place ? await api.updatePlace(place.id, body) : await api.createPlace(body);
      onSaved?.(saved);
      onClose();
      return 'ok';
    } catch (e) {
      setError(e.message);
      return 'failed';
    } finally {
      setSaving(false);
    }
  }

  // Checks duplicate-name and address-validity together *before* saving —
  // both fetched fresh right here (never from a debounced background hook,
  // which could still be mid-flight and stale at the moment of clicking) —
  // so if both are a problem the rep sees one combined pop-up instead of
  // missing one. Only warn on the name when creating — editing an existing
  // place will always "match" itself. Pops up only when "Add
  // place"/"Save changes" is actually clicked, not while still typing.
  async function save() {
    if (!isCompletePhone(form.phone)) {
      setError('Phone must be a complete number, e.g. (402) 555-1234');
      return;
    }

    setSaving(true);
    const [duplicates, addressCheck] = await Promise.all([
      !place && form.name.trim().length >= 3 ? api.places({ search: form.name.trim() }) : [],
      form.address || form.city || form.zip
        ? api.checkAddress({ address: form.address, city: form.city, state: form.state, zip: form.zip })
        : { recognized: true },
    ]);
    setSaving(false);

    const issues = [];
    if (duplicates.length > 0) {
      const names = duplicates.slice(0, 5).map((m) => m.name).join(', ');
      issues.push({ title: 'Possible duplicate', detail: `A similar place may already be on file: ${names}.` });
    }
    if (!addressCheck.recognized) {
      issues.push({ title: 'Unrecognized address', detail: "This address wasn't recognized." });
    }

    if (issues.length > 0) {
      setConfirmPrompt({
        issues,
        onConfirm: () => { setConfirmPrompt(null); attemptSave({ ...form, confirm_address: true }); },
      });
      return;
    }
    attemptSave(form);
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
        {confirmPrompt && (
          <ConfirmDialog
            issues={confirmPrompt.issues}
            onConfirm={confirmPrompt.onConfirm}
            onCancel={() => setConfirmPrompt(null)}
          />
        )}
      </div>
    </div>
  );
}
