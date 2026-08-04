import React, { useEffect, useState } from 'react';
import { api, today, VISIT_TYPE_MINUTES, OUTCOME_LABELS, MET_WITH_LABELS } from '../api';
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
  // Editing an existing row (or completing a planned route-planner stop) is
  // always about ONE person, because one visit row IS one person met — see
  // routes/visits.js. Only a brand-new ad-hoc visit can record several
  // contacts at once, fanning out to one row each server-side.
  const isEditing = Boolean(visit?.visit_id);
  // The person originally linked to this visit was since deleted (person_id
  // nulled out via ON DELETE SET NULL, but the person_name snapshot
  // survives). Reassigning the picker in that state would silently
  // reattribute this visit's history to someone else, so instead the picker
  // is locked and only the rest stays editable.
  const personRecordGone = Boolean(visit && !visit.person_id && visit.person_name);

  const [form, setForm] = useState({
    scheduled_date: visit?.scheduled_date || today(),
    // visit_type is no longer asked here — it exists purely as the route
    // planner's time ESTIMATE (config/visitTypes.js), so a rep logging what
    // actually happened has nothing useful to say about it. A planned stop
    // keeps whatever the planner assigned (so estimated-vs-actual stays
    // comparable); a fresh ad-hoc visit simply has none, rather than a
    // fabricated "drop-in" that would pollute that comparison.
    visit_type: visit?.visit_type || null,
    // Default to "a specific person" for a fresh visit: it's both the most
    // common case and the only one that builds an individual relationship, so
    // the rep has to actively downgrade it rather than accidentally leave the
    // richest signal uncaptured.
    met_with_type: visit?.met_with_type || 'named_person',
    outcome: visit?.outcome || '',
    they_requested: Boolean(visit?.they_requested),
    // An already-recorded duration always wins; otherwise suggest the planned
    // minutes for the type the ROUTE PLANNER assigned, when there is one. An
    // ad-hoc visit has no planned type and so starts blank — the field is
    // optional, and a made-up default would be worse than an honest gap.
    actual_duration_minutes: visit?.actual_duration_minutes ?? VISIT_TYPE_MINUTES[visit?.visit_type] ?? '',
    notes: visit?.notes || '',
    person_id: visit?.person_id || initialPerson?.id || '',
    person_name: visit?.person_name || initialPerson?.name || '',
    person_title: visit?.person_title || initialPerson?.title || '',
    person_email: visit?.person_email || initialPerson?.email || '',
    person_phone: visit?.person_phone || initialPerson?.phone || '',
    next_visit_date: visit?.next_visit_date || '',
  });
  // --- New-visit ("trip") state ------------------------------------------
  // A trip is a LIST OF ENCOUNTERS, each becoming its own visit row (see
  // routes/visits.js). Which kinds of people were met, which specific named
  // people, and then per-encounter what happened / did they ask for anything.
  //
  // Only used when creating; editing works on one existing row and keeps the
  // original single-encounter fields in `form` above.
  const [metTypes, setMetTypes] = useState(
    visit?.met_with_type ? [visit.met_with_type] : ['named_person']
  );
  const [selectedPersonIds, setSelectedPersonIds] = useState(
    visit?.person_id ? [visit.person_id] : initialPerson?.id ? [initialPerson.id] : []
  );
  // encounter key -> { outcome, they_requested }. Keyed rather than indexed so
  // ticking/unticking someone else never shuffles answers already given.
  const [details, setDetails] = useState({});
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

  // The encounters this trip will write, derived from the two pickers above.
  // One per named person, plus one per non-named category — so "a specific
  // person + the receptionist" is two encounters, each answered separately.
  const encounters = isEditing
    ? []
    : [
        ...(metTypes.includes('named_person')
          ? selectedPersonIds.map((id) => {
              const p = people.find((x) => x.id === id);
              return { key: `person:${id}`, met_with_type: 'named_person', person_id: id, label: p ? p.name : 'Selected person' };
            })
          : []),
        ...metTypes
          .filter((t) => t !== 'named_person')
          .map((t) => ({ key: `type:${t}`, met_with_type: t, person_id: null, label: MET_WITH_LABELS[t] })),
      ];

  // "Nobody" is the one answer that can't coexist with anything else, and it's
  // also the only one where "did they ask you for something" is meaningless.
  const metNobody = metTypes.includes('nobody');

  const detailFor = (key) => details[key] || { outcome: '', they_requested: false };

  // Only a named-person visit needs a person attached; the other three are
  // explicitly "we didn't meet anyone identifiable."
  const personSatisfied = isEditing
    ? !metAPerson || selectedPersonIds.length > 0 || personRecordGone
    : encounters.length > 0;
  // Every encounter has to say what happened — an unanswered one would be
  // scored at the model's unknown-outcome floor, silently under-crediting it.
  const outcomesSatisfied = isEditing
    ? Boolean(form.outcome)
    : encounters.every((e) => detailFor(e.key).outcome);
  const canSave = form.notes.trim() && outcomesSatisfied && personSatisfied;

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

  // Ticking a kind of person met. "Nobody" is mutually exclusive with
  // everything else — "I met nobody AND the receptionist" is a contradiction —
  // so choosing it clears the rest, and choosing anything else clears it.
  function toggleMetType(type) {
    setMetTypes((types) => {
      if (type === 'nobody') return types.includes('nobody') ? [] : ['nobody'];
      const withoutNobody = types.filter((t) => t !== 'nobody');
      return withoutNobody.includes(type)
        ? withoutNobody.filter((t) => t !== type)
        : [...withoutNobody, type];
    });
  }

  // Per-encounter answers ("what happened" / "did they ask for anything").
  function setDetail(key, patch) {
    setDetails((d) => ({ ...d, [key]: { ...(d[key] || { outcome: '', they_requested: false }), ...patch } }));
  }

  // Selecting someone links this visit to their person record (person_id) and
  // snapshots their saved info into the person_* fields. Used by the
  // single-select edit path; the multi-select create path keeps only
  // selectedPersonIds and lets the server snapshot each person itself.
  function pickPerson(id) {
    const p = people.find((x) => String(x.id) === String(id));
    setSelectedPersonIds(id ? [Number(id)] : []);
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

  // Multi-select (new visits only): tick/untick one of the place's people.
  function togglePerson(id) {
    const numericId = Number(id);
    setSelectedPersonIds((ids) =>
      ids.includes(numericId) ? ids.filter((x) => x !== numericId) : [...ids, numericId]
    );
  }

  // Someone already on file was just linked to this place. Refetch the roster
  // so they appear in the picker, then select who was assigned — assigning
  // from inside a visit log almost always means "this is who I met." When
  // logging a new visit that now holds for a multi-assign too (every one of
  // them gets ticked); the edit path can still only hold one, so it keeps the
  // original "exactly one, or don't guess" rule.
  async function handlePeopleAssigned(assignedIds) {
    try {
      const roster = await api.people.listForPlace(resolvedPlaceId);
      setPeople(roster);
      if (!assignedIds || !assignedIds.length) return;

      if (isEditing) {
        if (assignedIds.length !== 1) return; // can't guess which one this single row is about
        const p = roster.find((x) => String(x.id) === String(assignedIds[0]));
        if (!p) return;
        setSelectedPersonIds([p.id]);
        setForm((f) => ({
          ...f,
          met_with_type: 'named_person',
          person_id: p.id,
          person_name: p.name || '',
          person_title: p.title || '',
          person_email: p.email || '',
          person_phone: p.phone || '',
        }));
        return;
      }

      const ids = assignedIds.map(Number).filter((id) => roster.some((x) => x.id === id));
      // Assigning someone implies you met them, so make sure the "a specific
      // person" category is ticked — otherwise they'd be selected but produce
      // no encounter.
      setMetTypes((types) => [...new Set([...types.filter((t) => t !== 'nobody'), 'named_person'])]);
      setSelectedPersonIds((prev) => [...new Set([...prev, ...ids])]);
    } catch {
      /* the roster refetch is a convenience — a failure here shouldn't break the log */
    }
  }

  // Switching away from "a specific person" clears the attached person(s), so
  // a half-changed answer can't leave a stale person_id on a visit that's now
  // recorded as a front-desk drop-off.
  function handleMetWithChange(e) {
    const met_with_type = e.target.value;
    if (met_with_type !== 'named_person') setSelectedPersonIds([]);
    setForm((f) => ({
      ...f,
      met_with_type,
      ...(met_with_type === 'named_person'
        ? {}
        : { person_id: '', person_name: '', person_title: '', person_email: '', person_phone: '' }),
    }));
  }

  // The person was just created from inside this modal — add them to the
  // picker's options and select them immediately. On a new visit that's an
  // ADDITION to whoever's already ticked (creating someone mid-log usually
  // means "…and I also met this new person"); editing replaces, since one row
  // only ever describes one person.
  function handlePersonCreated(person) {
    setPeople((ps) => [...ps, person]);
    setSelectedPersonIds((ids) => (isEditing ? [person.id] : [...new Set([...ids, person.id])]));
    if (!isEditing) {
      setMetTypes((types) => [...new Set([...types.filter((t) => t !== 'nobody'), 'named_person'])]);
    }
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
      // Every encounter on this trip. Only sent when creating — a PATCH edits
      // one existing row, which IS one encounter. The server fans these out to
      // one visit row each (sharing the trip-level fields above) and snapshots
      // each named person's own contact details, so the single person_* fields
      // don't have to describe them all.
      if (!isEditing) {
        payload.encounters = encounters.map((e) => ({
          met_with_type: e.met_with_type,
          person_id: e.person_id,
          outcome: detailFor(e.key).outcome,
          // Nobody can't have asked you for anything.
          they_requested: e.met_with_type === 'nobody' ? false : Boolean(detailFor(e.key).they_requested),
        }));
      }
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
          <h2>Log Visit — {title}</h2>
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

          {personRecordGone ? (
            <div>
              <label className="field">Who you met</label>
              <div className="muted" title="This person's record was deleted — reassigning would rewrite this visit's history, so the contact can't be changed.">
                {form.person_name}{form.person_title ? ` — ${form.person_title}` : ''} (no longer on file)
              </div>
            </div>
          ) : isEditing ? (
            /* Editing one existing row: one encounter, so the original single
               pickers are exactly right — re-pointing this row is the only
               sensible edit. Splitting one row into several isn't an edit,
               it's a new trip. */
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
          ) : (
            /* Logging a new visit: a trip can contain several encounters —
               a named contact AND the front desk, say. Each becomes its own
               visit row, so each person builds their own relationship score
               and the front-desk interaction scores separately against the
               place, while fatigue still counts the trip once. */
            <>
              <div>
                <label className="field">Who did you meet?</label>
                <div className="person-checklist">
                  {Object.entries(MET_WITH_LABELS).map(([key, label]) => (
                    <label key={key} className="check-row">
                      <input type="checkbox" checked={metTypes.includes(key)} onChange={() => toggleMetType(key)} />
                      <span>{label}</span>
                    </label>
                  ))}
                </div>
              </div>

              {metTypes.includes('named_person') && (
                <div>
                  <label className="field">
                    Which people?
                    {selectedPersonIds.length > 1 && (
                      <span className="muted" style={{ fontWeight: 400 }}> · {selectedPersonIds.length} selected</span>
                    )}
                  </label>
                  {people.length === 0 ? (
                    <div className="tiny muted">Nobody on file at this place yet — add someone below.</div>
                  ) : (
                    <div className="person-checklist">
                      {people.map((p) => (
                        <label key={p.id} className="check-row">
                          <input
                            type="checkbox"
                            checked={selectedPersonIds.includes(p.id)}
                            onChange={() => togglePerson(p.id)}
                          />
                          <span>{p.name}{p.title ? <span className="muted"> — {p.title}</span> : null}</span>
                        </label>
                      ))}
                    </div>
                  )}
                  <div className="tag-list" style={{ marginTop: 8 }}>
                    <Button variant="secondary" size="small" title="Create someone who isn't on file yet" onClick={() => setCreatingPerson(true)}>
                      + Create new person
                    </Button>
                    <Button variant="secondary" size="small" title="Link someone already on file to this place" onClick={() => setAssigningPerson(true)}>
                      + Assign someone on file
                    </Button>
                  </div>
                </div>
              )}
            </>
          )}

          {isEditing ? (
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
          ) : (
            /* One block per encounter. Answered separately because the model
               scores them separately: "substantive with Sharon" and "gatekept
               by the front desk" on the same trip are different facts, and
               collapsing them to one answer throws away whichever is less
               convenient. */
            <div>
              <label className="field">What happened?</label>
              {encounters.length === 0 ? (
                <div className="tiny muted">Pick who you met first.</div>
              ) : (
                <div className="stack" style={{ gap: 10 }}>
                  {encounters.map((e) => (
                    <div key={e.key} className="encounter-row">
                      <div className="encounter-name">{e.label}</div>
                      <select
                        value={detailFor(e.key).outcome}
                        onChange={(ev) => setDetail(e.key, { outcome: ev.target.value })}
                      >
                        <option value="">Select what happened…</option>
                        {Object.entries(OUTCOME_LABELS).map(([key, label]) => (
                          <option key={key} value={key}>{label}</option>
                        ))}
                      </select>
                      {/* Nobody can't have asked you for anything. */}
                      {e.met_with_type !== 'nobody' && (
                        <label className="check-row" title="Materials, availability, a callback — anything they asked you for">
                          <input
                            type="checkbox"
                            checked={Boolean(detailFor(e.key).they_requested)}
                            onChange={(ev) => setDetail(e.key, { they_requested: ev.target.checked })}
                          />
                          <span>They asked me for something</span>
                        </label>
                      )}
                      {detailFor(e.key).outcome === 'introduced_new' && (
                        <div className="tiny muted">
                          <button type="button" className="link-button" onClick={() => setCreatingPerson(true)}>
                            + Add them to this place now
                          </button>
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

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
              available — it measures their investment, not the rep's. When
              logging a new trip this is asked per encounter above, since it's
              a fact about one person, not the whole visit. */}
          {isEditing && form.met_with_type !== 'nobody' && (
            <label className="check-row" title="Materials, availability, a callback — anything they asked you for">
              <input type="checkbox" checked={form.they_requested} onChange={setChecked('they_requested')} />
              <span>Did they ask you for anything?</span>
            </label>
          )}
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
