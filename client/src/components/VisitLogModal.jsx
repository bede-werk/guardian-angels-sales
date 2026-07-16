import React, { useEffect, useState } from 'react';
import { api } from '../api';
import Button from './ui/Button';
import PersonModal from './PersonModal';

const CREATE_PERSON = '__create_person__'; // sentinel option value for "+ Create new person…"

// Modal for logging/updating a visit. For now this is deliberately minimal:
// notes plus who you met with — outcome, next-visit-date, and manual contact
// fields aren't editable here yet. Any of those already present on an
// existing `visit` are preserved as-is (carried through in the save payload)
// rather than shown or cleared.
// `visit` is passed when editing an existing visit (has visit_id); when
// opened from a place with no visit yet, `placeId` is provided instead to
// create a brand-new ad-hoc visit (from PlaceDetail.jsx).
// On narrow screens this renders as a bottom slide-up sheet instead of a
// centered modal — see the @media rule for .modal-backdrop in styles.css.
export default function VisitLogModal({ visit, placeId, placeName, userId, onClose, onSaved }) {
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
  const [creatingPerson, setCreatingPerson] = useState(false); // "+ Create new person…" modal open?
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const [done, setDone] = useState(false); // true after a successful save — shows the confirmation screen

  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));
  const title = placeName || visit?.place_name || 'Visit';
  // The person originally linked to this visit was since deleted (person_id
  // nulled out via ON DELETE SET NULL, but the person_name snapshot
  // survives). Reassigning the "who did you meet?" picker in that state
  // would silently reattribute this visit's history to someone else, so
  // instead the picker is locked and only the notes stay editable.
  const personRecordGone = Boolean(visit && !visit.person_id && visit.person_name);
  const canSave = form.notes.trim() && (form.person_id || personRecordGone);

  // Load this place's people once we know who the place is, so the
  // "who did you meet?" dropdown has real options.
  useEffect(() => {
    if (!resolvedPlaceId) return;
    api.people.listForPlace(resolvedPlaceId).then(setPeople).catch(() => {});
  }, [resolvedPlaceId]);

  // Selecting someone from the "who did you meet?" dropdown links this visit
  // to their person record (person_id) and snapshots their saved info into
  // the person_* fields below (not editable here — see the module comment).
  // The special "+ Create new person…" option instead opens PersonModal
  // (handlePersonSelect below) rather than changing the selection.
  function pickPerson(id) {
    const p = people.find((x) => String(x.id) === String(id));
    setForm((f) => ({
      ...f,
      person_id: id || '',
      person_name: p ? p.name || '' : '',
      person_title: p ? p.title || '' : '',
      person_email: p ? p.email || '' : '',
      person_phone: p ? p.phone || '' : '',
    }));
  }

  function handlePersonSelect(e) {
    if (e.target.value === CREATE_PERSON) {
      setCreatingPerson(true);
      return; // leave the current selection alone — the <select> snaps back on re-render
    }
    pickPerson(e.target.value);
  }

  // The person was just created from inside this modal (via "+ Create new
  // person…") — add them to the picker's options and select them immediately.
  function handlePersonCreated(person) {
    setPeople((ps) => [...ps, person]);
    setForm((f) => ({
      ...f,
      person_id: person.id,
      person_name: person.name || '',
      person_title: person.title || '',
      person_email: person.email || '',
      person_phone: person.phone || '',
    }));
  }

  // Saves the form and marks the visit completed — this modal is just for
  // logging what happened, so saving it means it happened. If we're editing
  // an existing scheduled stop, PATCH it; otherwise POST a new ad-hoc visit.
  async function save() {
    setSaving(true);
    setError(null);
    try {
      const payload = { ...form, person_id: form.person_id || null, status: 'completed' };
      let saved;
      if (visit?.visit_id) {
        saved = await api.updateVisit(visit.visit_id, payload);
      } else {
        // A brand-new ad-hoc visit is attributed to whoever's logged in right
        // now — a scheduled stop already carries its own user_id from when
        // the route was generated, so this only applies to fresh visits.
        saved = await api.createVisit({
          place_id: placeId,
          user_id: userId,
          scheduled_date: new Date().toISOString().slice(0, 10),
          ...payload,
        });
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
    <div className="modal-backdrop" onClick={(e) => { e.stopPropagation(); onClose(); }}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h2>Log visit — {title}</h2>
          <button className="close" title="Close without saving" onClick={onClose}>×</button>
        </div>
        <div className="modal-body">
          {error && <div className="error-banner">{error}</div>}

          <div>
            <label className="field">Notes</label>
            <textarea rows={3} value={form.notes} onChange={set('notes')} placeholder="What happened, next steps…" autoFocus />
          </div>

          {personRecordGone ? (
            <div>
              <label className="field">Who you met</label>
              <div className="muted" title="This person's record was deleted — reassigning would rewrite this visit's history, so only the notes can be edited.">
                {form.person_name}{form.person_title ? ` — ${form.person_title}` : ''} (no longer on file — only notes are editable)
              </div>
            </div>
          ) : (
            <div>
              <label className="field">Who did you meet?</label>
              <select value={form.person_id} onChange={handlePersonSelect}>
                <option value="">Select who you met with…</option>
                {people.map((p) => (
                  <option key={p.id} value={p.id}>{p.name}{p.title ? ` — ${p.title}` : ''}</option>
                ))}
                <option value={CREATE_PERSON}>+ Create new person…</option>
              </select>
            </div>
          )}
        </div>
        <div className="modal-foot">
          <Button variant="secondary" title="Close without saving" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button
            title={canSave ? 'Save this visit' : 'Add a note and select who you met with first'}
            onClick={save}
            disabled={saving || !canSave}
          >
            {saving ? 'Saving…' : 'Save'}
          </Button>
        </div>
      </div>

      {creatingPerson && (
        <PersonModal
          placeId={resolvedPlaceId}
          placeName={title}
          onClose={() => setCreatingPerson(false)}
          onSaved={handlePersonCreated}
        />
      )}
    </div>
  );
}
