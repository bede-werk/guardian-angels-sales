import React, { useEffect, useState } from 'react';
import { api, OUTCOME_LABELS } from '../api';
import Button from './ui/Button';

// Modal for logging/updating a visit: outcome, notes, key contact, next visit date.
// `visit` may be a scheduled stop (has visit_id, from Schedule.jsx) or, when
// opened from a place with no scheduled visit, `placeId` is provided
// instead to create a brand-new ad-hoc visit (from PlaceDetail.jsx).
// On narrow screens this renders as a bottom slide-up sheet instead of a
// centered modal — see the @media rule for .modal-backdrop in styles.css.
export default function VisitLogModal({ visit, placeId, placeName, onClose, onSaved }) {
  // Whichever way this modal was opened, we need to know which place it's for.
  const resolvedPlaceId = visit?.place_id || placeId;
  const [form, setForm] = useState({
    outcome: visit?.outcome || '',
    notes: visit?.notes || '',
    contact_name: visit?.contact_name || '',
    contact_title: visit?.contact_title || '',
    contact_email: visit?.contact_email || '',
    contact_phone: visit?.contact_phone || '',
    next_visit_date: visit?.next_visit_date || '',
  });
  const [contacts, setContacts] = useState([]); // this place's contacts, for the "who did you meet?" picker
  const [pickedContactId, setPickedContactId] = useState(''); // which contact is selected in that picker
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const [done, setDone] = useState(false); // true after a successful save — shows the confirmation screen

  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));
  const title = placeName || visit?.name || visit?.place_name || 'Visit';

  // Load this place's contact list once we know who the place is, so the
  // "who did you meet?" dropdown has real options.
  useEffect(() => {
    if (!resolvedPlaceId) return;
    api.contacts.list(resolvedPlaceId).then(setContacts).catch(() => {});
  }, [resolvedPlaceId]);

  // Selecting someone from the "who did you meet?" dropdown pre-fills the
  // contact_* fields below from their saved info (still editable afterward).
  function pickContact(id) {
    setPickedContactId(id);
    const c = contacts.find((x) => String(x.id) === String(id));
    if (!c) return;
    setForm((f) => ({
      ...f,
      contact_name: c.name || '',
      contact_title: c.title || '',
      contact_email: c.email || '',
      contact_phone: c.phone || '',
    }));
  }

  // Saves the form. If we're editing an existing scheduled stop, PATCH it;
  // otherwise POST a new ad-hoc visit. `markComplete` is true for the "Save &
  // mark complete" button, false for the plain "Save" (log progress without
  // finishing the visit yet).
  async function save(markComplete) {
    setSaving(true);
    setError(null);
    try {
      const payload = { ...form };
      if (markComplete) payload.status = 'completed';
      let saved;
      if (visit?.visit_id) {
        saved = await api.updateVisit(visit.visit_id, payload);
      } else {
        saved = await api.createVisit({ place_id: placeId, scheduled_date: new Date().toISOString().slice(0, 10), ...payload });
      }
      onSaved?.(saved);
      setDone(true);
      // Show the "Visit logged. Well done." confirmation briefly before
      // auto-closing, instead of the modal just vanishing instantly.
      setTimeout(() => onClose(), 900);
    } catch (e) {
      setError(e.message);
      setSaving(false);
    }
  }

  // After a successful save, swap the whole modal for a brief confirmation
  // message (see the setTimeout above that closes it).
  if (done) {
    return (
      <div className="modal-backdrop">
        <div className="modal" style={{ maxWidth: 360 }}>
          <div className="save-confirmation">
            <div className="check">✓</div>
            <div className="msg">Visit logged. Well done.</div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h2>Log visit — {title}</h2>
          <button className="close" onClick={onClose}>×</button>
        </div>
        <div className="modal-body">
          {error && <div className="error-banner">{error}</div>}

          {/* Outcome as big tap-chips — the one required-feeling field, meant
              to be logged in a couple of taps without much typing. */}
          <div>
            <label className="field">Outcome</label>
            <div className="outcome-group">
              {Object.entries(OUTCOME_LABELS).map(([val, label]) => (
                <button
                  key={val}
                  type="button"
                  className={`outcome-btn ${form.outcome === val ? 'active' : ''}`}
                  onClick={() => setForm((f) => ({ ...f, outcome: f.outcome === val ? '' : val }))}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>

          <div>
            <label className="field">Notes</label>
            <textarea rows={3} value={form.notes} onChange={set('notes')} placeholder="What happened, next steps…" />
          </div>

          {/* Only shown if this place actually has contacts on file. */}
          {contacts.length > 0 && (
            <div>
              <label className="field">Who did you meet?</label>
              <select value={pickedContactId} onChange={(e) => pickContact(e.target.value)}>
                <option value="">Someone not listed…</option>
                {contacts.map((c) => (
                  <option key={c.id} value={c.id}>{c.name}{c.title ? ` — ${c.title}` : ''}</option>
                ))}
              </select>
            </div>
          )}

          {/* These stay editable even after picking a contact above — this is
              a per-visit snapshot, not a live link to the contacts table. */}
          <div className="row">
            <div>
              <label className="field">Contact name</label>
              <input value={form.contact_name} onChange={set('contact_name')} />
            </div>
            <div>
              <label className="field">Title</label>
              <input value={form.contact_title} onChange={set('contact_title')} />
            </div>
          </div>
          <div className="row">
            <div>
              <label className="field">Email</label>
              <input type="email" value={form.contact_email} onChange={set('contact_email')} />
            </div>
            <div>
              <label className="field">Phone</label>
              <input value={form.contact_phone} onChange={set('contact_phone')} />
            </div>
          </div>

          <div style={{ maxWidth: 220 }}>
            <label className="field">Next visit date</label>
            <input type="date" value={form.next_visit_date || ''} onChange={set('next_visit_date')} />
          </div>
        </div>
        <div className="modal-foot">
          <Button variant="secondary" onClick={() => save(false)} disabled={saving}>
            Save
          </Button>
          <Button onClick={() => save(true)} disabled={saving}>
            {saving ? 'Saving…' : 'Save & mark complete'}
          </Button>
        </div>
      </div>
    </div>
  );
}
