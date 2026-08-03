import React, { useEffect, useState } from 'react';
import { api, today, VISIT_TYPE_LABELS, VISIT_TYPE_MINUTES, OUTCOME_LABELS, MET_WITH_LABELS } from '../api';
import Button from './ui/Button';
import PersonModal from './PersonModal';
import AssignPersonModal from './AssignPersonModal';

// Sentinel option values — picking either opens a modal instead of changing
// the selection. Two different situations: the person doesn't exist on file at
// all (create), vs. they exist but aren't linked to this place yet (assign) —
// which is common, since someone met at one org often turns out to already be
// on file from another.
const CREATE_PERSON = '__create_person__';
const ASSIGN_PERSON = '__assign_person__';

// Modal for logging/updating a visit. The Date field is hidden only when
// `visit.status === 'planned'` — a still-open route-planner stop, whose date
// is fixed to whatever the route planner assigned it (completing it via
// UpcomingVisitDetailModal shouldn't let the date drift from the day it was
// actually scheduled for). Every other case shows it editable: a brand-new
// ad-hoc visit (no `visit` at all) defaults to today, and correcting an
// already-completed visit's date (opened via VisitDetailModal's Edit) is just
// as valid a correction as its notes/outcome/contact already are.
//
// `visit` is passed when editing an existing visit (has visit_id); when
// opened from a place with no visit yet, `placeId` is provided instead to
// create a brand-new ad-hoc visit (from PlaceDetail.jsx). `initialPerson`
// (id/name/title/email/phone) is an optional convenience default for the
// person picker — used when opened from PersonDetail.jsx, which already knows
// who the visit is with; it's still just a starting selection, not locked,
// unlike the personRecordGone case below.
// On narrow screens this renders as a bottom slide-up sheet instead of a
// centered modal — see the @media rule for .modal-backdrop in styles.css.
//
// WHAT THIS CAPTURES AND WHY (see server/src/services/relationship.js):
// "Who did you meet" and "what happened" are both REQUIRED here, because they
// are the two axes the computed relationship score multiplies together. The
// model is only ever as good as this form — a visit logged without them is a
// visit that can't tell the difference between a real sit-down and dropping a
// brochure at a front desk. They're asked as explicit questions rather than
// inferred (e.g. from whether a person happened to be picked) precisely so a
// blank answer isn't quietly treated as a real one.
//
// A place that still reads capacity_status 'estimated' also gets the optional
// "avg. referrals/month discovered at pre-qual" field — not a real visits
// column, it writes through server-side to places.capacity_monthly_referrals +
// capacity_status: 'verified' (routes/visits.js's maybeCapturePreQualification).
// This used to appear only on a place's FIRST completed visit, which meant
// missing it once left that place stuck on an estimated capacity forever.
export default function VisitLogModal({ visit, placeId, placeName, initialPerson, userId, onClose, onSaved }) {
  // Whichever way this modal was opened, we need to know which place it's for.
  const resolvedPlaceId = visit?.place_id || placeId;
  // The person originally linked to this visit was since deleted (person_id
  // nulled out via ON DELETE SET NULL, but the person_name snapshot
  // survives). Reassigning the picker in that state would silently
  // reattribute this visit's history to someone else, so instead the picker
  // is locked and only the rest stays editable.
  const personRecordGone = Boolean(visit && !visit.person_id && visit.person_name);

  const [form, setForm] = useState({
    scheduled_date: visit?.scheduled_date || today(),
    visit_type: visit?.visit_type || 'drop_in',
    // Default to "a specific person" for a fresh visit: it's both the most
    // common case and the only one that builds an individual relationship, so
    // the rep has to actively downgrade it rather than accidentally leave the
    // richest signal uncaptured.
    met_with_type: visit?.met_with_type || (personRecordGone ? 'named_person' : 'named_person'),
    outcome: visit?.outcome || '',
    they_requested: Boolean(visit?.they_requested),
    // An already-recorded duration always wins; otherwise start from the
    // visit type's planned minutes so the rep is correcting a sensible number
    // rather than typing into a blank. (Existing visits predating this field
    // have no duration, so they get the suggestion too.)
    actual_duration_minutes: visit?.actual_duration_minutes ?? VISIT_TYPE_MINUTES[visit?.visit_type || 'drop_in'] ?? '',
    notes: visit?.notes || '',
    person_id: visit?.person_id || initialPerson?.id || '',
    person_name: visit?.person_name || initialPerson?.name || '',
    person_title: visit?.person_title || initialPerson?.title || '',
    person_email: visit?.person_email || initialPerson?.email || '',
    person_phone: visit?.person_phone || initialPerson?.phone || '',
    next_visit_date: visit?.next_visit_date || '',
  });
  const [people, setPeople] = useState([]); // this place's people, for the person picker
  const [creatingPerson, setCreatingPerson] = useState(false); // "+ Create new person…" modal open?
  const [assigningPerson, setAssigningPerson] = useState(false); // "+ Assign someone already on file…" modal open?
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
  // Fetched to know whether this place still needs pre-qualifying (see the
  // module comment). Not part of `form`: it's a transient side-channel value
  // that writes through to places.capacity_monthly_referrals server-side.
  const [place, setPlace] = useState(null);
  const [avgReferrals, setAvgReferrals] = useState('');

  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));
  const setChecked = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.checked }));
  const title = placeName || visit?.place_name || 'Visit';

  const metAPerson = form.met_with_type === 'named_person';
  // Only a named-person visit needs a person attached; the other three are
  // explicitly "we didn't meet anyone identifiable."
  const personSatisfied = !metAPerson || form.person_id || personRecordGone;
  const canSave = form.notes.trim() && form.outcome && form.met_with_type && personSatisfied;

  // Load this place's people once we know who the place is, so the person
  // picker has real options.
  useEffect(() => {
    if (!resolvedPlaceId) return;
    api.people.listForPlace(resolvedPlaceId).then(setPeople).catch(() => {});
  }, [resolvedPlaceId]);

  // Also load the place itself, to know whether it still needs pre-qualifying.
  useEffect(() => {
    if (!resolvedPlaceId) return;
    api.place(resolvedPlaceId).then(setPlace).catch(() => {});
  }, [resolvedPlaceId]);

  // Keeps appearing until a real number is captured — see the module comment.
  const needsPreQual = Boolean(place && place.capacity_status === 'estimated');

  // Changing the visit type re-suggests that type's planned minutes. Done in
  // the change handler rather than an effect on `visit_type` deliberately:
  // an effect would also fire on mount and clobber an existing visit's
  // already-recorded duration with the type default. This only ever reacts to
  // the rep actually picking a type, which is when a fresh suggestion is what
  // they'd expect.
  function handleVisitTypeChange(e) {
    const visit_type = e.target.value;
    setForm((f) => ({
      ...f,
      visit_type,
      actual_duration_minutes: VISIT_TYPE_MINUTES[visit_type] ?? f.actual_duration_minutes,
    }));
  }

  // Selecting someone links this visit to their person record (person_id) and
  // snapshots their saved info into the person_* fields. The special
  // "+ Create new person…" option instead opens PersonModal.
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
    // Both sentinels leave the current selection alone — the <select> snaps
    // back on re-render while the modal is open.
    if (e.target.value === CREATE_PERSON) { setCreatingPerson(true); return; }
    if (e.target.value === ASSIGN_PERSON) { setAssigningPerson(true); return; }
    pickPerson(e.target.value);
  }

  // Someone already on file was just linked to this place. Refetch the roster
  // so they appear in the picker, and — when exactly one person was assigned —
  // select them, since assigning from inside a visit log almost always means
  // "this is who I met." A multi-assign is left unselected rather than
  // guessing which one the visit was with.
  async function handlePeopleAssigned(assignedIds) {
    try {
      const roster = await api.people.listForPlace(resolvedPlaceId);
      setPeople(roster);
      if (assignedIds && assignedIds.length === 1) {
        const p = roster.find((x) => String(x.id) === String(assignedIds[0]));
        if (p) {
          setForm((f) => ({
            ...f,
            met_with_type: 'named_person',
            person_id: p.id,
            person_name: p.name || '',
            person_title: p.title || '',
            person_email: p.email || '',
            person_phone: p.phone || '',
          }));
        }
      }
    } catch {
      /* the roster refetch is a convenience — a failure here shouldn't break the log */
    }
  }

  // Switching away from "a specific person" clears the attached person, so a
  // half-changed answer can't leave a stale person_id on a visit that's now
  // recorded as a front-desk drop-off.
  function handleMetWithChange(e) {
    const met_with_type = e.target.value;
    setForm((f) => ({
      ...f,
      met_with_type,
      ...(met_with_type === 'named_person'
        ? {}
        : { person_id: '', person_name: '', person_title: '', person_email: '', person_phone: '' }),
    }));
  }

  // The person was just created from inside this modal — add them to the
  // picker's options and select them immediately.
  function handlePersonCreated(person) {
    setPeople((ps) => [...ps, person]);
    setForm((f) => ({
      ...f,
      met_with_type: 'named_person',
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
      const payload = {
        ...form,
        person_id: form.person_id || null,
        status: 'completed',
        // '' -> null rather than 0: "not recorded" and "took no time" are
        // different answers, and the column is nullable for exactly that reason.
        actual_duration_minutes:
          form.actual_duration_minutes === '' ? null : Math.max(0, Math.round(Number(form.actual_duration_minutes))),
      };
      // Rounded client-side before it ever leaves the browser — the server
      // silently drops a non-integer capacity_monthly_referrals (it's a real
      // DB integer column) rather than erroring, so an un-rounded "12.5"
      // would otherwise look saved but quietly never land.
      if (needsPreQual && avgReferrals !== '') payload.capacity_monthly_referrals = Math.max(0, Math.round(Number(avgReferrals)));
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
            <select value={form.visit_type} onChange={handleVisitTypeChange}>
              {Object.entries(VISIT_TYPE_LABELS).map(([key, label]) => (
                <option key={key} value={key}>{label}</option>
              ))}
            </select>
          </div>

          {personRecordGone ? (
            <div>
              <label className="field">Who you met</label>
              <div className="muted" title="This person's record was deleted — reassigning would rewrite this visit's history, so the contact can't be changed.">
                {form.person_name}{form.person_title ? ` — ${form.person_title}` : ''} (no longer on file)
              </div>
            </div>
          ) : (
            <>
              <div>
                <label className="field">Who did you meet?</label>
                <select value={form.met_with_type} onChange={handleMetWithChange}>
                  {Object.entries(MET_WITH_LABELS).map(([key, label]) => (
                    <option key={key} value={key}>{label}</option>
                  ))}
                </select>
              </div>

              {metAPerson && (
                <div>
                  <label className="field">Which person?</label>
                  <select value={form.person_id} onChange={handlePersonSelect}>
                    <option value="">Select who you met with…</option>
                    <option value={CREATE_PERSON}>+ Create new person…</option>
                    <option value={ASSIGN_PERSON}>+ Assign someone already on file…</option>
                    <option disabled>──────────</option>
                    {people.map((p) => (
                      <option key={p.id} value={p.id}>{p.name}{p.title ? ` — ${p.title}` : ''}</option>
                    ))}
                  </select>
                </div>
              )}
            </>
          )}

          <div>
            <label className="field">What happened?</label>
            <select value={form.outcome} onChange={set('outcome')}>
              <option value="">Select what happened…</option>
              {Object.entries(OUTCOME_LABELS).map(([key, label]) => (
                <option key={key} value={key}>{label}</option>
              ))}
            </select>
            {/* Meeting someone new is only worth capturing if adding them is
                frictionless right now, while the rep still has the name. */}
            {form.outcome === 'introduced_new' && !personRecordGone && (
              <div className="tiny muted" style={{ marginTop: 6 }}>
                <button type="button" className="link-button" onClick={() => setCreatingPerson(true)}>
                  + Add them to this place now
                </button>
              </div>
            )}
          </div>

          <div>
            <label className="field">Notes</label>
            <textarea rows={3} value={form.notes} onChange={set('notes')} placeholder="What happened, next steps…" autoFocus />
          </div>

          <div className="row">
            <div>
              <label className="field">How long did it take? (minutes)</label>
              <input
                type="number"
                min="0"
                step="1"
                placeholder="Optional"
                value={form.actual_duration_minutes}
                onChange={set('actual_duration_minutes')}
              />
            </div>
            {needsPreQual && (
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
          </div>

          {/* Them asking US for something is the purest reciprocity signal
              available — it measures their investment, not the rep's. */}
          <label className="check-row" title="Materials, availability, a callback — anything they asked you for">
            <input type="checkbox" checked={form.they_requested} onChange={setChecked('they_requested')} />
            <span>Did they ask you for anything?</span>
          </label>
        </div>
        <div className="modal-foot">
          <Button variant="secondary" title="Close without saving" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button
            variant={collisionWarning ? 'danger' : 'primary'}
            title={
              collisionWarning
                ? 'Log this visit anyway, despite the collision above'
                : canSave
                  ? 'Save this visit'
                  : 'Fill in who you met, what happened, and a note first'
            }
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

      {assigningPerson && (
        <AssignPersonModal
          placeId={resolvedPlaceId}
          placeName={title}
          onClose={() => setAssigningPerson(false)}
          onAssigned={handlePeopleAssigned}
        />
      )}
    </div>
  );
}
