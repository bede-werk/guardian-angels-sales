import React, { useEffect, useState } from 'react';
import { api, OUTCOME_LABELS } from '../api';
import Button from './ui/Button';
import PhoneInput, { isCompletePhone } from './ui/PhoneInput';

// Modal for logging/updating a visit: outcome, notes, key person, next visit date.
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
    person_id: visit?.person_id || '',
    person_name: visit?.person_name || '',
    person_title: visit?.person_title || '',
    person_email: visit?.person_email || '',
    person_phone: visit?.person_phone || '',
    next_visit_date: visit?.next_visit_date || '',
  });
  const [people, setPeople] = useState([]); // this place's people, for the "who did you meet?" picker
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const [done, setDone] = useState(false); // true after a successful save — shows the confirmation screen

  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));
  const title = placeName || visit?.name || visit?.place_name || 'Visit';

  // Load this place's people once we know who the place is, so the
  // "who did you meet?" dropdown has real options.
  useEffect(() => {
    if (!resolvedPlaceId) return;
    api.people.listForPlace(resolvedPlaceId).then(setPeople).catch(() => {});
  }, [resolvedPlaceId]);

  // Selecting someone from the "who did you meet?" dropdown links this visit
  // to their person record (person_id) and pre-fills the person_* snapshot
  // fields below from their saved info (still editable afterward). Picking
  // "someone not listed…" clears the link but leaves any typed-in snapshot alone.
  function pickPerson(id) {
    const p = people.find((x) => String(x.id) === String(id));
    setForm((f) => ({
      ...f,
      person_id: id || '',
      person_name: p ? p.name || '' : f.person_name,
      person_title: p ? p.title || '' : f.person_title,
      person_email: p ? p.email || '' : f.person_email,
      person_phone: p ? p.phone || '' : f.person_phone,
    }));
  }

  // Saves the form. If we're editing an existing scheduled stop, PATCH it;
  // otherwise POST a new ad-hoc visit. `markComplete` is true for the "Save &
  // mark complete" button, false for the plain "Save" (log progress without
  // finishing the visit yet).
  async function save(markComplete) {
    if (!isCompletePhone(form.person_phone)) {
      setError('Phone must be a complete number, e.g. (402) 555-1234');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const payload = { ...form, person_id: form.person_id || null };
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
          <button className="close" title="Close without saving" onClick={onClose}>×</button>
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

          {/* Only shown if this place actually has people on file. */}
          {people.length > 0 && (
            <div>
              <label className="field">Who did you meet?</label>
              <select value={form.person_id} onChange={(e) => pickPerson(e.target.value)}>
                <option value="">Someone not listed…</option>
                {people.map((p) => (
                  <option key={p.id} value={p.id}>{p.name}{p.title ? ` — ${p.title}` : ''}</option>
                ))}
              </select>
            </div>
          )}

          {/* These stay editable even after picking a person above — this is
              a per-visit snapshot, not a live link to the people table
              (person_id above is what makes the real link). */}
          <div className="row">
            <div>
              <label className="field">Contact name</label>
              <input value={form.person_name} onChange={set('person_name')} />
            </div>
            <div>
              <label className="field">Title</label>
              <input value={form.person_title} onChange={set('person_title')} />
            </div>
          </div>
          <div className="row">
            <div>
              <label className="field">Email</label>
              <input type="email" value={form.person_email} onChange={set('person_email')} />
            </div>
            <div>
              <label className="field">Phone</label>
              <PhoneInput value={form.person_phone} onChange={(v) => setForm((f) => ({ ...f, person_phone: v }))} />
            </div>
          </div>

          <div style={{ maxWidth: 220 }}>
            <label className="field">Next visit date</label>
            <input type="date" value={form.next_visit_date || ''} onChange={set('next_visit_date')} />
          </div>
        </div>
        <div className="modal-foot">
          <Button
            variant="secondary"
            title="Save progress without marking this visit as done yet"
            onClick={() => save(false)}
            disabled={saving || !isCompletePhone(form.person_phone)}
          >
            Save
          </Button>
          <Button
            title="Save and mark this visit as completed"
            onClick={() => save(true)}
            disabled={saving || !isCompletePhone(form.person_phone)}
          >
            {saving ? 'Saving…' : 'Save & mark complete'}
          </Button>
        </div>
      </div>
    </div>
  );
}
