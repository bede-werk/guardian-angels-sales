import React, { useEffect, useState } from 'react';
import { api, today, VISIT_TYPE_LABELS } from '../api';
import Button from './ui/Button';
import PersonModal from './PersonModal';

const CREATE_PERSON = '__create_person__'; // sentinel option value for "+ Create new person…"

// Modal for logging/updating a visit. For now this is deliberately minimal:
// date (not always editable — see below), visit type, notes, plus who you
// met with — outcome, next-visit-date, and manual contact fields aren't
// editable here yet. Any of those already present on an existing `visit` are
// preserved as-is (carried through in the save payload) rather than shown or
// cleared. The Date field is hidden only when `visit.status === 'planned'`
// — a still-open route-planner stop, whose date is fixed to whatever the
// route planner assigned it (completing it via UpcomingVisitDetailModal
// shouldn't let the date drift from the day it was actually scheduled for).
// Every other case shows it editable: a brand-new ad-hoc visit (no `visit`
// at all) defaults to today, and correcting an already-completed visit's
// date (opened via VisitDetailModal's Edit) is just as valid a correction as
// its notes/outcome/contact already are.
// `visit` is passed when editing an existing visit (has visit_id); when
// opened from a place with no visit yet, `placeId` is provided instead to
// create a brand-new ad-hoc visit (from PlaceDetail.jsx). `initialPerson`
// (id/name/title/email/phone) is an optional convenience default for the
// "who did you meet?" picker — used when opened from PersonDetail.jsx, which
// already knows who the visit is with; it's still just a starting
// selection, not locked, unlike the personRecordGone case below.
// On narrow screens this renders as a bottom slide-up sheet instead of a
// centered modal — see the @media rule for .modal-backdrop in styles.css.
// A place's very first completed visit also gets an extra optional
// "Avg. referrals/month discovered at pre-qual" field (isFirstVisit below,
// fetched from the place's own visit history) — not a real visits column,
// it writes through server-side to places.capacity_monthly_referrals +
// capacity_status: 'verified' (see routes/visits.js's maybeCapturePreQualification).
export default function VisitLogModal({ visit, placeId, placeName, initialPerson, userId, onClose, onSaved }) {
  // Whichever way this modal was opened, we need to know which place it's for.
  const resolvedPlaceId = visit?.place_id || placeId;
  const [form, setForm] = useState({
    scheduled_date: visit?.scheduled_date || today(),
    visit_type: visit?.visit_type || 'drop_in',
    outcome: visit?.outcome || '',
    notes: visit?.notes || '',
    person_id: visit?.person_id || initialPerson?.id || '',
    person_name: visit?.person_name || initialPerson?.name || '',
    person_title: visit?.person_title || initialPerson?.title || '',
    person_email: visit?.person_email || initialPerson?.email || '',
    person_phone: visit?.person_phone || initialPerson?.phone || '',
    next_visit_date: visit?.next_visit_date || '',
  });
  const [people, setPeople] = useState([]); // this place's people, for the "who did you meet?" picker
  const [creatingPerson, setCreatingPerson] = useState(false); // "+ Create new person…" modal open?
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const [done, setDone] = useState(false); // true after a successful save — shows the confirmation screen
  // Set when the server reports a planned/completed visit already exists at
  // this place on this date — either another rep's, or this same rep's own
  // (an accidental double-log) — via routes/visits.js's collision check,
  // ad-hoc creation only. Save becomes "Save anyway" — re-submitting with
  // `force: true` — rather than silently blocking; this is a heads-up, not a
  // hard rule. Cleared whenever the date changes, since that's what the
  // collision was actually keyed on.
  const [collisionWarning, setCollisionWarning] = useState(null);
  // Fetched to know whether this is the place's first-ever completed visit —
  // only then does the pre-qualification referral-estimate field show (see
  // avgReferrals below). Not part of `form`: it's a transient side-channel
  // value that writes through to places.capacity_monthly_referrals server-side
  // (routes/visits.js), not a real visits column.
  const [place, setPlace] = useState(null);
  const [avgReferrals, setAvgReferrals] = useState('');

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

  // Also load the place's own visit history, just to know whether the visit
  // being logged here is its first completed one ever — this place fetch is
  // otherwise unused by the rest of the form.
  useEffect(() => {
    if (!resolvedPlaceId) return;
    api.place(resolvedPlaceId).then(setPlace).catch(() => {});
  }, [resolvedPlaceId]);

  // place.visits is already completed-only (see routes/places.js). Excludes
  // the visit currently being edited (if any) from the count, so re-opening
  // an already-completed first visit to correct its notes doesn't lose
  // access to the referral-estimate field.
  const isFirstVisit = Boolean(place && place.visits.filter((v) => v.id !== visit?.visit_id).length === 0);

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
      // Rounded client-side before it ever leaves the browser — the server
      // silently drops a non-integer capacity_monthly_referrals (it's a real
      // DB integer column) rather than erroring, so an un-rounded "12.5"
      // would otherwise look saved but quietly never land.
      if (isFirstVisit && avgReferrals !== '') payload.capacity_monthly_referrals = Math.max(0, Math.round(Number(avgReferrals)));
      if (collisionWarning) payload.force = true; // "Save anyway" — re-submit past the warning already shown
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
          ...payload,
        });
      }
      onSaved?.(saved);
      setDone(true);
      // Show the "Visit logged. Well done." confirmation briefly before
      // auto-closing, instead of the modal just vanishing instantly.
      setTimeout(() => onClose(), 900);
    } catch (e) {
      if (e.code === 'VISIT_COLLISION') {
        setCollisionWarning(e.message);
        setSaving(false);
        return;
      }
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
          {collisionWarning && <div className="error-banner">{collisionWarning}</div>}

          {visit?.status !== 'planned' && (
            <div>
              <label className="field">Date</label>
              <input
                type="date"
                value={form.scheduled_date}
                max={today()}
                onChange={(e) => { setCollisionWarning(null); set('scheduled_date')(e); }}
              />
            </div>
          )}

          <div>
            <label className="field">Visit type</label>
            <select value={form.visit_type} onChange={set('visit_type')}>
              {Object.entries(VISIT_TYPE_LABELS).map(([key, label]) => (
                <option key={key} value={key}>{label}</option>
              ))}
            </select>
          </div>

          {isFirstVisit && (
            <div>
              <label className="field">Avg. referrals/month discovered at pre-qual</label>
              <input
                type="number"
                min="0"
                step="1"
                placeholder="Optional"
                value={avgReferrals}
                onChange={(e) => setAvgReferrals(e.target.value)}
              />
            </div>
          )}

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
                <option value={CREATE_PERSON}>+ Create new person…</option>
                <option disabled>──────────</option>
                {people.map((p) => (
                  <option key={p.id} value={p.id}>{p.name}{p.title ? ` — ${p.title}` : ''}</option>
                ))}
              </select>
            </div>
          )}
        </div>
        <div className="modal-foot">
          <Button variant="secondary" title="Close without saving" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button
            variant={collisionWarning ? 'danger' : 'primary'}
            title={collisionWarning ? 'Log this visit anyway, despite the collision above' : canSave ? 'Save this visit' : 'Add a note and select who you met with first'}
            onClick={save}
            disabled={saving || !canSave}
          >
            {saving ? 'Saving…' : collisionWarning ? 'Save anyway' : 'Save'}
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
